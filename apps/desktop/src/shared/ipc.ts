/**
 * Contract between the main process and the renderer.
 * Channel names and payload types live here so both sides stay in sync.
 */
import type {
  PermissionBehavior,
  PermissionMode,
  QuestionAnswers,
  SessionEvent,
  SessionState,
  SessionStatus,
} from '@powerchord/core/sessions';
import type { HubNote, HubTask, TaskStatus } from '@powerchord/core/hub';

export const IpcChannel = {
  GetAppInfo: 'app:get-info',
  ListAgents: 'agents:list',
  InstallAgent: 'agents:install',
  InstallOutput: 'agents:install-output',
  OpenAgentSignIn: 'agents:open-sign-in',
  ChooseWorkingDirectory: 'sessions:choose-directory',
  ListSessions: 'sessions:list',
  SearchSessions: 'sessions:search',
  CreateSession: 'sessions:create',
  GetSession: 'sessions:get',
  SendMessage: 'sessions:send',
  InterruptSession: 'sessions:interrupt',
  CompactSession: 'sessions:compact',
  RespondToPermission: 'sessions:respond-permission',
  AnswerQuestion: 'sessions:answer-question',
  UpdateSessionSettings: 'sessions:update-settings',
  DeleteSession: 'sessions:delete',
  SetSessionArchived: 'sessions:set-archived',
  ShowSessionMenu: 'sessions:show-menu',
  OpenSessionIn: 'sessions:open-in',
  ListProjects: 'projects:list',
  CreateProject: 'projects:create',
  RenameProject: 'projects:rename',
  RemoveProject: 'projects:remove',
  ShowProjectMenu: 'projects:show-menu',
  OpenProjectFolder: 'projects:open-folder',
  ProjectsChanged: 'projects:changed',
  GetProjectContext: 'projects:get-context',
  SaveProjectMemory: 'projects:save-memory',
  SaveProjectInstructions: 'projects:save-instructions',
  LinkProjectInstructions: 'projects:link-instructions',
  ProjectMemoryChanged: 'projects:memory-changed',
  SessionEvent: 'sessions:event',
  SessionsChanged: 'sessions:changed',
  ListModelEndpoints: 'models:list-endpoints',
  AddModelEndpoint: 'models:add-endpoint',
  RemoveModelEndpoint: 'models:remove-endpoint',
  DiscoverModelServers: 'models:discover',
  DiscoveryProgress: 'models:discover-progress',
  GetHub: 'hub:get',
  HubChanged: 'hub:changed',
  AddHubTask: 'hub:add-task',
  UpdateHubTask: 'hub:update-task',
  DeleteHubTask: 'hub:delete-task',
  SaveHubNote: 'hub:save-note',
  DeleteHubNote: 'hub:delete-note',
  SetHubDefaultModel: 'hub:set-default-model',
  RegisterHub: 'hub:register',
  CopyHubConfig: 'hub:copy-config',
  GetPreferences: 'preferences:get',
  SetTheme: 'preferences:set-theme',
  RemoveTrustedFolder: 'preferences:remove-trusted-folder',
  OpenDataFolder: 'preferences:open-data-folder',
  RegenerateHubToken: 'preferences:regenerate-hub-token',
  ListApiKeys: 'api-keys:list',
  SetApiKey: 'api-keys:set',
  DeleteApiKey: 'api-keys:delete',
  ListApiModels: 'api:list-models',
  ListClaudeModels: 'claude:list-models',
  GetUsage: 'usage:get',
  SetBudgets: 'usage:set-budgets',
  UsageChanged: 'usage:changed',
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
export type SessionAgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'local-model' | 'api-model';

/** Agents that work in a folder on the user's computer. */
export type CodingAgentId = Exclude<SessionAgentId, 'local-model' | 'api-model'>;

export const SESSION_AGENT_NAMES: Record<SessionAgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  'local-model': 'Local model',
  'api-model': 'API model',
};

/** How a Claude Code session is paid for: the user's plan or their Anthropic API key. */
export type ClaudeBilling = 'subscription' | 'api';

export interface ModelOption {
  /** Value passed to the agent; null selects the agent's default model. */
  id: string | null;
  label: string;
}

/** Used until Claude Code reports its own list, or when it cannot be asked. */
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

export const CODEX_MODE_OPTIONS: readonly {
  id: 'read-only' | 'auto' | 'full-access';
  label: string;
  description: string;
}[] = [
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Read files; ask before changes and commands',
  },
  { id: 'auto', label: 'Auto', description: 'Edit and run commands in the folder; ask for more' },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'No sandbox and no approvals. Use only in folders you can restore',
  },
];

export interface SessionSummary {
  id: string;
  agentId: SessionAgentId;
  title: string;
  /** Project the session belongs to; every session with a working folder has one. */
  projectId: string | null;
  /** Working folder; null for model chats without a project folder, which have no file access. */
  cwd: string | null;
  /** Model endpoint of a local model chat. */
  endpointId: string | null;
  /** Provider billed for the session: API model chats, and Claude Code sessions on an API key. */
  provider: ApiProviderId | null;
  status: SessionStatus;
  model: string | null;
  /** Agent-specific mode, such as a Claude Code permission mode; null for agents without modes. */
  permissionMode: string | null;
  createdAt: number;
  /** Time of the last message, used to order the session list. */
  lastActiveAt: number;
  /** Archived chats are kept but listed apart; sending a message brings them back. */
  archived: boolean;
}

/** What the renderer does after a session's context menu closes. */
export type SessionMenuResult = 'open-side-by-side' | 'deleted' | null;

/** What the renderer does after a project's context menu closes. */
export type ProjectMenuResult = 'new-chat' | 'removed' | null;

/** A folder whose chats PowerChord keeps together. */
export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  createdAt: number;
}

/** A project's memory and the instruction files in its folder. */
export interface ProjectContext {
  /** Private memory kept in PowerChord's data folder. */
  memory: string;
  instructions: {
    name: string;
    exists: boolean;
    text: string;
    /** Whether the file imports AGENTS.md. */
    importsShared: boolean;
  }[];
}

export interface SessionSnapshot {
  summary: SessionSummary;
  state: SessionState;
  /** Sequence number of the last event included in `state`. */
  seq: number;
}

export type CreateSessionRequest =
  | {
      agentId: 'claude-code';
      cwd: string;
      model: string | null;
      permissionMode: PermissionMode;
      billing: ClaudeBilling;
    }
  | { agentId: 'codex'; cwd: string; model: string | null; permissionMode: string }
  | { agentId: 'gemini-cli'; cwd: string; model: string | null; permissionMode: string | null }
  | ({ agentId: 'local-model'; endpointId: string; model: string } & ModelChatFolder)
  | ({ agentId: 'api-model'; provider: ApiProviderId; model: string } & ModelChatFolder);

/**
 * Project folder of a model chat. With a folder the model can use files, commands and the web,
 * asking first as the mode (a `MODEL_CHAT_MODES` id) requires; without one it can only chat.
 */
export interface ModelChatFolder {
  cwd: string | null;
  permissionMode: string | null;
}

export interface ApiModelInfo {
  id: string;
  label: string;
  /** List price in USD per million tokens; null when PowerChord does not know it. */
  price: { input: number; output: number } | null;
}

export interface ProviderUsage {
  /** Estimated spend this calendar month, in USD. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface UsageOverview {
  /** Calendar month, for example "2026-10". */
  month: string;
  providers: Partial<Record<ApiProviderId, ProviderUsage>>;
  budgets: Budgets;
  /** Date the built-in price list was checked against the providers' pages. */
  pricesReviewed: string;
}

export interface Budgets {
  /** Monthly spending limits in USD; a message past the limit needs confirmation. */
  monthlyUsd: Partial<Record<ApiProviderId, number>>;
  /** Messages estimated to cost more than this need confirmation. */
  confirmAboveUsd: number;
}

export interface ModelEndpointInfo {
  id: string;
  name: string;
  baseUrl: string;
  online: boolean;
  models: string[];
  error: string | null;
}

export interface DiscoveryResult {
  networks: { interfaceName: string; cidr: string; mode: 'full' | 'likely' }[];
  hostsScanned: number;
  servers: { baseUrl: string; name: string; models: string[]; alreadyAdded: boolean }[];
}

export interface DiscoveryProgress {
  done: number;
  total: number;
}

export interface SessionEventMessage {
  sessionId: string;
  /** Increases by one per event within a session; lets the renderer skip events in a snapshot. */
  seq: number;
  event: SessionEvent;
}

export type OpenTarget = 'antigravity' | 'explorer';

export type { HubNote, HubTask, TaskStatus };

export interface HubConnection {
  url: string;
  port: number;
  /** False when the preferred port was taken; agents registered earlier must be registered again. */
  usedPreferredPort: boolean;
  preferredPort: number;
}

export interface HubState {
  tasks: HubTask[];
  notes: HubNote[];
  connection: HubConnection;
  defaultModel: { endpointId: string; model: string } | null;
}

/** Agents PowerChord can register the hub in, using each agent's own MCP command. */
export type HubRegistrationTarget = 'antigravity-cli' | 'claude-code';

export type HubRegistrationOutcome =
  { status: 'registered' } | { status: 'cancelled' } | { status: 'failed'; message: string };

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Preferences {
  theme: ThemePreference;
  trustedFolders: string[];
  /** Where PowerChord keeps settings, session history and the hub. */
  dataFolder: string;
}

/** Providers whose pay-as-you-go APIs PowerChord can use with the user's own key. */
export type ApiProviderId = 'gemini' | 'openai' | 'anthropic';

export const API_PROVIDERS: readonly {
  id: ApiProviderId;
  name: string;
  /** Where the user creates a key. */
  keyUrl: string;
  usedFor: string;
}[] = [
  {
    id: 'gemini',
    name: 'Google Gemini API',
    keyUrl: 'https://aistudio.google.com/apikey',
    usedFor: 'Gemini CLI sessions and Gemini chats',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    keyUrl: 'https://platform.openai.com/api-keys',
    usedFor: 'OpenAI chats',
  },
  {
    id: 'anthropic',
    name: 'Anthropic API',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    usedFor: 'Claude chats billed to your API account',
  },
];

export interface ApiKeyInfo {
  provider: ApiProviderId;
  configured: boolean;
  /** Last characters of the stored key. */
  hint: string | null;
}

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
  /** Saved and active sessions, most recently used first. */
  listSessions(): Promise<SessionSummary[]>;
  /** Ids of the sessions whose title or transcript contains the query. */
  searchSessions(query: string): Promise<string[]>;
  createSession(request: CreateSessionRequest): Promise<SessionSummary>;
  getSession(sessionId: string): Promise<SessionSnapshot | null>;
  /**
   * Sends a message. Pay-as-you-go sessions may first ask the user to confirm the estimated cost
   * in a native dialog; a declined message is rejected with an error.
   */
  sendMessage(sessionId: string, text: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  /**
   * Replaces a model chat's conversation with a summary written by the model, to free context.
   * Pay-as-you-go chats may first ask the user to confirm the estimated cost.
   */
  compactSession(sessionId: string): Promise<void>;
  respondToPermission(
    sessionId: string,
    requestId: string,
    behavior: PermissionBehavior,
    scope: 'once' | 'session',
  ): Promise<void>;
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswers): Promise<void>;
  updateSessionSettings(
    sessionId: string,
    settings: { model?: string | null; permissionMode?: string },
  ): Promise<void>;
  /** Asks for confirmation, then stops the session and removes it from the history. */
  deleteSession(sessionId: string): Promise<boolean>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  /**
   * Shows a session's native context menu. Archiving and deleting happen in the main process;
   * the result tells the renderer what is left for it to do.
   */
  showSessionMenu(sessionId: string, options: { canSplit: boolean }): Promise<SessionMenuResult>;
  openSessionIn(sessionId: string, target: OpenTarget): Promise<void>;
  onSessionEvent(listener: (message: SessionEventMessage) => void): () => void;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;

  listProjects(): Promise<ProjectSummary[]>;
  /** Asks for a folder, trusting it if needed, and returns its project; null when cancelled. */
  createProject(): Promise<ProjectSummary | null>;
  renameProject(projectId: string, name: string): Promise<void>;
  /** Asks for confirmation, then removes the project and its chats from PowerChord. */
  removeProject(projectId: string): Promise<boolean>;
  openProjectFolder(projectId: string): Promise<void>;
  /** Shows a project's native context menu; see `showSessionMenu`. */
  showProjectMenu(projectId: string): Promise<ProjectMenuResult>;
  onProjectsChanged(listener: (projects: ProjectSummary[]) => void): () => void;
  getProjectContext(projectId: string): Promise<ProjectContext>;
  saveProjectMemory(projectId: string, text: string): Promise<void>;
  /** Writes AGENTS.md in the project folder, asking first when it does not exist yet. */
  saveProjectInstructions(projectId: string, text: string): Promise<boolean>;
  /** After confirmation, makes CLAUDE.md or GEMINI.md import AGENTS.md. */
  linkProjectInstructions(projectId: string, file: 'CLAUDE.md' | 'GEMINI.md'): Promise<boolean>;
  onProjectMemoryChanged(listener: (projectId: string) => void): () => void;

  /** Saved model endpoints, each checked for availability. */
  listModelEndpoints(): Promise<ModelEndpointInfo[]>;
  /** Verifies that the address serves an OpenAI-compatible API, then saves it. */
  addModelEndpoint(baseUrl: string, name?: string, apiKey?: string): Promise<ModelEndpointInfo>;
  removeModelEndpoint(endpointId: string): Promise<void>;
  /** Scans the user's private networks for model servers. Runs only when the user asks. */
  discoverModelServers(): Promise<DiscoveryResult>;
  onDiscoveryProgress(listener: (progress: DiscoveryProgress) => void): () => void;

  getHub(): Promise<HubState>;
  onHubChanged(listener: (state: Pick<HubState, 'tasks' | 'notes'>) => void): () => void;
  addHubTask(task: { title: string; description: string }): Promise<void>;
  updateHubTask(
    id: string,
    changes: { title?: string; description?: string; status?: TaskStatus; summary?: string | null },
  ): Promise<void>;
  deleteHubTask(id: string): Promise<void>;
  saveHubNote(note: { id?: string; title: string; content: string }): Promise<void>;
  deleteHubNote(id: string): Promise<void>;
  setHubDefaultModel(model: { endpointId: string; model: string } | null): Promise<void>;
  /** Confirms in a native dialog, then runs the agent's own `mcp add` command. */
  registerHub(target: HubRegistrationTarget): Promise<HubRegistrationOutcome>;
  /** Copies an MCP configuration snippet, including the hub token, to the clipboard. */
  copyHubConfig(): Promise<void>;

  getPreferences(): Promise<Preferences>;
  setTheme(theme: ThemePreference): Promise<void>;
  removeTrustedFolder(folder: string): Promise<void>;
  openDataFolder(): Promise<void>;
  /** Confirms in a native dialog; false if the user cancelled. */
  regenerateHubToken(): Promise<boolean>;

  listApiKeys(): Promise<ApiKeyInfo[]>;
  /** Checks the key with the provider, then stores it encrypted. */
  setApiKey(provider: ApiProviderId, key: string): Promise<void>;
  deleteApiKey(provider: ApiProviderId): Promise<void>;
  /** Chat models of a provider whose key is configured. */
  listApiModels(provider: ApiProviderId): Promise<ApiModelInfo[]>;
  /** Models the installed Claude Code offers, with the default first; cached for a while. */
  listClaudeModels(): Promise<ModelOption[]>;
  getUsage(): Promise<UsageOverview>;
  setBudgets(budgets: Budgets): Promise<void>;
  onUsageChanged(listener: (usage: UsageOverview) => void): () => void;
}
