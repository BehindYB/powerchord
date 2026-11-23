import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AcpSession,
  applySessionEvent,
  approximateTokens,
  buildChildEnv,
  chatHistoryFromTranscript,
  ClaudeCodeSession,
  CodexSession,
  createSessionState,
  detectAgent,
  estimateCost,
  fetchAnthropicContextWindow,
  fetchGeminiContextWindow,
  fetchServerContextWindow,
  findPrice,
  getAgent,
  isCodexMode,
  isModelChatMode,
  FileCheckpointStore,
  ModelChatSession,
  openInTerminal,
  resolveSearchPath,
  settleSessionState,
  type AgentId,
  type AgentSession,
  type PowerChordMcpServer,
  type PermissionMode,
  type QuestionAnswers,
  type SessionEvent,
  type SessionState,
} from '@powerchord/core';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import {
  IpcChannel,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  type ApiProviderId,
  type CodingAgentId,
  type CreateSessionRequest,
  type ModelChatFolder,
  type OpenTarget,
  type ProjectMenuResult,
  type ProjectSummary,
  type SessionEventMessage,
  type SessionMenuResult,
  type SessionSnapshot,
  type SessionSummary,
} from '../shared/ipc';
import { getApiKey } from './api-keys';
import { DelegationService } from './delegation';
import { PROVIDER_APIS, providerConnection, providerName } from './api-models';
import { endpointConnection, findEndpoint } from './models';
import type { ProjectMemoryService } from './memory';
import type { ProjectStore } from './projects';
import { SessionStore } from './session-store';
import { getBudgets, isFolderTrusted, trustFolder } from './settings';
import { monthSpend, recordUsage } from './usage';

const TITLE_LENGTH = 60;
/** Length of the session name recorded as the author of hub changes. */
const LABEL_LENGTH = 32;

type SessionAgent = AgentSession;

interface ManagedSession {
  summary: SessionSummary;
  state: SessionState;
  seq: number;
  /** Created on first use, so restored sessions start no processes until the user continues them. */
  agent: SessionAgent | null;
  /** Pending agent creation, shared by concurrent callers. */
  starting: Promise<SessionAgent> | null;
  /** Increased when the agent is replaced, so events from a closed agent are ignored. */
  generation: number;
}

/** Agents whose conversation PowerChord can rewind. */
function canRewind(agentId: SessionSummary['agentId']): boolean {
  return agentId === 'claude-code' || agentId === 'local-model' || agentId === 'api-model';
}

type UserItem = Extract<SessionState['items'][number], { kind: 'user' }>;

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode.id === value);
}

/** Aliases such as `opus` or versions such as `claude-opus-4-8`; Claude Code validates the rest. */
function isClaudeModel(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[\w.[\]-]{1,128}$/.test(value));
}

function isModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isOptionalModelName(value: unknown): value is string | null {
  return value === null || isModelName(value);
}

/** Modes are validated by the agents; Gemini CLI reports its own. */
function isModeName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value);
}

function isApiProvider(value: unknown): value is ApiProviderId {
  return value === 'gemini' || value === 'openai' || value === 'anthropic';
}

/** Output assumed for a reply when estimating a message's cost before it is sent. */
const ESTIMATED_OUTPUT_TOKENS = 1000;
/** Claude Code adds its system prompt and tool definitions to every request. */
const AGENT_CONTEXT_TOKENS = 20_000;
/** Instructions and tool definitions of a model chat with a project folder. */
const MODEL_TOOLS_CONTEXT_TOKENS = 2_500;

function formatUsd(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function isCodingAgent(agentId: string): agentId is CodingAgentId {
  return agentId === 'claude-code' || agentId === 'codex' || agentId === 'gemini-cli';
}

function activeAgent(session: ManagedSession): AgentSession {
  if (!session.agent) throw new Error('This session is not running.');
  return session.agent;
}

function agentLabel(summary: SessionSummary): string {
  const name = SESSION_AGENT_NAMES[summary.agentId];
  return summary.title === 'New session'
    ? name
    : `${name}: ${makeTitle(summary.title, LABEL_LENGTH)}`;
}

function isAnswers(value: unknown): value is QuestionAnswers {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((answer) => typeof answer === 'string')
  );
}

function transcriptText(state: SessionState): string {
  return state.items
    .map((item) => (item.kind === 'user' || item.kind === 'text' ? item.text : ''))
    .join('\n');
}

function makeTitle(text: string, length = TITLE_LENGTH): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly mcp: PowerChordMcpServer;
  private readonly store = new SessionStore();
  private readonly projects: ProjectStore;
  private readonly memory: ProjectMemoryService;

  /** The MCP server must be started before sessions are created. */
  /** Starts sub-chats for agents that delegate work; given to the hub and to model chats. */
  readonly delegation = new DelegationService({
    get: (sessionId) => {
      const session = this.sessions.get(sessionId);
      return session ? { summary: session.summary, state: session.state } : null;
    },
    createChild: (request, parentSessionId) => this.create(request, parentSessionId),
    sendMessage: (sessionId, text) =>
      this.send(
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
        this.require(sessionId),
        text,
      ),
  });

  constructor(mcp: PowerChordMcpServer, projects: ProjectStore, memory: ProjectMemoryService) {
    this.mcp = mcp;
    this.projects = projects;
    this.memory = memory;
  }

  async start(): Promise<void> {
    await this.projects.load();
    const stored = await this.store.loadAll();
    // Oldest first, so projects created for earlier sessions keep their creation order.
    stored.sort((a, b) => a.summary.createdAt - b.summary.createdAt);
    for (const { summary, state } of stored) {
      const session: ManagedSession = {
        // Sessions saved by earlier versions have no provider or project.
        summary: {
          ...summary,
          provider: summary.provider ?? null,
          projectId: summary.projectId ?? null,
          archived: summary.archived ?? false,
          parentSessionId: summary.parentSessionId ?? null,
          status: 'idle',
        },
        state: settleSessionState(state),
        seq: 0,
        agent: null,
        starting: null,
        generation: 0,
      };
      this.sessions.set(summary.id, session);
      const { cwd, projectId } = session.summary;
      if (cwd !== null && (projectId === null || !this.projects.get(projectId))) {
        // Sessions from before projects existed are grouped by their folder.
        const project = await this.projects.ensure(cwd, session.summary.createdAt);
        session.summary = { ...session.summary, projectId: project.id };
        this.persist(session);
      }
    }
    this.registerHandlers();
  }

  private notifyProjectsChanged(): void {
    broadcast(IpcChannel.ProjectsChanged, this.projects.list());
  }

  private async createProject(window: BrowserWindow | null): Promise<ProjectSummary | null> {
    const folder = await this.chooseWorkingDirectory(window);
    if (folder === null) return null;
    const project = await this.projects.ensure(folder);
    this.notifyProjectsChanged();
    return project;
  }

  private async removeProject(window: BrowserWindow | null, projectId: unknown): Promise<boolean> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project');
    const chats = [...this.sessions.values()].filter(
      (session) => session.summary.projectId === project.id,
    );
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Remove project',
      message: `Remove "${project.name}" from PowerChord?`,
      detail:
        (chats.length > 0
          ? `Its ${chats.length === 1 ? 'chat is' : `${chats.length} chats are`} removed from PowerChord's history. `
          : '') +
        `Its private memory is deleted. The folder ${project.folder} and its files, including AGENTS.md, are not touched. Coding agents keep their own records of their conversations.`,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return false;
    for (const session of chats) {
      session.agent?.close();
      this.sessions.delete(session.summary.id);
      await this.store.delete(session.summary.id);
      await this.checkpoints(session.summary.id).clear();
    }
    await this.projects.remove(project.id);
    await this.memory.store.remove(project.id);
    this.notifyProjectsChanged();
    this.notifySessionsChanged();
    return true;
  }

  private registerProjectHandlers(): void {
    ipcMain.handle(IpcChannel.ListProjects, () => this.projects.list());
    ipcMain.handle(IpcChannel.CreateProject, (event) =>
      this.createProject(BrowserWindow.fromWebContents(event.sender)),
    );
    ipcMain.handle(IpcChannel.RenameProject, async (_event, projectId: unknown, name: unknown) => {
      if (typeof projectId !== 'string' || typeof name !== 'string') {
        throw new Error('Invalid project');
      }
      await this.projects.rename(projectId, name);
      this.notifyProjectsChanged();
    });
    ipcMain.handle(IpcChannel.RemoveProject, (event, projectId: unknown) =>
      this.removeProject(BrowserWindow.fromWebContents(event.sender), projectId),
    );
    ipcMain.handle(IpcChannel.OpenProjectFolder, async (_event, projectId: unknown) => {
      const project = this.projects.get(projectId);
      if (!project) throw new Error('Unknown project');
      const error = await shell.openPath(project.folder);
      if (error) throw new Error(error);
    });
    ipcMain.handle(IpcChannel.ShowProjectMenu, (event, projectId: unknown) =>
      this.showProjectMenu(BrowserWindow.fromWebContents(event.sender), projectId),
    );
  }

  private async showProjectMenu(
    window: BrowserWindow | null,
    projectId: unknown,
  ): Promise<ProjectMenuResult> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project');
    const choice = await popupMenu<'new-chat' | 'open-folder' | 'remove'>(window, [
      { id: 'new-chat', label: 'New chat' },
      { id: 'open-folder', label: 'Open folder' },
      null,
      { id: 'remove', label: 'Remove project…' },
    ]);
    if (choice === 'new-chat') return 'new-chat';
    if (choice === 'open-folder') {
      const error = await shell.openPath(project.folder);
      if (error) throw new Error(error);
    }
    if (choice === 'remove' && (await this.removeProject(window, project.id))) return 'removed';
    return null;
  }

  private async showSessionMenu(
    window: BrowserWindow | null,
    session: ManagedSession,
    options: unknown,
  ): Promise<SessionMenuResult> {
    const canSplit =
      typeof options === 'object' &&
      options !== null &&
      (options as { canSplit?: unknown }).canSplit === true;
    const { archived } = session.summary;
    const choice = await popupMenu<'split' | 'archive' | 'delete'>(window, [
      ...(canSplit ? [{ id: 'split' as const, label: 'Open side by side' }, null] : []),
      { id: 'archive', label: archived ? 'Unarchive' : 'Archive' },
      { id: 'delete', label: 'Delete…' },
    ]);
    if (choice === 'split') return 'open-side-by-side';
    if (choice === 'archive') this.setArchived(session, !archived);
    if (choice === 'delete' && (await this.delete(window, session))) return 'deleted';
    return null;
  }

  private setArchived(session: ManagedSession, archived: boolean): void {
    if (session.summary.archived === archived) return;
    session.summary = { ...session.summary, archived };
    this.persist(session);
    this.notifySessionsChanged();
  }

  /** Stops every agent process and writes pending session history. */
  async stop(): Promise<void> {
    for (const session of this.sessions.values()) session.agent?.close();
    await this.store.flush();
  }

  private list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => session.summary)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  private notifySessionsChanged(): void {
    broadcast(IpcChannel.SessionsChanged, this.list());
  }

  private persist(session: ManagedSession): void {
    // Sessions are kept once they have a conversation.
    if (session.state.items.length === 0) return;
    const { id } = session.summary;
    this.store.save(id, () => ({ summary: session.summary, state: session.state }));
  }

  private require(sessionId: unknown): ManagedSession {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (!session) throw new Error('Unknown session');
    return session;
  }

  private async chooseWorkingDirectory(window: BrowserWindow | null): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a working folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const [folder] = result.filePaths;
    if (result.canceled || !folder) return null;
    if (await isFolderTrusted(folder)) return folder;

    // Claude Code in print mode skips its own workspace trust prompt, so PowerChord asks instead.
    const confirmation: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Trust folder', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Trust this folder?',
      message: `Do you trust the files in ${folder}?`,
      detail:
        'Agents started in this folder load its configuration without further prompts, ' +
        'including hooks and MCP servers (for example .claude/settings.json and .mcp.json), ' +
        'which can run commands on your computer. Only trust folders whose contents you trust.',
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return null;
    await trustFolder(folder);
    return folder;
  }

  private async checkWorkingFolder(cwd: string): Promise<void> {
    const folder = await stat(cwd).catch(() => null);
    if (!folder?.isDirectory()) throw new Error(`The working folder ${cwd} does not exist.`);
    if (!(await isFolderTrusted(cwd))) throw new Error('The working folder is not trusted.');
  }

  /** Validates the optional project folder of a model chat; the folder must be trusted. */
  private async modelChatFolder(request: ModelChatFolder): Promise<ModelChatFolder> {
    if (request.cwd === null) return { cwd: null, permissionMode: null };
    if (typeof request.cwd !== 'string' || !isModelChatMode(request.permissionMode)) {
      throw new Error('Invalid session settings');
    }
    await this.checkWorkingFolder(request.cwd);
    return { cwd: request.cwd, permissionMode: request.permissionMode };
  }

  private async create(
    request: CreateSessionRequest,
    parentSessionId: string | null = null,
  ): Promise<SessionSummary> {
    const now = Date.now();
    const base = {
      id: randomUUID(),
      projectId: null,
      archived: false,
      parentSessionId,
      title: 'New session',
      status: 'idle' as const,
      createdAt: now,
      lastActiveAt: now,
    };
    let summary: SessionSummary;

    if (isCodingAgent(request.agentId) && 'cwd' in request) {
      const valid =
        request.agentId === 'claude-code'
          ? isClaudeModel(request.model) && isPermissionMode(request.permissionMode)
          : request.agentId === 'codex'
            ? isOptionalModelName(request.model) && isCodexMode(request.permissionMode)
            : isOptionalModelName(request.model) &&
              (request.permissionMode === null || isModeName(request.permissionMode));
      if (!valid || typeof request.cwd !== 'string') throw new Error('Invalid session settings');
      const billing = request.agentId === 'claude-code' ? request.billing : null;
      if (billing !== null && billing !== 'subscription' && billing !== 'api') {
        throw new Error('Invalid billing');
      }
      summary = {
        ...base,
        agentId: request.agentId,
        cwd: request.cwd,
        endpointId: null,
        // Gemini CLI always runs on the user's Gemini API key.
        provider:
          request.agentId === 'gemini-cli' ? 'gemini' : billing === 'api' ? 'anthropic' : null,
        model: request.model,
        permissionMode: request.permissionMode,
      };
    } else if (request.agentId === 'local-model') {
      if (!isModelName(request.model)) throw new Error('Choose a model');
      const endpoint =
        typeof request.endpointId === 'string' ? await findEndpoint(request.endpointId) : undefined;
      if (!endpoint) throw new Error('Unknown model endpoint');
      summary = {
        ...base,
        ...(await this.modelChatFolder(request)),
        agentId: 'local-model',
        endpointId: endpoint.id,
        provider: null,
        model: request.model,
      };
    } else if (request.agentId === 'api-model') {
      if (!isApiProvider(request.provider) || !isModelName(request.model)) {
        throw new Error('Choose a provider and a model');
      }
      summary = {
        ...base,
        ...(await this.modelChatFolder(request)),
        agentId: 'api-model',
        endpointId: null,
        provider: request.provider,
        model: request.model,
      };
    } else {
      throw new Error('Unsupported agent');
    }

    const session: ManagedSession = {
      summary,
      state: createSessionState(),
      seq: 0,
      agent: null,
      starting: null,
      generation: 0,
    };
    // Registered first so events the agent emits while starting are kept.
    this.sessions.set(summary.id, session);
    try {
      // Starting the agent validates the folder, the installation and the endpoint up front.
      session.agent = await this.createAgent(session);
    } catch (error) {
      this.sessions.delete(summary.id);
      throw error;
    }
    if (summary.cwd !== null) {
      // Chats in a folder belong to its project, created on first use.
      const known = this.projects.list().length;
      const project = await this.projects.ensure(summary.cwd);
      session.summary = { ...session.summary, projectId: project.id };
      if (this.projects.list().length !== known) this.notifyProjectsChanged();
    }
    this.notifySessionsChanged();
    return session.summary;
  }

  private agentFor(session: ManagedSession): Promise<SessionAgent> {
    if (session.agent) return Promise.resolve(session.agent);
    session.starting ??= this.createAgent(session).then(
      (agent) => {
        session.agent = agent;
        session.starting = null;
        return agent;
      },
      (error: unknown) => {
        session.starting = null;
        throw error;
      },
    );
    return session.starting;
  }

  private async createAgent(session: ManagedSession): Promise<SessionAgent> {
    const { summary, state } = session;
    const generation = session.generation;
    const onEvent = (event: SessionEvent) => {
      if (session.generation === generation) this.handleEvent(summary.id, event);
    };

    if (isCodingAgent(summary.agentId)) {
      if (summary.cwd === null) throw new Error('This session has no working folder.');
      await this.checkWorkingFolder(summary.cwd);
      const searchPath = await resolveSearchPath();
      const definition = getAgent(summary.agentId as AgentId);
      const status = await detectAgent(definition, { searchPath });
      if (!status.path) {
        throw new Error(
          `${definition.displayName} is not installed. Install it from the Agents screen.`,
        );
      }
      const common = {
        cwd: summary.cwd,
        env: buildChildEnv(searchPath),
        mcp: this.mcp,
        hubTools: true,
        hubSessionId: summary.id,
        label: agentLabel(summary),
        onEvent,
      };
      // Each agent continues the conversation it stored for this session.
      const resumeId = state.agentSessionId;

      if (summary.agentId === 'claude-code') {
        let env = common.env;
        if (summary.provider === 'anthropic') {
          const apiKey = await getApiKey('anthropic');
          if (!apiKey) {
            throw new Error(
              'This session is billed to your Anthropic API key. Add the key in Settings, under API keys.',
            );
          }
          // A signed-in Claude Code keeps using the plan even when ANTHROPIC_API_KEY is set, so
          // API-billed sessions run with a separate configuration folder that has no login.
          // PowerChord never reads that folder; Claude Code keeps its own records there.
          const configDir = join(app.getPath('userData'), 'claude-code-api');
          await mkdir(configDir, { recursive: true });
          env = { ...env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: configDir };
        }
        // Claude Code reads CLAUDE.md itself; the private project memory is added to its prompt.
        const memory = await this.memory.agentContext(summary.cwd);
        return new ClaudeCodeSession({
          ...common,
          env,
          ...(memory ? { appendSystemPrompt: memory } : {}),
          executable: status.path,
          model: summary.model,
          permissionMode: isPermissionMode(summary.permissionMode)
            ? summary.permissionMode
            : 'default',
          ...(resumeId ? { resumeSessionId: resumeId } : {}),
          ...(resumeId && state.resumeAt ? { resumeSessionAt: state.resumeAt } : {}),
        });
      }
      if (summary.agentId === 'codex') {
        return new CodexSession({
          ...common,
          command: { command: status.path, args: [] },
          model: summary.model,
          mode: isCodexMode(summary.permissionMode) ? summary.permissionMode : 'auto',
          ...(resumeId ? { resumeThreadId: resumeId } : {}),
        });
      }
      const apiKey = await getApiKey('gemini');
      if (!apiKey) {
        throw new Error('Gemini CLI needs a Gemini API key. Add one in Settings, under API keys.');
      }
      return new AcpSession({
        ...common,
        // The key reaches Gemini CLI through its documented environment variable only.
        env: { ...common.env, GEMINI_API_KEY: apiKey },
        agentName: 'Gemini CLI',
        command: { command: status.path, args: ['--acp'] },
        authMethodId: 'gemini-api-key',
        model: summary.model,
        mode: summary.permissionMode,
        ...(resumeId ? { resumeSessionId: resumeId } : {}),
      });
    }

    if (!summary.model) throw new Error('Choose a model');
    const history = chatHistoryFromTranscript(state.items);
    const restored = state.agentSessionId ? { agentSessionId: state.agentSessionId } : {};
    let workspace = {};
    const folder = summary.cwd;
    if (folder !== null) {
      await this.checkWorkingFolder(folder);
      const projectContext = await this.memory.modelChatContext(folder);
      workspace = {
        workspace: {
          cwd: folder,
          env: buildChildEnv(await resolveSearchPath()),
          mode: isModelChatMode(summary.permissionMode) ? summary.permissionMode : 'ask',
        },
        ...(projectContext ? { projectContext } : {}),
        remember: (note: string) =>
          this.memory.rememberIn(folder, note, agentLabel(session.summary)),
        checkpoints: this.checkpoints(summary.id),
        delegation: {
          gateway: this.delegation,
          parentSessionId: summary.id,
          folder,
          author: () => agentLabel(session.summary),
        },
      };
    }

    if (summary.agentId === 'api-model') {
      const provider = summary.provider;
      if (!isApiProvider(provider)) throw new Error('This chat has no provider.');
      const connection = await providerConnection(provider);
      return new ModelChatSession({
        endpoint: connection,
        protocol: PROVIDER_APIS[provider].protocol,
        priceFor: (model) => findPrice(provider, model),
        // OpenAI does not publish context windows through its API.
        contextWindow: async (model) =>
          provider === 'anthropic'
            ? fetchAnthropicContextWindow(connection, model)
            : provider === 'gemini' && connection.apiKey
              ? fetchGeminiContextWindow(connection.apiKey, model)
              : null,
        model: summary.model,
        history,
        ...restored,
        ...workspace,
        onEvent,
      });
    }

    const endpoint = summary.endpointId ? await findEndpoint(summary.endpointId) : undefined;
    if (!endpoint) throw new Error('The model server of this chat was removed.');
    const connection = await endpointConnection(endpoint);
    return new ModelChatSession({
      endpoint: connection,
      contextWindow: (model) => fetchServerContextWindow(connection, model),
      model: summary.model,
      history,
      ...restored,
      ...workspace,
      onEvent,
    });
  }

  private handleEvent(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = applySessionEvent(session.state, event);
    session.seq += 1;

    let summaryChanged = false;
    if (event.type === 'status' && session.summary.status !== event.status) {
      session.summary = { ...session.summary, status: event.status };
      summaryChanged = true;
    }
    if (event.type === 'user-message') {
      // A new message brings an archived chat back to the list.
      session.summary = { ...session.summary, lastActiveAt: Date.now(), archived: false };
      summaryChanged = true;
      if (session.summary.title === 'New session') {
        session.summary = { ...session.summary, title: makeTitle(event.text) || 'New session' };
        session.agent?.setLabel(agentLabel(session.summary));
      }
    }

    if (event.type === 'turn-complete' && session.summary.provider) {
      void recordUsage(session.summary.provider, event.summary);
    }

    const message: SessionEventMessage = { sessionId, seq: session.seq, event };
    broadcast(IpcChannel.SessionEvent, message);
    this.persist(session);
    if (summaryChanged) this.notifySessionsChanged();
  }

  /**
   * Asks before a pay-as-you-go message when the monthly budget is used up or the message is
   * estimated to cost more than the user's threshold. Resolves false if the user declines.
   */
  private async confirmCost(
    window: BrowserWindow | null,
    session: ManagedSession,
    text: string,
  ): Promise<boolean> {
    const { provider } = session.summary;
    if (!provider) return true;
    const budgets = await getBudgets();
    const spent = await monthSpend(provider);
    const budget = budgets.monthlyUsd[provider];
    const model = session.state.model ?? session.summary.model;
    const price = model ? findPrice(provider, model) : null;
    const contextTokens =
      session.summary.agentId === 'claude-code'
        ? AGENT_CONTEXT_TOKENS
        : session.summary.cwd !== null
          ? MODEL_TOOLS_CONTEXT_TOKENS
          : 0;
    const transcript = session.state.items
      .map((item) => (item.kind === 'user' || item.kind === 'text' ? item.text : ''))
      .join('');
    const estimate = price
      ? estimateCost(
          price,
          contextTokens + approximateTokens(transcript + text),
          ESTIMATED_OUTPUT_TOKENS,
        )
      : null;

    let detail: string | null = null;
    if (budget !== undefined && spent >= budget) {
      detail = `You have used about ${formatUsd(spent)} of your ${formatUsd(budget)} monthly budget for the ${providerName(provider)}.`;
    } else if (estimate !== null && estimate >= budgets.confirmAboveUsd) {
      detail = `This message is estimated to cost about ${formatUsd(estimate)}, more than your ${formatUsd(budgets.confirmAboveUsd)} limit for asking.`;
    }
    if (detail === null) return true;

    const confirmation: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Send', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Pay-as-you-go usage',
      message: 'Send this message?',
      detail: `${detail}\n\nEstimates use list prices and may differ from what the provider bills. Budgets can be changed in Settings.`,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    return response === 0;
  }

  private async send(
    window: BrowserWindow | null,
    session: ManagedSession,
    text: string,
  ): Promise<void> {
    if (!(await this.confirmCost(window, session, text))) throw new Error('Message not sent.');
    let agent: SessionAgent;
    try {
      agent = await this.agentFor(session);
    } catch (error) {
      // Shown in the transcript, where the user is looking.
      this.handleEvent(session.summary.id, {
        type: 'error',
        id: randomUUID(),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    agent.send(text);
  }

  private async compact(window: BrowserWindow | null, session: ManagedSession): Promise<void> {
    const { agentId } = session.summary;
    if (agentId !== 'local-model' && agentId !== 'api-model') {
      throw new Error('Coding agents manage their own context.');
    }
    // The summary request resends the whole conversation, so it costs about as much as a message.
    if (!(await this.confirmCost(window, session, ''))) throw new Error('Not compacted.');
    const agent = await this.agentFor(session);
    if (!agent.compact) throw new Error('This session cannot be compacted.');
    agent.compact();
  }

  /**
   * Has the agent measure its context, for agents that can without a turn. Problems such as a
   * missing agent are reported when the user sends a message.
   */
  private refreshContext(session: ManagedSession): void {
    const { status } = session.summary;
    if (status === 'running' || status === 'starting') return;
    void this.agentFor(session)
      .then((agent) => agent.refreshContext?.())
      .catch(() => undefined);
  }

  /** File checkpoints of a model chat, kept in PowerChord's data folder. */
  private checkpoints(sessionId: string): FileCheckpointStore {
    return new FileCheckpointStore(join(app.getPath('userData'), 'checkpoints', sessionId));
  }

  /**
   * Rewinds the conversation to before the user message `itemId`, after asking whether to also
   * restore the files changed since then. Resolves with the message text, which goes back to the
   * composer, or null when the user cancelled.
   */
  private async rewind(
    window: BrowserWindow | null,
    session: ManagedSession,
    itemId: unknown,
  ): Promise<string | null> {
    const { summary } = session;
    if (!canRewind(summary.agentId)) {
      throw new Error(`${SESSION_AGENT_NAMES[summary.agentId]} chats cannot be rewound.`);
    }
    if (summary.status === 'running' || summary.status === 'starting') {
      throw new Error('Stop the current turn before rewinding.');
    }
    const items = session.state.items;
    const index = items.findIndex((item) => item.id === itemId && item.kind === 'user');
    if (index === -1) throw new Error('Unknown message');
    const target = items[index] as UserItem;
    const turns = items.slice(index).filter((item): item is UserItem => item.kind === 'user');
    const isFirst = !items.slice(0, index).some((item) => item.kind === 'user');

    let files: string[] = [];
    let filesNote: string | null = null;
    let restore: (() => Promise<void>) | null = null;
    if (summary.agentId === 'claude-code') {
      const ref = target.agentRef;
      if (!ref && !isFirst) {
        throw new Error(
          'This message was sent with an earlier version of PowerChord, which did not record what rewinding Claude Code needs.',
        );
      }
      if (ref) {
        const agent = await this.agentFor(session);
        if (!(agent instanceof ClaudeCodeSession)) throw new Error('Unexpected agent');
        const preview = await agent.rewindFiles(ref.promptId, true).catch((error: unknown) => ({
          canRewind: false,
          error: error instanceof Error ? error.message : String(error),
          files: [],
        }));
        if (preview.canRewind) {
          files = preview.files;
          restore = async () => {
            const result = await agent.rewindFiles(ref.promptId, false);
            if (!result.canRewind) {
              throw new Error(result.error ?? 'Claude Code could not restore the files.');
            }
          };
        } else {
          filesNote = preview.error;
        }
      }
    } else if (summary.cwd !== null) {
      const store = this.checkpoints(summary.id);
      const turnIds = turns.map((turn) => turn.id);
      files = await store.changedFiles(turnIds);
      restore = async () => {
        await store.restore(turnIds);
      };
    }

    const cwd = summary.cwd;
    const shown = files
      .slice(0, 12)
      .map((file) =>
        cwd && file.toLowerCase().startsWith(cwd.toLowerCase())
          ? file.slice(cwd.length).replace(/^[\\/]/, '')
          : file,
      );
    const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : '';
    const fileDetail =
      files.length > 0
        ? `Files changed since then:\n${shown.join('\n')}${more}\n\nChanges made by commands are not undone.`
        : filesNote
          ? `File changes cannot be restored: ${filesNote}`
          : 'There are no file changes to restore.';
    const buttons =
      files.length > 0
        ? ['Rewind conversation and files', 'Rewind conversation only', 'Cancel']
        : ['Rewind', 'Cancel'];
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
      title: 'Rewind',
      message: 'Rewind the conversation to before this message?',
      detail: `The message and everything after it are removed; the message goes back to the composer.\n\n${fileDetail}`,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response === buttons.length - 1) return null;
    if (files.length > 0 && response === 0 && restore) await restore();

    // The agent restarts from the rewound conversation at the next message.
    session.generation += 1;
    session.agent?.close();
    session.agent = null;
    session.starting = null;
    if (summary.agentId !== 'claude-code') {
      await this.checkpoints(summary.id).discard(turns.map((turn) => turn.id));
    }
    const resumeAt = target.agentRef?.resumeAt ?? null;
    this.handleEvent(summary.id, {
      type: 'rewound',
      itemId: target.id,
      resumeAt,
      resetConversation: summary.agentId === 'claude-code' && (isFirst || resumeAt === null),
    });
    this.handleEvent(summary.id, { type: 'status', status: 'idle' });
    if (summary.agentId === 'claude-code') this.refreshContext(session);
    return target.text;
  }

  private async delete(window: BrowserWindow | null, session: ManagedSession): Promise<boolean> {
    const { agentId } = session.summary;
    const agentName = SESSION_AGENT_NAMES[agentId];
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Delete session',
      message: `Delete "${session.summary.title}"?`,
      detail: isCodingAgent(agentId)
        ? `PowerChord removes the session from its history. ${agentName} keeps its own record of the conversation, which you can still resume from ${agentName} itself.`
        : 'The conversation is removed from PowerChord.',
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return false;
    session.agent?.close();
    this.sessions.delete(session.summary.id);
    await this.store.delete(session.summary.id);
    await this.checkpoints(session.summary.id).clear();
    this.notifySessionsChanged();
    return true;
  }

  private search(query: unknown): string[] {
    if (typeof query !== 'string') throw new Error('Invalid query');
    const needle = query.trim().toLowerCase();
    if (!needle) return this.list().map((summary) => summary.id);
    return this.list()
      .filter((summary) => {
        const session = this.sessions.get(summary.id)!;
        return (
          summary.title.toLowerCase().includes(needle) ||
          transcriptText(session.state).toLowerCase().includes(needle)
        );
      })
      .map((summary) => summary.id);
  }

  private async openIn(session: ManagedSession, target: OpenTarget): Promise<void> {
    const { cwd } = session.summary;
    if (cwd === null) throw new Error('This session has no working folder.');
    if (target === 'explorer') {
      const error = await shell.openPath(cwd);
      if (error) throw new Error(error);
      return;
    }
    const searchPath = await resolveSearchPath();
    const antigravity = await detectAgent(getAgent('antigravity-cli'), { searchPath });
    if (!antigravity.path) throw new Error('Antigravity CLI is not installed.');
    // Launch only: the user works in Antigravity's own interface (docs/COMPLIANCE.md).
    await openInTerminal(
      { command: antigravity.path, args: [] },
      { cwd, env: buildChildEnv(searchPath) },
    );
  }

  private updateSettings(
    session: ManagedSession,
    settings: { model?: unknown; permissionMode?: unknown },
  ): void {
    const { agentId } = session.summary;
    if (settings.model !== undefined) {
      const valid =
        agentId === 'claude-code'
          ? isClaudeModel(settings.model)
          : agentId === 'local-model' || agentId === 'api-model'
            ? isModelName(settings.model)
            : isOptionalModelName(settings.model);
      if (!valid) throw new Error('Invalid model');
      const model = settings.model as string | null;
      session.agent?.setModel(model);
      session.summary = { ...session.summary, model };
    }
    if (settings.permissionMode !== undefined) {
      const mode = settings.permissionMode;
      const valid =
        agentId === 'claude-code'
          ? isPermissionMode(mode)
          : agentId === 'codex'
            ? isCodexMode(mode)
            : agentId === 'gemini-cli'
              ? isModeName(mode)
              : session.summary.cwd !== null && isModelChatMode(mode);
      if (!valid) throw new Error('Invalid mode');
      session.agent?.setMode(mode as string);
      session.summary = { ...session.summary, permissionMode: mode as string };
    }
    this.persist(session);
    this.notifySessionsChanged();
  }

  private registerHandlers(): void {
    this.registerProjectHandlers();
    ipcMain.handle(IpcChannel.ChooseWorkingDirectory, (event) =>
      this.chooseWorkingDirectory(BrowserWindow.fromWebContents(event.sender)),
    );
    ipcMain.handle(IpcChannel.ListSessions, () => this.list());
    ipcMain.handle(IpcChannel.SearchSessions, (_event, query: unknown) => this.search(query));
    ipcMain.handle(IpcChannel.CreateSession, (_event, request: CreateSessionRequest) =>
      this.create(request),
    );
    ipcMain.handle(IpcChannel.GetSession, (_event, sessionId: unknown): SessionSnapshot | null => {
      const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
      if (!session) return null;
      const { agentId } = session.summary;
      if (!session.agent && (agentId === 'local-model' || agentId === 'api-model')) {
        // Model chats start no process, so an opened chat starts at once to report its context.
        // Problems such as a missing server are reported when the user sends a message.
        void this.agentFor(session).catch(() => undefined);
      } else if (agentId === 'claude-code' && session.state.context === null) {
        // A new or rewound chat has no measurement yet; Claude Code reports one without a turn.
        this.refreshContext(session);
      }
      return { summary: session.summary, state: session.state, seq: session.seq };
    });
    ipcMain.handle(IpcChannel.SendMessage, (event, sessionId: unknown, text: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('Empty message');
      return this.send(BrowserWindow.fromWebContents(event.sender), this.require(sessionId), text);
    });
    ipcMain.handle(IpcChannel.InterruptSession, (_event, sessionId: unknown) => {
      this.require(sessionId).agent?.interrupt();
    });
    ipcMain.handle(IpcChannel.CompactSession, (event, sessionId: unknown) =>
      this.compact(BrowserWindow.fromWebContents(event.sender), this.require(sessionId)),
    );
    ipcMain.handle(
      IpcChannel.RespondToPermission,
      (_event, sessionId: unknown, requestId: unknown, behavior: unknown, scope: unknown) => {
        if (typeof requestId !== 'string') throw new Error('Invalid request');
        if (behavior !== 'allow' && behavior !== 'deny') throw new Error('Invalid decision');
        if (scope !== 'once' && scope !== 'session') throw new Error('Invalid scope');
        activeAgent(this.require(sessionId)).respondToPermission(requestId, behavior, scope);
      },
    );
    ipcMain.handle(
      IpcChannel.AnswerQuestion,
      (_event, sessionId: unknown, requestId: unknown, answers: unknown) => {
        if (typeof requestId !== 'string') throw new Error('Invalid request');
        if (!isAnswers(answers)) throw new Error('Invalid answers');
        activeAgent(this.require(sessionId)).answerQuestion(requestId, answers);
      },
    );
    ipcMain.handle(
      IpcChannel.UpdateSessionSettings,
      (_event, sessionId: unknown, settings: { model?: unknown; permissionMode?: unknown }) =>
        this.updateSettings(this.require(sessionId), settings),
    );
    ipcMain.handle(IpcChannel.DeleteSession, (event, sessionId: unknown) =>
      this.delete(BrowserWindow.fromWebContents(event.sender), this.require(sessionId)),
    );
    ipcMain.handle(IpcChannel.RewindSession, (event, sessionId: unknown, itemId: unknown) =>
      this.rewind(BrowserWindow.fromWebContents(event.sender), this.require(sessionId), itemId),
    );
    ipcMain.handle(
      IpcChannel.SetSessionArchived,
      (_event, sessionId: unknown, archived: unknown) => {
        if (typeof archived !== 'boolean') throw new Error('Invalid value');
        this.setArchived(this.require(sessionId), archived);
      },
    );
    ipcMain.handle(IpcChannel.ShowSessionMenu, (event, sessionId: unknown, options: unknown) =>
      this.showSessionMenu(
        BrowserWindow.fromWebContents(event.sender),
        this.require(sessionId),
        options,
      ),
    );
    ipcMain.handle(IpcChannel.OpenSessionIn, (_event, sessionId: unknown, target: unknown) => {
      if (target !== 'antigravity' && target !== 'explorer') throw new Error('Invalid target');
      return this.openIn(this.require(sessionId), target);
    });
  }
}

/**
 * Shows a native context menu at the pointer and resolves with the chosen item's id, or null
 * when the menu closes without a choice. `null` entries are separators.
 */
function popupMenu<T extends string>(
  window: BrowserWindow | null,
  items: ({ id: T; label: string } | null)[],
): Promise<T | null> {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(
      items.map((item) =>
        item === null
          ? { type: 'separator' as const }
          : { label: item.label, click: () => resolve(item.id) },
      ),
    );
    // On some platforms the close callback fires before the click handler, so closing resolves
    // with null only after the click had a chance to run; a promise settles once.
    menu.popup({
      ...(window ? { window } : {}),
      callback: () => setTimeout(() => resolve(null), 50),
    });
  });
}
