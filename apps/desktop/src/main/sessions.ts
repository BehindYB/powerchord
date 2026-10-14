import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  applySessionEvent,
  buildChildEnv,
  chatHistoryFromTranscript,
  ClaudeCodeSession,
  createSessionState,
  detectAgent,
  getAgent,
  ModelChatSession,
  openInTerminal,
  resolveSearchPath,
  settleSessionState,
  type PowerChordMcpServer,
  type PermissionMode,
  type QuestionAnswers,
  type SessionEvent,
  type SessionState,
} from '@powerchord/core';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  CLAUDE_MODELS,
  IpcChannel,
  PERMISSION_MODES,
  type CreateSessionRequest,
  type OpenTarget,
  type SessionEventMessage,
  type SessionSnapshot,
  type SessionSummary,
} from '../shared/ipc';
import { findEndpoint } from './models';
import { SessionStore } from './session-store';
import { isFolderTrusted, trustFolder } from './settings';

const TITLE_LENGTH = 60;
/** Length of the session name recorded as the author of hub changes. */
const LABEL_LENGTH = 32;

type SessionAgent = ClaudeCodeSession | ModelChatSession;

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

function isClaudeModel(value: unknown): value is string | null {
  return CLAUDE_MODELS.some((model) => model.id === value);
}

function isModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function claudeSession(session: ManagedSession): ClaudeCodeSession {
  if (!(session.agent instanceof ClaudeCodeSession)) {
    throw new Error('This action is only available for active Claude Code sessions.');
  }
  return session.agent;
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
        summary: { ...stored.summary, status: 'idle' },
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

    if (request.agentId === 'claude-code') {
      if (!isClaudeModel(request.model) || !isPermissionMode(request.permissionMode)) {
        throw new Error('Invalid session settings');
      }
      summary = {
        ...base,
        agentId: 'claude-code',
        cwd: request.cwd,
        endpointId: null,
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

    if (summary.agentId === 'claude-code') {
      if (summary.cwd === null) throw new Error('This session has no working folder.');
      await this.checkWorkingFolder(summary.cwd);
      const searchPath = await resolveSearchPath();
      const status = await detectAgent(getAgent('claude-code'), { searchPath });
      if (!status.path) {
        throw new Error('Claude Code is not installed. Install it from the Agents screen.');
      }
      const agent = new ClaudeCodeSession({
        executable: status.path,
        cwd: summary.cwd,
        env: buildChildEnv(searchPath),
        mcp: this.mcp,
        model: summary.model,
        permissionMode: summary.permissionMode ?? 'default',
        hubTools: true,
        label:
          summary.title === 'New session'
            ? 'Claude Code'
            : `Claude Code: ${makeTitle(summary.title, LABEL_LENGTH)}`,
        // Continues the conversation Claude Code stored for this session.
        ...(state.agentSessionId ? { resumeSessionId: state.agentSessionId } : {}),
        onEvent,
      });
      return agent;
    }

    const endpoint = summary.endpointId ? await findEndpoint(summary.endpointId) : undefined;
    if (!endpoint) throw new Error('The model server of this chat was removed.');
    if (!summary.model) throw new Error('Choose a model');
    return new ModelChatSession({
      endpoint: { baseUrl: endpoint.baseUrl },
      model: summary.model,
      history: chatHistoryFromTranscript(state.items),
      ...(state.agentSessionId ? { agentSessionId: state.agentSessionId } : {}),
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
        if (session.agent instanceof ClaudeCodeSession) {
          session.agent.setLabel(`Claude Code: ${makeTitle(event.text, LABEL_LENGTH)}`);
        }
      }
    }

    const message: SessionEventMessage = { sessionId, seq: session.seq, event };
    broadcast(IpcChannel.SessionEvent, message);
    this.persist(session);
    if (summaryChanged) this.notifySessionsChanged();
  }

  private async send(session: ManagedSession, text: string): Promise<void> {
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
    const isClaude = session.summary.agentId === 'claude-code';
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Delete session',
      message: `Delete "${session.summary.title}"?`,
      detail: isClaude
        ? "PowerChord removes the session from its history. Claude Code keeps its own record of the conversation, which you can still resume with 'claude --resume'."
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
    if (settings.model !== undefined) {
      const valid =
        session.summary.agentId === 'claude-code'
          ? isClaudeModel(settings.model)
          : isModelName(settings.model);
      if (!valid) throw new Error('Invalid model');
      const model = settings.model as string | null;
      session.agent?.setModel(model);
      session.summary = { ...session.summary, model };
    }
    if (settings.permissionMode !== undefined) {
      if (session.summary.agentId !== 'claude-code' || !isPermissionMode(settings.permissionMode)) {
        throw new Error('Invalid mode');
      }
      if (session.agent instanceof ClaudeCodeSession) {
        session.agent.setPermissionMode(settings.permissionMode);
      }
      session.summary = { ...session.summary, permissionMode: settings.permissionMode };
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
    ipcMain.handle(IpcChannel.SendMessage, (_event, sessionId: unknown, text: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('Empty message');
      return this.send(this.require(sessionId), text);
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
        claudeSession(this.require(sessionId)).respondToPermission(requestId, behavior, scope);
      },
    );
    ipcMain.handle(
      IpcChannel.AnswerQuestion,
      (_event, sessionId: unknown, requestId: unknown, answers: unknown) => {
        if (typeof requestId !== 'string') throw new Error('Invalid request');
        if (!isAnswers(answers)) throw new Error('Invalid answers');
        claudeSession(this.require(sessionId)).answerQuestion(requestId, answers);
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
