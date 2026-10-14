import { runCommand } from '../system/run.ts';
import { findExecutable, mergeDirectories, resolveSearchPath } from '../system/search-path.ts';
import { AGENTS, installMethodsFor } from './catalog.ts';
import type {
  AgentDefinition,
  AgentId,
  AuthStatus,
  InstallMethod,
  IntegrationMode,
  Platform,
} from './types.ts';

export interface AgentStatus {
  id: AgentId;
  displayName: string;
  vendor: string;
  integration: IntegrationMode;
  docsUrl: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Null when the agent is not installed or offers no status query. */
  auth: AuthStatus | null;
  installMethods: InstallMethod[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: Platform;
  /** Precomputed search path; resolved from the environment when omitted. */
  searchPath?: readonly string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function currentPlatform(): Platform {
  const { platform } = process;
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Environment for processes PowerChord starts. PATH is replaced with the full search path so
 * tools installed after PowerChord started (and their runtimes, such as Node.js) are found.
 */
export function buildChildEnv(
  searchPath: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = currentPlatform(),
): NodeJS.ProcessEnv {
  const pathKey =
    platform === 'win32'
      ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path')
      : 'PATH';
  return { ...env, [pathKey]: searchPath.join(platform === 'win32' ? ';' : ':') };
}

export async function agentSearchPath(
  agent: AgentDefinition,
  options: DetectOptions = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const base = options.searchPath ?? (await resolveSearchPath(env, platform));
  return mergeDirectories([base, agent.knownLocations(env, platform)], platform);
}

export async function detectAgent(
  agent: AgentDefinition,
  options: DetectOptions = {},
): Promise<AgentStatus> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const searchPath = await agentSearchPath(agent, { ...options, env, platform });
  const childEnv = buildChildEnv(searchPath, env, platform);

  const status: AgentStatus = {
    id: agent.id,
    displayName: agent.displayName,
    vendor: agent.vendor,
    integration: agent.integration,
    docsUrl: agent.docsUrl,
    installed: false,
    path: null,
    version: null,
    auth: null,
    installMethods: installMethodsFor(agent, platform),
  };

  const path = await findExecutable(agent.executable, searchPath, platform);
  if (!path) return status;
  status.installed = true;
  status.path = path;

  try {
    const result = await runCommand(
      { command: path, args: agent.versionArgs },
      { env: childEnv, timeoutMs },
    );
    status.version = agent.parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    // The executable exists but could not be started; report it without a version.
  }

  if (agent.authStatus) {
    try {
      const result = await runCommand(
        { command: path, args: agent.authStatus.args },
        { env: childEnv, timeoutMs },
      );
      status.auth = result.timedOut ? { state: 'unknown' } : agent.authStatus.parse(result);
    } catch {
      status.auth = { state: 'unknown' };
    }
  }

  return status;
}

/** Detects every catalog agent, resolving the search path once. */
export async function detectAgents(options: DetectOptions = {}): Promise<AgentStatus[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const searchPath = options.searchPath ?? (await resolveSearchPath(env, platform));
  return Promise.all(
    AGENTS.map((agent) => detectAgent(agent, { ...options, env, platform, searchPath })),
  );
}
