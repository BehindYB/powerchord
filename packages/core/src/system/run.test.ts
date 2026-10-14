import { describe, expect, it } from 'vitest';
import { runCommand, toSpawnInvocation } from './run.ts';

describe('toSpawnInvocation', () => {
  it('runs executables directly', () => {
    expect(
      toSpawnInvocation({ command: 'C:\\bin\\agent.exe', args: ['--version'] }, 'win32'),
    ).toEqual({
      file: 'C:\\bin\\agent.exe',
      args: ['--version'],
      verbatim: false,
    });
  });

  it('wraps batch files in cmd.exe with quoting', () => {
    expect(
      toSpawnInvocation(
        { command: 'C:\\Program Files\\npm\\gemini.cmd', args: ['--version'] },
        'win32',
      ),
    ).toEqual({
      file: expect.stringMatching(/cmd\.exe$/i),
      args: ['/d', '/s', '/c', '""C:\\Program Files\\npm\\gemini.cmd" --version"'],
      verbatim: true,
    });
  });

  it('rejects batch file arguments with shell metacharacters', () => {
    expect(() => toSpawnInvocation({ command: 'tool.cmd', args: ['a & calc'] }, 'win32')).toThrow(
      /Unsupported argument/,
    );
  });
});

describe('runCommand', () => {
  it('captures output and exit code', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false });
  });

  it('stops commands that exceed the timeout', async () => {
    const result = await runCommand(
      { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      { timeoutMs: 200 },
    );
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the executable does not exist', async () => {
    await expect(runCommand({ command: 'powerchord-missing-binary', args: [] })).rejects.toThrow();
  });
});
