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
  findPrice,
  getAgent,
  isCodexMode,
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
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  IpcChannel,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  type ApiProviderId,
  type CodingAgentId,
  type CreateSessionRequest,
  type OpenTarget,
  type SessionEventMessage,
  type SessionSnapshot,
  type SessionSummary,
} from '../shared/ipc';
import { getApiKey } from './api-keys';
import { PROVIDER_APIS, providerConnection, providerName } from './api-models';
import { endpointConnection, findEndpoint } from './models';
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
}

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

  /** The MCP server must be started before sessions are created. */
  constructor(mcp: PowerChordMcpServer) {
    this.mcp = mcp;
  }

  async start(): Promise<void> {
    for (const stored of await this.store.loadAll()) {
      this.sessions.set(stored.summary.id, {
        // Sessions saved by earlier versions have no provider.
        summary: { ...stored.summary, provider: stored.summary.provider ?? null, status: 'idle' },
        state: settleSessionState(stored.state),
        seq: 0,
        agent: null,
        starting: null,
      });
    }
    this.registerHandlers();
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

  private async create(request: CreateSessionRequest): Promise<SessionSummary> {
    const now = Date.now();
    const base = {
      id: randomUUID(),
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
        agentId: 'local-model',
        cwd: null,
        endpointId: endpoint.id,
        provider: null,
        model: request.model,
        permissionMode: null,
      };
    } else if (request.agentId === 'api-model') {
      if (!isApiProvider(request.provider) || !isModelName(request.model)) {
        throw new Error('Choose a provider and a model');
      }
      summary = {
        ...base,
        agentId: 'api-model',
        cwd: null,
        endpointId: null,
        provider: request.provider,
        model: request.model,
        permissionMode: null,
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
    this.notifySessionsChanged();
    return summary;
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
    const onEvent = (event: SessionEvent) => this.handleEvent(summary.id, event);

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
        return new ClaudeCodeSession({
          ...common,
          env,
          executable: status.path,
          model: summary.model,
          permissionMode: isPermissionMode(summary.permissionMode)
            ? summary.permissionMode
            : 'default',
          ...(resumeId ? { resumeSessionId: resumeId } : {}),
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

    if (summary.agentId === 'api-model') {
      const provider = summary.provider;
      if (!isApiProvider(provider)) throw new Error('This chat has no provider.');
      return new ModelChatSession({
        endpoint: await providerConnection(provider),
        protocol: PROVIDER_APIS[provider].protocol,
        priceFor: (model) => findPrice(provider, model),
        model: summary.model,
        history,
        ...restored,
        onEvent,
      });
    }

    const endpoint = summary.endpointId ? await findEndpoint(summary.endpointId) : undefined;
    if (!endpoint) throw new Error('The model server of this chat was removed.');
    return new ModelChatSession({
      endpoint: await endpointConnection(endpoint),
      model: summary.model,
      history,
      ...restored,
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
      session.summary = { ...session.summary, lastActiveAt: Date.now() };
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
    const contextTokens = session.summary.agentId === 'claude-code' ? AGENT_CONTEXT_TOKENS : 0;
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
            : agentId === 'gemini-cli' && isModeName(mode);
      if (!valid) throw new Error('Invalid mode');
      session.agent?.setMode(mode as string);
      session.summary = { ...session.summary, permissionMode: mode as string };
    }
    this.persist(session);
    this.notifySessionsChanged();
  }

  private registerHandlers(): void {
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
      return session ? { summary: session.summary, state: session.state, seq: session.seq } : null;
    });
    ipcMain.handle(IpcChannel.SendMessage, (event, sessionId: unknown, text: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('Empty message');
      return this.send(BrowserWindow.fromWebContents(event.sender), this.require(sessionId), text);
    });
    ipcMain.handle(IpcChannel.InterruptSession, (_event, sessionId: unknown) => {
      this.require(sessionId).agent?.interrupt();
    });
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
    ipcMain.handle(IpcChannel.OpenSessionIn, (_event, sessionId: unknown, target: unknown) => {
      if (target !== 'antigravity' && target !== 'explorer') throw new Error('Invalid target');
      return this.openIn(this.require(sessionId), target);
    });
  }
}
