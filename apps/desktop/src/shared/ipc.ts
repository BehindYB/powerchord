/**
 * Contract between the main process and the renderer.
 * Channel names and payload types live here so both sides stay in sync.
 */

export const IpcChannel = {
  GetAppInfo: 'app:get-info',
  ListAgents: 'agents:list',
  InstallAgent: 'agents:install',
  InstallOutput: 'agents:install-output',
  OpenAgentSignIn: 'agents:open-sign-in',
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
}
