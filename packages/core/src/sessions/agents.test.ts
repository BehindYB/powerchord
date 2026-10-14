import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PowerChordMcpServer } from '../mcp/server.ts';
import { AcpSession, readableErrorMessage } from './acp/session.ts';
import { CodexSession } from './codex/session.ts';
import { applySessionEvent } from './transcript.ts';
import {
  createSessionState,
  type AgentSession,
  type SessionEvent,
  type SessionState,
} from './types.ts';

const FAKE_ACP = fileURLToPath(new URL('../test/fake-acp-agent.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../test/fake-codex-server.ts', import.meta.url));

let mcp: PowerChordMcpServer;
const sessions: AgentSession[] = [];

beforeEach(async () => {
  mcp = new PowerChordMcpServer();
  await mcp.start();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await mcp.stop();
});

/** Collects a session's events and folds them into a transcript. */
function recorder() {
  const events: SessionEvent[] = [];
  let state: SessionState = createSessionState();
  const waiters: { test: () => boolean; resolve: () => void }[] = [];
  const onEvent = (event: SessionEvent) => {
    events.push(event);
    state = applySessionEvent(state, event);
    for (const waiter of [...waiters]) {
      if (waiter.test()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const until = (test: (state: SessionState, events: SessionEvent[]) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => test(state, events);
      if (check()) return resolve();
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for session events')),
        10_000,
      );
      waiters.push({
        test: check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  const turns = () => state.items.filter((item) => item.kind === 'turn-end').length;
  return {
    onEvent,
    until,
    turns,
    get state() {
      return state;
    },
    events,
  };
}

function lastText(state: SessionState): string {
  const texts = state.items.filter((item) => item.kind === 'text');
  const last = texts[texts.length - 1];
  return last?.kind === 'text' ? last.text : '';
}

describe('AcpSession', () => {
  function create(record: ReturnType<typeof recorder>, resumeSessionId?: string) {
    const session = new AcpSession({
      agentName: 'Fake agent',
      command: { command: process.execPath, args: [FAKE_ACP] },
      cwd: process.cwd(),
      env: process.env,
      mcp,
      model: 'model-b',
      mode: null,
      authMethodId: 'test-key',
      hubTools: true,
      onEvent: record.onEvent,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    sessions.push(session);
    return session;
  }

  it('streams a turn, asks for permission and reports the agent options', async () => {
    const record = recorder();
    const session = create(record);
    session.send('hello');
    await record.until((state) => state.items.some((item) => item.kind === 'permission'));
    const permission = record.state.items.find((item) => item.kind === 'permission')!;
    expect(permission).toMatchObject({ toolName: 'Write a.txt', input: { path: 'a.txt' } });
    session.respondToPermission(permission.id, 'allow', 'session');
    await record.until(() => record.turns() === 1);

    const { state } = record;
    expect(state.agentSessionId).toBe('sess_1');
    expect(state.model).toBe('model-b');
    expect(state.availableModes?.map((mode) => mode.id)).toEqual(['default', 'yolo']);
    expect(state.availableModels?.map((model) => model.label)).toEqual(['Model A', 'Model B']);
    expect(state.items.map((item) => item.kind)).toEqual([
      'user',
      'thinking',
      'text',
      'tool-call',
      'permission',
      'text',
      'turn-end',
    ]);
    expect(state.items.find((item) => item.kind === 'tool-call')).toMatchObject({
      name: 'Edit',
      status: 'done',
      output: 'decision=always',
    });
    expect(lastText(state)).toBe('Done');
    expect(state.status).toBe('idle');
  });

  it('authenticates with the chosen method and offers the hub', async () => {
    const record = recorder();
    create(record).send('whoami');
    await record.until(() => record.turns() === 1);
    expect(lastText(record.state)).toBe('auth=test-key;mcp=powerchord');
  });

  it('cancels a running turn', async () => {
    const record = recorder();
    const session = create(record);
    session.send('wait');
    await record.until((state) => state.status === 'running');
    session.interrupt();
    await record.until((state) => state.items.some((item) => item.kind === 'interrupted'));
    await record.until((state) => state.status === 'idle');
  });

  it('loads an earlier session without replaying it into the transcript', async () => {
    const record = recorder();
    create(record, 'sess_old').send('whoami');
    await record.until(() => record.turns() === 1);
    expect(record.state.agentSessionId).toBe('sess_old');
    expect(record.state.items.map((item) => item.kind)).toEqual(['user', 'text', 'turn-end']);
  });
});

describe('CodexSession', () => {
  function create(record: ReturnType<typeof recorder>, env: NodeJS.ProcessEnv = process.env) {
    const session = new CodexSession({
      command: { command: process.execPath, args: [FAKE_CODEX] },
      cwd: process.cwd(),
      env,
      mcp,
      model: null,
      mode: 'auto',
      hubTools: true,
      onEvent: record.onEvent,
    });
    sessions.push(session);
    return session;
  }

  it('streams reasoning and messages, with usage and plan limits', async () => {
    const record = recorder();
    create(record).send('hello');
    await record.until(() => record.turns() === 1);
    const { state } = record;
    expect(state.agentSessionId).toBe('thr_1');
    expect(state.model).toBe('gpt-test');
    expect(state.permissionMode).toBe('auto');
    expect(state.availableModels).toEqual([{ id: 'gpt-test', label: 'GPT Test' }]);
    expect(state.items.map((item) => item.kind)).toEqual(['user', 'thinking', 'text', 'turn-end']);
    expect(lastText(state)).toBe('Hello from Codex');
    expect(state.items.at(-1)).toMatchObject({ summary: { inputTokens: 10, outputTokens: 4 } });
    expect(state.usageLimits).toEqual({
      fiveHour: { utilization: 0.25, resetsAt: 1900000000 },
      sevenDay: { utilization: 0.05, resetsAt: 1900500000 },
    });
  });

  it('routes command approvals to the user', async () => {
    const record = recorder();
    const session = create(record);
    session.send('run');
    await record.until((state) => state.items.some((item) => item.kind === 'permission'));
    const permission = record.state.items.find((item) => item.kind === 'permission')!;
    expect(permission).toMatchObject({ toolName: 'Run', input: { command: 'npm test' } });
    session.respondToPermission(permission.id, 'allow', 'once');
    await record.until(() => record.turns() === 1);
    expect(record.state.items.find((item) => item.kind === 'tool-call')).toMatchObject({
      name: 'Run',
      status: 'done',
      output: 'decision=accept',
    });
  });

  it('passes the hub through an environment variable', async () => {
    const record = recorder();
    create(record).send('whoami');
    await record.until(() => record.turns() === 1);
    expect(lastText(record.state)).toBe('mcp_servers.powerchord;token=set;sandbox=workspace-write');
  });

  it('interrupts a running turn', async () => {
    const record = recorder();
    const session = create(record);
    session.send('wait');
    await record.until(
      (state, events) =>
        events.some((event) => event.type === 'session-info') && state.status === 'running',
    );
    // The turn id arrives with turn/started, shortly after the turn begins.
    await new Promise((resolve) => setTimeout(resolve, 100));
    session.interrupt();
    await record.until((state) => state.items.some((item) => item.kind === 'interrupted'));
    await record.until((state) => state.status === 'idle');
  });

  it('asks the user to sign in when Codex has no account', async () => {
    const record = recorder();
    create(record, { ...process.env, FAKE_SIGNED_OUT: '1' }).send('hello');
    await record.until(() => record.turns() === 1);
    expect(record.state.items.find((item) => item.kind === 'error')).toMatchObject({
      message: expect.stringContaining('not signed in'),
    });
  });
});

describe('readableErrorMessage', () => {
  it('unwraps API errors nested in JSON strings', () => {
    const inner = JSON.stringify({ error: { code: 400, message: 'API key not valid.' } });
    expect(readableErrorMessage(JSON.stringify({ error: { message: inner } }))).toBe(
      'API key not valid.',
    );
    expect(readableErrorMessage('Plain failure')).toBe('Plain failure');
  });
});
