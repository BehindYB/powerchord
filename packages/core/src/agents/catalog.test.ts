import { describe, expect, it } from 'vitest';
import { AGENTS, getAgent, installMethodsFor, parseSemver } from './catalog.ts';
import type { Platform } from './types.ts';

const PLATFORMS: Platform[] = ['win32', 'darwin', 'linux'];

describe('agent catalog', () => {
  it('uses unique agent ids', () => {
    const ids = AGENTS.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(AGENTS.flatMap((agent) => PLATFORMS.map((platform) => [agent.id, platform] as const)))(
    '%s has an install method on %s',
    (id, platform) => {
      expect(installMethodsFor(getAgent(id), platform).length).toBeGreaterThan(0);
    },
  );

  it('installs only over HTTPS from vendor domains', () => {
    const allowedHosts = ['claude.ai', 'chatgpt.com', 'antigravity.google'];
    for (const method of AGENTS.flatMap((agent) => agent.install)) {
      for (const url of method.display.match(/https?:\/\/[^\s|]+/g) ?? []) {
        const { protocol, hostname } = new URL(url);
        expect(protocol).toBe('https:');
        expect(allowedHosts).toContain(hostname);
      }
    }
  });

  it('marks Antigravity CLI as launch-only', () => {
    expect(getAgent('antigravity-cli').integration).toBe('launch-only');
  });
});

describe('parseSemver', () => {
  it.each([
    ['2.1.299 (Claude Code)', '2.1.299'],
    ['codex-cli 0.153.4', '0.153.4'],
    ['0.65.0-nightly.20261014', '0.65.0-nightly.20261014'],
    ['no version here', null],
  ])('parses %j', (input, expected) => {
    expect(parseSemver(input)).toBe(expected);
  });
});

describe('Claude Code auth status', () => {
  const parse = getAgent('claude-code').authStatus!.parse;
  const result = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

  it('reports the subscription plan', () => {
    expect(
      parse(result('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "pro"}')),
    ).toEqual({ state: 'signed-in', detail: 'Pro plan' });
  });

  it('reports signed out', () => {
    expect(parse(result('{"loggedIn": false, "authMethod": "none"}'))).toEqual({
      state: 'signed-out',
    });
  });

  it('reports unknown for unexpected output', () => {
    expect(parse(result('not json'))).toEqual({ state: 'unknown' });
  });
});
