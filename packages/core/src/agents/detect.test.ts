import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSemver } from './catalog.ts';
import { currentPlatform, detectAgent } from './detect.ts';
import type { AgentDefinition } from './types.ts';

const platform = currentPlatform();
let directory: string;

/** Writes a fake agent executable that prints a version or a JSON auth status. */
async function writeFakeAgent(dir: string): Promise<void> {
  if (platform === 'win32') {
    await writeFile(
      join(dir, 'fake-agent.cmd'),
      [
        '@echo off',
        'if "%1"=="--version" echo 1.2.3 (Fake Agent)',
        'if "%1"=="status" echo {"loggedIn": true}',
        '',
      ].join('\r\n'),
    );
    return;
  }
  const path = join(dir, 'fake-agent');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "1.2.3 (Fake Agent)"; fi',
      'if [ "$1" = "status" ]; then echo \'{"loggedIn": true}\'; fi',
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
}

function fakeAgent(executable: string): AgentDefinition {
  return {
    id: 'codex',
    displayName: 'Fake Agent',
    vendor: 'Test',
    integration: 'driven',
    docsUrl: 'https://example.com',
    executable,
    knownLocations: () => [directory],
    versionArgs: ['--version'],
    parseVersion: parseSemver,
    install: [],
    loginArgs: ['login'],
    authStatus: {
      args: ['status'],
      parse: (result) =>
        (JSON.parse(result.stdout) as { loggedIn: boolean }).loggedIn
          ? { state: 'signed-in' }
          : { state: 'signed-out' },
    },
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'powerchord-detect-'));
  await writeFakeAgent(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('detectAgent', () => {
  it('finds an agent in its known location and reads its version and auth status', async () => {
    const status = await detectAgent(fakeAgent('fake-agent'), { searchPath: [] });
    expect(status.installed).toBe(true);
    expect(status.path?.startsWith(directory)).toBe(true);
    expect(status.version).toBe('1.2.3');
    expect(status.auth).toEqual({ state: 'signed-in' });
  });

  it('reports agents that are not installed', async () => {
    const status = await detectAgent(fakeAgent('missing-agent'), { searchPath: [] });
    expect(status).toMatchObject({ installed: false, path: null, version: null, auth: null });
  });
});
