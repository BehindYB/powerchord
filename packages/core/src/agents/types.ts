import type { CommandResult } from '../system/run.ts';

export type Platform = 'win32' | 'darwin' | 'linux';

export type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'antigravity-cli';

/**
 * How PowerChord may interact with an agent (see docs/COMPLIANCE.md).
 * - `driven`: PowerChord starts agent sessions and exchanges messages with them.
 * - `launch-only`: PowerChord may install and launch the agent, but the user operates it
 *   through the agent's own interface.
 */
export type IntegrationMode = 'driven' | 'launch-only';

export interface CommandSpec {
  command: string;
  args: readonly string[];
}

export interface InstallMethod {
  id: string;
  label: string;
  platforms: readonly Platform[];
  /** The command exactly as a user would type it; shown before asking for confirmation. */
  display: string;
  command: CommandSpec;
  /** Executables that must be available before this method can run, such as `npm`. */
  requires: readonly string[];
  /** Vendor page documenting this installation method. */
  sourceUrl: string;
}

export type AuthState = 'signed-in' | 'signed-out' | 'unknown';

export interface AuthStatus {
  state: AuthState;
  /** Short, user-facing description such as the plan or sign-in method. */
  detail?: string;
}

export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  vendor: string;
  integration: IntegrationMode;
  docsUrl: string;
  /** Executable name without extension. */
  executable: string;
  /** Directories the official installers use, searched in addition to PATH. */
  knownLocations(env: NodeJS.ProcessEnv, platform: Platform): string[];
  versionArgs: readonly string[];
  parseVersion(output: string): string | null;
  install: readonly InstallMethod[];
  /** Arguments that start the agent's own interactive sign-in flow. */
  loginArgs: readonly string[];
  /** Optional read-only status query provided by the agent CLI itself. */
  authStatus?: {
    args: readonly string[];
    parse(result: CommandResult): AuthStatus;
  };
}
