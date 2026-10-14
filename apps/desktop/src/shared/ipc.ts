/**
 * Contract between the main process and the renderer.
 * Channel names and payload types live here so both sides stay in sync.
 */
import type {
  PermissionBehavior,
  PermissionMode,
  SessionEvent,
  SessionState,
  SessionStatus,
} from '@powerchord/core/sessions';

export const IpcChannel = {
  GetAppInfo: 'app:get-info',
  ListAgents: 'agents:list',
  InstallAgent: 'agents:install',
  InstallOutput: 'agents:install-output',
  OpenAgentSignIn: 'agents:open-sign-in',
  ChooseWorkingDirectory: 'sessions:choose-directory',
  ListSessions: 'sessions:list',
  CreateSession: 'sessions:create',
  GetSession: 'sessions:get',
  SendMessage: 'sessions:send',
  InterruptSession: 'sessions:interrupt',
  RespondToPermission: 'sessions:respond-permission',
  UpdateSessionSettings: 'sessions:update-settings',
  CloseSession: 'sessions:close',
  OpenSessionIn: 'sessions:open-in',
  SessionEvent: 'sessions:event',
  SessionsChanged: 'sessions:changed',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface AgentInstallMethodInfo {
  id: string;
  label: string;
  /** The exact command that will run. */
  display: string;
  sourceUrl: string;
  /** Executables that must be installed first; the method is unusable while this is non-empty. */
  missingRequirements: string[];
}

export interface AgentInfo {
  id: string;
  displayName: string;
  vendor: string;
  /** `launch-only` agents are operated through their own interface (docs/COMPLIANCE.md). */
  integration: 'driven' | 'launch-only';
  docsUrl: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  auth: { state: 'signed-in' | 'signed-out' | 'unknown'; detail?: string } | null;
  installMethods: AgentInstallMethodInfo[];
}

export type InstallOutcome =
  | { status: 'installed'; version: string | null }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export interface InstallOutputEvent {
  agentId: string;
  chunk: string;
}

/** Agents that PowerChord can run sessions with. */
export type SessionAgentId = 'claude-code';

export interface ModelOption {
  /** Value passed to the agent; null selects the agent's default model. */
  id: string | null;
  label: string;
}

export const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: null, label: 'Default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

export const PERMISSION_MODES: readonly {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  { id: 'default', label: 'Ask', description: 'Ask before edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edit files without asking' },
  { id: 'plan', label: 'Plan', description: 'Plan first, change nothing until approved' },
  { id: 'auto', label: 'Auto', description: 'Let Claude Code review actions automatically' },
];

export interface SessionSummary {
  id: string;
  agentId: SessionAgentId;
  title: string;
  cwd: string;
  status: SessionStatus;
  model: string | null;
  permissionMode: PermissionMode;
  createdAt: number;
}

export interface SessionSnapshot {
  summary: SessionSummary;
  state: SessionState;
  /** Sequence number of the last event included in `state`. */
  seq: number;
}

export interface CreateSessionRequest {
  agentId: SessionAgentId;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
}

export interface SessionEventMessage {
  sessionId: string;
  /** Increases by one per event within a session; lets the renderer skip events in a snapshot. */
  seq: number;
  event: SessionEvent;
}

export type OpenTarget = 'antigravity' | 'explorer';

/** API exposed to the renderer as `window.powerchord` by the preload script. */
export interface PowerChordApi {
  getAppInfo(): Promise<AppInfo>;
  listAgents(): Promise<AgentInfo[]>;
  /** Asks the user to confirm in a native dialog, then installs the agent with the given method. */
  installAgent(agentId: string, methodId: string): Promise<InstallOutcome>;
  /** Subscribes to installer output; returns an unsubscribe function. */
  onInstallOutput(listener: (event: InstallOutputEvent) => void): () => void;
  /** Opens the agent's own sign-in flow in a new terminal window. */
  openAgentSignIn(agentId: string): Promise<void>;

  /** Shows a folder picker and asks the user to trust the folder if needed. Null if cancelled. */
  chooseWorkingDirectory(): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(request: CreateSessionRequest): Promise<SessionSummary>;
  getSession(sessionId: string): Promise<SessionSnapshot | null>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  respondToPermission(
    sessionId: string,
    requestId: string,
    behavior: PermissionBehavior,
    scope: 'once' | 'session',
  ): Promise<void>;
  updateSessionSettings(
    sessionId: string,
    settings: { model?: string | null; permissionMode?: PermissionMode },
  ): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  openSessionIn(sessionId: string, target: OpenTarget): Promise<void>;
  onSessionEvent(listener: (message: SessionEventMessage) => void): () => void;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
}
