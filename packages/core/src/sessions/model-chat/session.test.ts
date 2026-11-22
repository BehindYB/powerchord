import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeModelServer, type FakeModelServer } from '../../test/fake-model-server.ts';
import { applySessionEvent } from '../transcript.ts';
import { createSessionState, type ModelChatMode, type SessionEvent } from '../types.ts';
import { ModelChatSession } from './session.ts';

let server: FakeModelServer | null = null;
let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'powerchord-chat-'));
  await writeFile(join(folder, 'notes.txt'), 'remember the milk\n');
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(folder, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
}

function startSession(mode: ModelChatMode) {
  const events: SessionEvent[] = [];
  const session = new ModelChatSession({
    endpoint: { baseUrl: server!.baseUrl },
    model: 'qwen3:0.6b',
    workspace: { cwd: folder, env: process.env, mode },
    onEvent: (event) => events.push(event),
  });
  const state = () => events.reduce(applySessionEvent, createSessionState());
  const turns = () => events.filter((event) => event.type === 'turn-complete').length;
  return { session, events, state, turns };
}

type Request = { messages: Record<string, unknown>[]; tools?: unknown[] };

describe('ModelChatSession with a project folder', () => {
  it('runs read tools without asking and returns their output to the model', async () => {
    server = await startFakeModelServer({
      replies: [
        { toolCalls: [{ id: 'call_a', name: 'read_file', arguments: '{"path":"notes.txt"}' }] },
        { answer: ['It says to buy milk.'] },
      ],
    });
    const { session, state, turns } = startSession('ask');
    session.send('What do my notes say?');
    await waitFor(() => turns() === 1);

    expect(state().permissionMode).toBe('ask');
    expect(state().availableModes?.map((mode) => mode.id)).toEqual([
      'ask',
      'auto-edit',
      'full-access',
    ]);
    expect(state().items.map((item) => item.kind)).toEqual([
      'user',
      'tool-call',
      'text',
      'turn-end',
    ]);
    expect(state().items[1]).toMatchObject({ name: 'read_file', status: 'done' });

    const [first, second] = server.chatRequests as Request[];
    expect(first?.tools).toHaveLength(7);
    expect(first?.messages[0]).toMatchObject({ role: 'system' });
    expect(second?.messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '1  remember the milk' },
    ]);
    session.close();
  });

  it('asks before changes and respects the answer', async () => {
    const write = { name: 'write_file', arguments: '{"path":"out.txt","content":"hi"}' };
    server = await startFakeModelServer({
      replies: [{ toolCalls: [write] }, { answer: ['Done'] }, { toolCalls: [write] }, {}],
    });
    const { session, events, state, turns } = startSession('ask');

    session.send('Write the file');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const request = events.find((event) => event.type === 'permission-request');
    if (request?.type !== 'permission-request') throw new Error('No permission request');
    expect(request.toolName).toBe('write_file');
    session.respondToPermission(request.requestId, 'deny', 'once');
    await waitFor(() => turns() === 1);
    expect(state().items.find((item) => item.kind === 'tool-call')).toMatchObject({
      status: 'error',
      output: 'The user denied this action.',
    });
    await expect(readFile(join(folder, 'out.txt'), 'utf8')).rejects.toThrow();

    session.setMode('auto-edit');
    session.send('Try again');
    await waitFor(() => turns() === 2);
    expect(await readFile(join(folder, 'out.txt'), 'utf8')).toBe('hi');
    expect(events.filter((event) => event.type === 'permission-request')).toHaveLength(1);
    session.close();
  });

  it('remembers tools allowed for the session', async () => {
    const command = { name: 'run_command', arguments: '{"command":"echo one"}' };
    server = await startFakeModelServer({
      replies: [{ toolCalls: [command] }, { toolCalls: [command] }, { answer: ['ok'] }],
    });
    const { session, events, turns } = startSession('auto-edit');
    session.send('Run it twice');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const request = events.find((event) => event.type === 'permission-request');
    if (request?.type !== 'permission-request') throw new Error('No permission request');
    session.respondToPermission(request.requestId, 'allow', 'session');
    await waitFor(() => turns() === 1);
    expect(events.filter((event) => event.type === 'permission-request')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool-result' && !event.isError)).toHaveLength(
      2,
    );
    session.close();
  }, 20_000);

  it('can be stopped while waiting for approval and keeps the history valid', async () => {
    const write = { id: 'call_w', name: 'write_file', arguments: '{"path":"x","content":""}' };
    server = await startFakeModelServer({ replies: [{ toolCalls: [write] }, { answer: ['ok'] }] });
    const { session, events, state, turns } = startSession('ask');
    session.send('Write');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    session.interrupt();
    await waitFor(() => state().status === 'idle');
    expect(events.some((event) => event.type === 'interrupted')).toBe(true);
    expect(state().items.find((item) => item.kind === 'permission')).toMatchObject({
      status: 'deny',
    });

    session.send('Never mind');
    await waitFor(() => turns() === 1);
    const last = (server.chatRequests as Request[]).at(-1);
    expect(last?.messages.slice(2).map((message) => message['role'])).toEqual([
      'assistant',
      'tool',
      'user',
    ]);
    session.close();
  });

  it('reports malformed tool calls to the model instead of failing', async () => {
    server = await startFakeModelServer({
      replies: [
        { toolCalls: [{ id: 'bad', name: 'read_file', arguments: '{"path":' }] },
        { answer: ['Sorry'] },
      ],
    });
    const { session, state, turns } = startSession('ask');
    session.send('Read');
    await waitFor(() => turns() === 1);
    expect(state().items[1]).toMatchObject({
      status: 'error',
      output: 'The arguments are not a valid JSON object.',
    });
    const second = (server.chatRequests as Request[])[1];
    expect(second?.messages[2]).toMatchObject({
      tool_calls: [{ function: { arguments: '{}' } }],
    });
    session.close();
  });

  it('offers no tools and no modes without a project folder', async () => {
    server = await startFakeModelServer({ answer: ['Hi'] });
    const events: SessionEvent[] = [];
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      onEvent: (event) => events.push(event),
    });
    session.send('Hello');
    await waitFor(() => events.some((event) => event.type === 'turn-complete'));
    const state = events.reduce(applySessionEvent, createSessionState());
    expect(state.permissionMode).toBeNull();
    expect((server.chatRequests[0] as Request).tools).toBeUndefined();
    expect(() => session.setMode('ask')).toThrow();
    session.close();
  });
});
