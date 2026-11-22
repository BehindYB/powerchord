import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contextSizeFromArgs } from '../../models/context.ts';
import { startFakeModelServer, type FakeModelServer } from '../../test/fake-model-server.ts';
import { applySessionEvent } from '../transcript.ts';
import { createSessionState, type SessionEvent } from '../types.ts';
import {
  cleanSummary,
  COMPACTED_QUESTION,
  CONTINUE_NOTE,
  renderConversation,
  summaryRequest,
} from './compaction.ts';
import { chatHistoryFromTranscript, ModelChatSession } from './session.ts';

let server: FakeModelServer | null = null;
let folder: string | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = null;
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
}

type Request = { messages: { role: string; content: string }[]; tools?: unknown[] };

describe('compaction helpers', () => {
  it('render conversations as text and shorten tool output', () => {
    const text = renderConversation(
      [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: 'Read a' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"a"}' }],
        },
        { role: 'tool', toolCallId: '1', content: 'x'.repeat(50) },
        { role: 'assistant', content: 'Done' },
      ],
      20,
    );
    expect(text).toContain('User: Read a\n\n[Assistant called read_file {"path":"a"}]');
    expect(text).toContain('[Tool result]\nxxxxxxxxxxxxxx');
    expect(text).toContain('characters omitted');
    expect(text).toMatch(/Assistant: Done$/);
    expect(text).not.toContain('ignored');
  });

  it('fit the summary request into the context window', () => {
    const long = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i} ${'word '.repeat(20)}`,
    }));
    const [request] = summaryRequest(long, 1000);
    expect(request?.content.length).toBeLessThan(1000 * 4);
    expect(request?.content).toContain('[The earliest part of the conversation is omitted.]');
    expect(request?.content).toContain('message 199');
  });

  it('remove leftover reasoning from summaries', () => {
    expect(cleanSummary('<think>hmm</think>\n Notes ')).toBe('Notes');
  });

  it('read llama.cpp context sizes from router arguments', () => {
    expect(contextSizeFromArgs(['--model', 'x', '--ctx-size', '32768'])).toBe(32768);
    expect(contextSizeFromArgs(['-c', '8192'])).toBe(8192);
    expect(contextSizeFromArgs(['--ctx-size'])).toBeNull();
    expect(contextSizeFromArgs(undefined)).toBeNull();
  });
});

describe('ModelChatSession compaction', () => {
  it('reports context usage against the window', async () => {
    server = await startFakeModelServer({ answer: ['Hi', '!'] });
    const events: SessionEvent[] = [];
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      contextWindow: async () => 32768,
      onEvent: (event) => events.push(event),
    });
    session.send('Hello');
    await waitFor(() => events.some((event) => event.type === 'turn-complete'));
    const state = events.reduce(applySessionEvent, createSessionState());
    // The fake server counts 12 prompt tokens and one token per streamed chunk.
    expect(state.context).toEqual({ usedTokens: 14, windowTokens: 32768 });
    session.close();
  });

  it('compacts on request and continues from the summary', async () => {
    server = await startFakeModelServer({
      replies: [{ answer: ['Hi'] }, { answer: ['The user said hello.'] }, { answer: ['Sure'] }],
    });
    const events: SessionEvent[] = [];
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      onEvent: (event) => events.push(event),
    });
    const turns = () => events.filter((event) => event.type === 'turn-complete').length;
    expect(() => session.compact()).toThrow(/nothing to compact/);

    session.send('Hello');
    await waitFor(() => turns() === 1);
    session.compact();
    await waitFor(() => turns() === 2);
    session.send('Next');
    await waitFor(() => turns() === 3);

    const requests = server.chatRequests as Request[];
    expect(requests[1]?.messages).toHaveLength(1);
    expect(requests[1]?.messages[0]?.content).toContain('User: Hello\n\nAssistant: Hi');
    expect(requests[2]?.messages).toEqual([
      { role: 'user', content: COMPACTED_QUESTION },
      { role: 'assistant', content: 'The user said hello.' },
      { role: 'user', content: 'Next' },
    ]);

    const state = events.reduce(applySessionEvent, createSessionState());
    expect(state.items.find((item) => item.kind === 'compaction')).toMatchObject({
      status: 'done',
      automatic: false,
      summary: 'The user said hello.',
    });
    // A restored chat continues from the same summary.
    expect(chatHistoryFromTranscript(state.items)).toEqual([
      { role: 'user', content: COMPACTED_QUESTION },
      { role: 'assistant', content: 'The user said hello.' },
      { role: 'user', content: 'Next' },
      { role: 'assistant', content: 'Sure' },
    ]);
    session.close();
  });

  it('compacts automatically during a turn that fills the context', async () => {
    folder = await mkdtemp(join(tmpdir(), 'powerchord-compact-'));
    await writeFile(join(folder, 'a.txt'), 'alpha beta gamma delta epsilon zeta eta theta\n');
    const read = { name: 'read_file', arguments: '{"path":"a.txt"}' };
    server = await startFakeModelServer({
      replies: [
        { toolCalls: [read] },
        { toolCalls: [read] },
        { answer: ['Read a.txt twice.'] },
        { answer: ['Done'] },
      ],
    });
    const events: SessionEvent[] = [];
    const session = new ModelChatSession({
      endpoint: { baseUrl: server.baseUrl },
      model: 'qwen3:0.6b',
      workspace: { cwd: folder, env: process.env, mode: 'ask' },
      contextWindow: async () => 30,
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => events.some((event) => event.type === 'context-usage'));
    session.send('Read it twice');
    await waitFor(() => events.some((event) => event.type === 'turn-complete'));

    const requests = server.chatRequests as Request[];
    expect(requests).toHaveLength(4);
    expect(requests[2]?.tools).toBeUndefined();
    expect(requests[3]?.messages.slice(1)).toEqual([
      { role: 'user', content: COMPACTED_QUESTION },
      { role: 'assistant', content: 'Read a.txt twice.' },
      { role: 'user', content: `Read it twice\n\n${CONTINUE_NOTE}` },
    ]);
    const state = events.reduce(applySessionEvent, createSessionState());
    expect(state.items.map((item) => item.kind)).toEqual([
      'user',
      'tool-call',
      'tool-call',
      'compaction',
      'text',
      'turn-end',
    ]);
    expect(state.items[3]).toMatchObject({ automatic: true, status: 'done' });
    session.close();
  });
});
