import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  applySessionEvent,
  buildChildEnv,
  ClaudeCodeSession,
  createSessionState,
  detectAgent,
  getAgent,
  ModelChatSession,
  openInTerminal,
  resolveSearchPath,
  type PowerChordMcpServer,
  type PermissionMode,
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
import { isFolderTrusted, trustFolder } from './settings';

const TITLE_LENGTH = 60;
/** Length of the session name recorded as the author of hub changes. */
const LABEL_LENGTH = 32;

interface ManagedSession {
  summary: SessionSummary;
  state: SessionState;
  seq: number;
  agent: ClaudeCodeSession | ModelChatSession;
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
    throw new Error('This action is only available for Claude Code sessions.');
  }
  return session.agent;
}

function makeTitle(text: string, length = TITLE_LENGTH): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly mcp: PowerChordMcpServer;

  /** The MCP server must be started before sessions are created. */
  constructor(mcp: PowerChordMcpServer) {
    this.mcp = mcp;
  }

  start(): void {
    this.registerHandlers();
  }

  stop(): void {
    for (const session of this.sessions.values()) session.agent.close();
    this.sessions.clear();
  }

  private list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => session.summary)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private notifySessionsChanged(): void {
    broadcast(IpcChannel.SessionsChanged, this.list());
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

  private async create(request: CreateSessionRequest): Promise<SessionSummary> {
    const id = randomUUID();
    const onEvent = (event: SessionEvent) => this.handleEvent(id, event);
    const base = { id, title: 'New session', status: 'idle' as const, createdAt: Date.now() };
    let summary: SessionSummary;
    let agent: ClaudeCodeSession | ModelChatSession;

    if (request.agentId === 'claude-code') {
      if (!isClaudeModel(request.model) || !isPermissionMode(request.permissionMode)) {
        throw new Error('Invalid session settings');
      }
      const folder = await stat(request.cwd).catch(() => null);
      if (!folder?.isDirectory()) throw new Error('The working folder does not exist.');
      if (!(await isFolderTrusted(request.cwd))) {
        throw new Error('The working folder is not trusted.');
      }
      const searchPath = await resolveSearchPath();
      const status = await detectAgent(getAgent('claude-code'), { searchPath });
      if (!status.path) {
        throw new Error('Claude Code is not installed. Install it from the Agents screen.');
      }
      summary = {
        ...base,
        agentId: 'claude-code',
        cwd: request.cwd,
        endpointId: null,
        model: request.model,
        permissionMode: request.permissionMode,
      };
      agent = new ClaudeCodeSession({
        executable: status.path,
        cwd: request.cwd,
        env: buildChildEnv(searchPath),
        mcp: this.mcp,
        model: request.model,
        permissionMode: request.permissionMode,
        hubTools: true,
        label: 'Claude Code',
        onEvent,
      });
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
      agent = new ModelChatSession({
        endpoint: { baseUrl: endpoint.baseUrl },
        model: request.model,
        onEvent,
      });
    } else {
      throw new Error('Unsupported agent');
    }

    this.sessions.set(id, { summary, state: createSessionState(), seq: 0, agent });
    this.notifySessionsChanged();
    return summary;
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
    if (event.type === 'user-message' && session.summary.title === 'New session') {
      session.summary = { ...session.summary, title: makeTitle(event.text) || 'New session' };
      summaryChanged = true;
      if (session.agent instanceof ClaudeCodeSession) {
        session.agent.setLabel(`Claude Code: ${makeTitle(event.text, LABEL_LENGTH)}`);
      }
    }

    const message: SessionEventMessage = { sessionId, seq: session.seq, event };
    broadcast(IpcChannel.SessionEvent, message);
    if (summaryChanged) this.notifySessionsChanged();
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

  private registerHandlers(): void {
    ipcMain.handle(IpcChannel.ChooseWorkingDirectory, (event) =>
      this.chooseWorkingDirectory(BrowserWindow.fromWebContents(event.sender)),
    );
    ipcMain.handle(IpcChannel.ListSessions, () => this.list());
    ipcMain.handle(IpcChannel.CreateSession, (_event, request: CreateSessionRequest) =>
      this.create(request),
    );
    ipcMain.handle(IpcChannel.GetSession, (_event, sessionId: unknown): SessionSnapshot | null => {
      const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
      return session ? { summary: session.summary, state: session.state, seq: session.seq } : null;
    });
    ipcMain.handle(IpcChannel.SendMessage, (_event, sessionId: unknown, text: unknown) => {
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('Empty message');
      this.require(sessionId).agent.send(text);
    });
    ipcMain.handle(IpcChannel.InterruptSession, (_event, sessionId: unknown) => {
      this.require(sessionId).agent.interrupt();
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
      IpcChannel.UpdateSessionSettings,
      (_event, sessionId: unknown, settings: { model?: unknown; permissionMode?: unknown }) => {
        const session = this.require(sessionId);
        if (settings.model !== undefined) {
          const valid =
            session.agent instanceof ClaudeCodeSession
              ? isClaudeModel(settings.model)
              : isModelName(settings.model);
          if (!valid) throw new Error('Invalid model');
          session.agent.setModel(settings.model as string | null);
          session.summary = { ...session.summary, model: settings.model as string | null };
        }
        if (settings.permissionMode !== undefined) {
          if (!isPermissionMode(settings.permissionMode)) throw new Error('Invalid mode');
          claudeSession(session).setPermissionMode(settings.permissionMode);
          session.summary = { ...session.summary, permissionMode: settings.permissionMode };
        }
        this.notifySessionsChanged();
      },
    );
    ipcMain.handle(IpcChannel.CloseSession, (_event, sessionId: unknown) => {
      const session = this.require(sessionId);
      session.agent.close();
      this.sessions.delete(session.summary.id);
      this.notifySessionsChanged();
    });
    ipcMain.handle(IpcChannel.OpenSessionIn, (_event, sessionId: unknown, target: unknown) => {
      if (target !== 'antigravity' && target !== 'explorer') throw new Error('Invalid target');
      return this.openIn(this.require(sessionId), target);
    });
  }
}
