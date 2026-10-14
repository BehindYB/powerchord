import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CommandSpec } from '../agents/types.ts';
import { toSpawnInvocation } from './run.ts';

/** Starts a long-running agent process with piped stdio and no console window. */
export function spawnAgentProcess(
  spec: CommandSpec,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const { file, args, verbatim } = toSpawnInvocation(spec);
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Ends a process together with the commands it started. */
export function stopProcessTree(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGINT');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }, 3000).unref();
}
