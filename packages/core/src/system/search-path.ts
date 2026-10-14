import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { runCommand } from './run.ts';

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

const WINDOWS_PATH_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
];

/** Reads an environment variable, ignoring case on Windows as the OS does. */
export function getEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Expands `%NAME%` references; unknown variables are left untouched, as Windows does. */
export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => getEnv(env, name, 'win32') ?? match);
}

/** Extracts the `Path` value from `reg query <key> /v Path` output. */
export function parseRegistryPath(output: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return match?.[1]?.trim() ?? null;
}

/**
 * Reads the persisted user and machine PATH from the registry. A process inherits PATH when it
 * starts, so this picks up directories added by installers that ran afterwards.
 */
async function readWindowsRegistryPath(env: NodeJS.ProcessEnv): Promise<string[]> {
  const entries: string[] = [];
  for (const key of WINDOWS_PATH_KEYS) {
    try {
      const result = await runCommand(
        { command: 'reg.exe', args: ['query', key, '/v', 'Path'] },
        { timeoutMs: 5000 },
      );
      const value = result.exitCode === 0 ? parseRegistryPath(result.stdout) : null;
      if (value) entries.push(...splitPath(expandWindowsVariables(value, env), 'win32'));
    } catch {
      // The registry is a best-effort supplement to the inherited PATH.
    }
  }
  return entries;
}

function splitPath(value: string, platform: NodeJS.Platform): string[] {
  const separator = platform === 'win32' ? ';' : delimiter;
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Merges directory lists, dropping duplicates (case-insensitively on Windows). */
export function mergeDirectories(
  lists: readonly (readonly string[])[],
  platform: NodeJS.Platform,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const directory of lists.flat()) {
    const normalized = directory.replace(/[\\/]+$/, '');
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (normalized.length === 0 || seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

/** Directories to search for executables: the inherited PATH plus, on Windows, the persisted PATH. */
export async function resolveSearchPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const inherited = splitPath(getEnv(env, 'PATH', platform) ?? '', platform);
  const persisted = platform === 'win32' ? await readWindowsRegistryPath(env) : [];
  return mergeDirectories([inherited, persisted], platform);
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds the first matching executable in the given directories, or null. */
export async function findExecutable(
  name: string,
  directories: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates =
    platform === 'win32'
      ? WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => name + extension)
      : [name];
  for (const directory of directories) {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if (await isExecutable(path, platform)) return path;
    }
  }
  return null;
}
