import { join } from 'node:path';
import type { CommandResult } from '../system/run.ts';
import { getEnv } from '../system/search-path.ts';
import type { AgentDefinition, AgentId, AuthStatus, InstallMethod, Platform } from './types.ts';

/*
 * Every install method below comes from the vendor's own documentation, linked in `sourceUrl`.
 * Re-verify them before changing this file (see docs/COMPLIANCE.md).
 */

const ALL_PLATFORMS: readonly Platform[] = ['win32', 'darwin', 'linux'];
const UNIX_PLATFORMS: readonly Platform[] = ['darwin', 'linux'];

const SEMVER = /\d+\.\d+\.\d+(?:-[\w.]+)?/;

export function parseSemver(output: string): string | null {
  return SEMVER.exec(output)?.[0] ?? null;
}

function home(env: NodeJS.ProcessEnv, platform: Platform): string | undefined {
  return getEnv(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform);
}

function locations(...candidates: (string | undefined)[]): string[] {
  return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

function under(base: string | undefined, ...segments: string[]): string | undefined {
  return base === undefined ? undefined : join(base, ...segments);
}

function powershellScript(id: string, url: string, sourceUrl: string): InstallMethod {
  const script = `irm ${url} | iex`;
  return {
    id,
    label: 'Official installer (PowerShell)',
    platforms: ['win32'],
    display: script,
    command: {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    },
    requires: [],
    sourceUrl,
  };
}

function shellScript(
  id: string,
  url: string,
  shell: 'bash' | 'sh',
  sourceUrl: string,
): InstallMethod {
  const script = `curl -fsSL ${url} | ${shell}`;
  return {
    id,
    label: 'Official installer (shell)',
    platforms: UNIX_PLATFORMS,
    display: script,
    command: { command: 'bash', args: ['-c', script] },
    requires: ['curl'],
    sourceUrl,
  };
}

function npmGlobal(id: string, packageName: string, sourceUrl: string): InstallMethod[] {
  const args = ['install', '-g', packageName];
  const display = `npm ${args.join(' ')}`;
  return [
    {
      id,
      label: 'npm',
      platforms: ['win32'],
      display,
      command: { command: 'npm.cmd', args },
      requires: ['npm'],
      sourceUrl,
    },
    {
      id,
      label: 'npm',
      platforms: UNIX_PLATFORMS,
      display,
      command: { command: 'npm', args },
      requires: ['npm'],
      sourceUrl,
    },
  ];
}

function parseClaudeAuthStatus(result: CommandResult): AuthStatus {
  try {
    const status = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
    };
    if (status.loggedIn !== true) return { state: 'signed-out' };
    if (status.subscriptionType) {
      const plan = status.subscriptionType;
      return { state: 'signed-in', detail: `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` };
    }
    return status.authMethod
      ? { state: 'signed-in', detail: status.authMethod }
      : { state: 'signed-in' };
  } catch {
    return { state: 'unknown' };
  }
}

function parseCodexLoginStatus(result: CommandResult): AuthStatus {
  const message = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]?.trim();
  if (result.exitCode !== 0) return { state: 'signed-out' };
  return message ? { state: 'signed-in', detail: message } : { state: 'signed-in' };
}

const CLAUDE_DOCS = 'https://code.claude.com/docs/en/setup';
const CODEX_DOCS = 'https://github.com/openai/codex#installing-and-running-codex-cli';
const GEMINI_DOCS = 'https://geminicli.com/docs/get-started/installation';
const ANTIGRAVITY_DOCS = 'https://antigravity.google/docs/getting-started?tab=cli';

export const AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    integration: 'driven',
    docsUrl: CLAUDE_DOCS,
    executable: 'claude',
    knownLocations: (env, platform) => locations(under(home(env, platform), '.local', 'bin')),
    versionArgs: ['--version'],
    parseVersion: parseSemver,
    install: [
      powershellScript('official-installer', 'https://claude.ai/install.ps1', CLAUDE_DOCS),
      shellScript('official-installer', 'https://claude.ai/install.sh', 'bash', CLAUDE_DOCS),
      {
        id: 'winget',
        label: 'WinGet',
        platforms: ['win32'],
        display: 'winget install --id Anthropic.ClaudeCode -e',
        command: { command: 'winget.exe', args: ['install', '--id', 'Anthropic.ClaudeCode', '-e'] },
        requires: ['winget'],
        sourceUrl: CLAUDE_DOCS,
      },
      ...npmGlobal('npm', '@anthropic-ai/claude-code', CLAUDE_DOCS),
    ],
    loginArgs: ['auth', 'login'],
    authStatus: { args: ['auth', 'status'], parse: parseClaudeAuthStatus },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    integration: 'driven',
    docsUrl: CODEX_DOCS,
    executable: 'codex',
    knownLocations: (env, platform) =>
      platform === 'win32'
        ? locations(
            under(getEnv(env, 'LOCALAPPDATA', platform), 'Programs', 'OpenAI', 'Codex', 'bin'),
          )
        : locations(under(home(env, platform), '.local', 'bin')),
    versionArgs: ['--version'],
    parseVersion: parseSemver,
    install: [
      powershellScript('official-installer', 'https://chatgpt.com/codex/install.ps1', CODEX_DOCS),
      shellScript('official-installer', 'https://chatgpt.com/codex/install.sh', 'sh', CODEX_DOCS),
      ...npmGlobal('npm', '@openai/codex', CODEX_DOCS),
    ],
    loginArgs: ['login'],
    authStatus: { args: ['login', 'status'], parse: parseCodexLoginStatus },
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    vendor: 'Google',
    integration: 'driven',
    docsUrl: GEMINI_DOCS,
    executable: 'gemini',
    knownLocations: (env, platform) =>
      platform === 'win32' ? locations(under(getEnv(env, 'APPDATA', platform), 'npm')) : [],
    versionArgs: ['--version'],
    parseVersion: parseSemver,
    install: [...npmGlobal('npm', '@google/gemini-cli', GEMINI_DOCS)],
    // Gemini CLI signs in from its interactive session on first launch.
    loginArgs: [],
  },
  {
    id: 'antigravity-cli',
    displayName: 'Antigravity CLI',
    vendor: 'Google',
    // Antigravity's consumer terms do not allow third-party applications to drive `agy`.
    integration: 'launch-only',
    docsUrl: ANTIGRAVITY_DOCS,
    executable: 'agy',
    knownLocations: (env, platform) =>
      platform === 'win32'
        ? locations(under(getEnv(env, 'LOCALAPPDATA', platform), 'agy', 'bin'))
        : locations(under(home(env, platform), '.local', 'bin')),
    versionArgs: ['--version'],
    parseVersion: parseSemver,
    install: [
      powershellScript(
        'official-installer',
        'https://antigravity.google/cli/install.ps1',
        ANTIGRAVITY_DOCS,
      ),
      shellScript(
        'official-installer',
        'https://antigravity.google/cli/install.sh',
        'bash',
        ANTIGRAVITY_DOCS,
      ),
    ],
    // Antigravity CLI guides the user through sign-in on first launch.
    loginArgs: [],
  },
];

export function getAgent(id: AgentId): AgentDefinition {
  const agent = AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

export function isAgentId(value: string): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}

export function installMethodsFor(agent: AgentDefinition, platform: Platform): InstallMethod[] {
  return agent.install.filter((method) => method.platforms.includes(platform));
}

export { ALL_PLATFORMS };
