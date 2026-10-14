import { spawn } from 'node:child_process';
import type { CommandSpec, Platform } from '../agents/types.ts';

// Arguments are embedded in a shell command line, so only plain tokens are accepted.
const SAFE_ARGUMENT = /^[\w@%+=:,./\\-]+$/;

function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    if (!SAFE_ARGUMENT.test(arg)) throw new Error(`Unsupported argument: ${JSON.stringify(arg)}`);
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function launchDetached(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export interface TerminalLaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: Platform;
}

/**
 * Opens a new terminal window running an interactive command, such as an agent's own sign-in
 * flow. The user interacts with the command directly; PowerChord does not read its output.
 */
export function openInTerminal(spec: CommandSpec, options: TerminalLaunchOptions): Promise<void> {
  assertSafeArguments(spec.args);
  const platform = options.platform ?? (process.platform as Platform);
  const launchOptions = { cwd: options.cwd, env: options.env ?? process.env };

  if (platform === 'win32') {
    const commandLine = ['&', quotePowerShell(spec.command), ...spec.args].join(' ');
    // A detached console process on Windows receives its own console window.
    return launchDetached('powershell.exe', ['-NoExit', '-Command', commandLine], launchOptions);
  }

  const shellLine = [
    `cd ${quotePosix(options.cwd)}`,
    [spec.command, ...spec.args].map(quotePosix).join(' '),
  ].join(' && ');

  const [file, args]: [string, string[]] =
    platform === 'darwin'
      ? [
          'osascript',
          [
            '-e',
            `tell application "Terminal" to do script ${quoteAppleScript(shellLine)}`,
            '-e',
            'tell application "Terminal" to activate',
          ],
        ]
      : ['x-terminal-emulator', ['-e', 'sh', '-c', `${shellLine}; exec "\${SHELL:-sh}"`]];

  return launchDetached(file, args, launchOptions);
}
