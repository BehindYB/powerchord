import { join } from 'node:path';
import {
  buildChildEnv,
  createLocalModelGateway,
  detectAgent,
  getAgent,
  HubStore,
  MCP_SERVER_NAME,
  resolveSearchPath,
  runCommand,
  TASK_STATUSES,
  type McpClientRegistration,
  type McpServerStartResult,
  type PowerChordMcpServer,
  type TaskStatus,
  type ProjectMemoryGateway,
} from '@powerchord/core';
import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import {
  IpcChannel,
  type HubConnection,
  type HubRegistrationOutcome,
  type HubRegistrationTarget,
  type HubState,
} from '../shared/ipc';
import { endpointConnection, findEndpoint } from './models';
import {
  getHubSettings,
  getModelEndpoints,
  regenerateHubToken,
  setHubDefaultModel,
  type HubSettings,
} from './settings';

/** Name under which the hub is registered in agents the user runs outside PowerChord. */
const EXTERNAL_SERVER_NAME = `${MCP_SERVER_NAME}-hub`;
const EXTERNAL_CLIENT_LABEL = 'External agent';

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  return value;
}

/** The shared context hub: task and note storage, local model access and agent registration. */
export class HubManager {
  readonly store = new HubStore(join(app.getPath('userData'), 'hub.json'));
  private readonly mcp: PowerChordMcpServer;
  private settings: HubSettings | null = null;
  private connection: HubConnection | null = null;
  private externalClient: McpClientRegistration | null = null;

  private readonly memory: ProjectMemoryGateway;

  constructor(mcp: PowerChordMcpServer, memory: ProjectMemoryGateway) {
    this.mcp = mcp;
    this.memory = memory;
  }

  /** Starts the MCP server on the preferred port and enables the hub tools. */
  async start(): Promise<void> {
    const settings = await getHubSettings();
    this.settings = settings;
    const result: McpServerStartResult = await this.mcp.start({ preferredPort: settings.port });
    this.connection = {
      url: this.mcp.url,
      port: result.port,
      usedPreferredPort: result.usedPreferredPort,
      preferredPort: settings.port,
    };

    this.mcp.setHub({
      store: this.store,
      memory: this.memory,
      models: createLocalModelGateway({
        endpoints: async () =>
          Promise.all(
            (await getModelEndpoints()).map(async (endpoint) => ({
              name: endpoint.name,
              ...(await endpointConnection(endpoint)),
            })),
          ),
        defaultModel: async () => {
          const preferred = this.settings?.defaultModel;
          const endpoint = preferred ? await findEndpoint(preferred.endpointId) : undefined;
          return preferred && endpoint
            ? { baseUrl: endpoint.baseUrl, model: preferred.model }
            : null;
        },
      }),
    });
    // Agents the user registered the hub in authenticate with the persistent token.
    this.externalClient = this.mcp.register(
      { label: EXTERNAL_CLIENT_LABEL, hub: true },
      settings.token,
    );
    this.store.onChange((snapshot) => broadcast(IpcChannel.HubChanged, snapshot));
    this.registerHandlers();
  }

  /** Issues a new token for external agents and revokes the old one. */
  async regenerateToken(): Promise<void> {
    this.requireReady();
    const hub = await regenerateHubToken();
    this.externalClient?.dispose();
    this.externalClient = this.mcp.register({ label: EXTERNAL_CLIENT_LABEL, hub: true }, hub.token);
    this.settings = hub;
  }

  private requireReady(): { settings: HubSettings; connection: HubConnection } {
    if (!this.settings || !this.connection) throw new Error('The hub is not running');
    return { settings: this.settings, connection: this.connection };
  }

  private async state(): Promise<HubState> {
    const { settings, connection } = this.requireReady();
    const snapshot = await this.store.snapshot();
    return { ...snapshot, connection, defaultModel: settings.defaultModel };
  }

  private registrationCommand(target: HubRegistrationTarget): { args: string[]; display: string } {
    const { settings, connection } = this.requireReady();
    const header = `Authorization: Bearer ${settings.token}`;
    const masked = 'Authorization: Bearer ••••••••';
    // Antigravity requires flags before the name; Claude Code's --header takes several values,
    // so it goes last.
    const parts =
      target === 'antigravity-cli'
        ? ['mcp', 'add', '--header', header, EXTERNAL_SERVER_NAME, connection.url]
        : [
            'mcp',
            'add',
            '--transport',
            'http',
            '--scope',
            'user',
            EXTERNAL_SERVER_NAME,
            connection.url,
            '--header',
            header,
          ];
    const name = target === 'antigravity-cli' ? 'agy' : 'claude';
    const display = [name, ...parts.map((part) => (part === header ? `"${masked}"` : part))].join(
      ' ',
    );
    return { args: parts, display };
  }

  private async register(
    window: BrowserWindow | null,
    target: HubRegistrationTarget,
  ): Promise<HubRegistrationOutcome> {
    const agent = getAgent(target);
    const searchPath = await resolveSearchPath();
    const status = await detectAgent(agent, { searchPath });
    if (!status.path)
      return { status: 'failed', message: `${agent.displayName} is not installed.` };

    const command = this.registrationCommand(target);
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Add', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: `Add PowerChord to ${agent.displayName}`,
      message: `Add the PowerChord hub to ${agent.displayName}?`,
      detail:
        `PowerChord will run ${agent.displayName}'s own command:\n\n${command.display}\n\n` +
        "The hub token is stored in that agent's configuration. Tool calls follow the " +
        "agent's own approval settings, and the hub works while PowerChord is running.",
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return { status: 'cancelled' };

    const result = await runCommand(
      { command: status.path, args: command.args },
      { env: buildChildEnv(searchPath), timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 500);
      return { status: 'failed', message: detail || `Exited with code ${result.exitCode}` };
    }
    return { status: 'registered' };
  }

  private copyConfig(): void {
    const { settings, connection } = this.requireReady();
    const config = {
      mcpServers: {
        [EXTERNAL_SERVER_NAME]: {
          type: 'http',
          url: connection.url,
          headers: { Authorization: `Bearer ${settings.token}` },
        },
      },
    };
    clipboard.writeText(JSON.stringify(config, null, 2));
  }

  private registerHandlers(): void {
    const author = 'You';
    ipcMain.handle(IpcChannel.GetHub, () => this.state());
    ipcMain.handle(
      IpcChannel.AddHubTask,
      async (_event, task: { title?: unknown; description?: unknown }) => {
        const title = optionalString(task.title, 'title') ?? '';
        const description = optionalString(task.description, 'description') ?? '';
        await this.store.addTask({ title, description }, author);
      },
    );
    ipcMain.handle(
      IpcChannel.UpdateHubTask,
      async (_event, id: unknown, changes: Record<string, unknown>) => {
        if (typeof id !== 'string') throw new Error('Invalid task');
        if (changes['status'] !== undefined && !isTaskStatus(changes['status'])) {
          throw new Error('Invalid status');
        }
        const title = optionalString(changes['title'], 'title');
        const description = optionalString(changes['description'], 'description');
        const summary =
          changes['summary'] === null ? null : optionalString(changes['summary'], 'summary');
        await this.store.updateTask(
          id,
          {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(changes['status'] !== undefined ? { status: changes['status'] as TaskStatus } : {}),
            ...(summary !== undefined ? { summary } : {}),
          },
          author,
        );
      },
    );
    ipcMain.handle(IpcChannel.DeleteHubTask, async (_event, id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid task');
      await this.store.deleteTask(id);
    });
    ipcMain.handle(
      IpcChannel.SaveHubNote,
      async (_event, note: { id?: unknown; title?: unknown; content?: unknown }) => {
        const id = optionalString(note.id, 'note');
        await this.store.saveNote(
          {
            ...(id !== undefined ? { id } : {}),
            title: optionalString(note.title, 'title') ?? '',
            content: optionalString(note.content, 'content') ?? '',
          },
          author,
        );
      },
    );
    ipcMain.handle(IpcChannel.DeleteHubNote, async (_event, id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid note');
      await this.store.deleteNote(id);
    });
    ipcMain.handle(IpcChannel.SetHubDefaultModel, async (_event, model: unknown) => {
      let value: HubSettings['defaultModel'] = null;
      if (model !== null) {
        const entry = model as { endpointId?: unknown; model?: unknown };
        if (typeof entry.endpointId !== 'string' || typeof entry.model !== 'string') {
          throw new Error('Invalid model');
        }
        value = { endpointId: entry.endpointId, model: entry.model };
      }
      await setHubDefaultModel(value);
      if (this.settings) this.settings = { ...this.settings, defaultModel: value };
    });
    ipcMain.handle(IpcChannel.RegisterHub, (event, target: unknown) => {
      if (target !== 'antigravity-cli' && target !== 'claude-code')
        throw new Error('Invalid agent');
      return this.register(BrowserWindow.fromWebContents(event.sender), target);
    });
    ipcMain.handle(IpcChannel.CopyHubConfig, () => this.copyConfig());
  }
}
