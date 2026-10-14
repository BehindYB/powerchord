import { spawn } from 'node:child_process';
import type { CommandSpec } from '../agents/types.ts';

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OutputStream = 'stdout' | 'stderr';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: OutputStream) => void;
}

// Batch-file arguments are interpreted by cmd.exe, so only plain tokens are accepted.
const SAFE_BATCH_ARGUMENT = /^[\w@%+=:,./\\-]+$/;

/** Translates a command into the form `child_process.spawn` can run on the current platform. */
export function toSpawnInvocation(
  spec: CommandSpec,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; verbatim: boolean } {
  const isBatchFile = platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command);
  if (!isBatchFile) {
    return { file: spec.command, args: [...spec.args], verbatim: false };
  }

  for (const arg of spec.args) {
    if (!SAFE_BATCH_ARGUMENT.test(arg)) {
      throw new Error(`Unsupported argument for a batch file: ${JSON.stringify(arg)}`);
    }
  }
  if (spec.command.includes('"')) {
    throw new Error(`Unsupported batch file path: ${spec.command}`);
  }
  const commandLine = [`"${spec.command}"`, ...spec.args].join(' ');
  // Resolve cmd.exe by absolute path; the child's PATH may not include the system directory.
  const shell = process.env['ComSpec'] ?? 'cmd.exe';
  return { file: shell, args: ['/d', '/s', '/c', `"${commandLine}"`], verbatim: true };
}

/**
 * Runs a command attached to the current terminal so the user can interact with it directly.
 * Resolves with the exit code.
 */
export function runInteractive(
  spec: CommandSpec,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number | null> {
  const { file, args, verbatim } = toSpawnInvocation(spec);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsVerbatimArguments: verbatim,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

/**
 * Runs a command to completion, capturing its output. Resolves for any exit code; rejects only
 * when the process cannot be started.
 */
export function runCommand(spec: CommandSpec, options: RunOptions = {}): Promise<CommandResult> {
  const { file, args, verbatim } = toSpawnInvocation(spec);

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      signal: options.signal,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      options.onOutput?.(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      options.onOutput?.(chunk, 'stderr');
    });

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}
