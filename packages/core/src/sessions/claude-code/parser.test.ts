import { describe, expect, it } from 'vitest';
import { applySessionEvent } from '../transcript.ts';
import { createSessionState, type SessionEvent } from '../types.ts';
import { ClaudeStreamParser } from './parser.ts';

const SESSION = '0df6bd6a-f600-4d5b-887c-7b02ffa031fa';

function stream(messageId: string, event: object): string {
  return JSON.stringify({
    type: 'stream_event',
    event,
    session_id: SESSION,
    parent_tool_use_id: null,
    api_message_id: messageId,
  });
}

/** A turn shaped like real Claude Code output: a tool call, its result, then a text answer. */
const TURN = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: SESSION,
    model: 'claude-haiku-5-5',
    permissionMode: 'default',
  }),
  stream('msg_1', { type: 'message_start', message: { id: 'msg_1' } }),
  stream('msg_1', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} },
  }),
  stream('msg_1', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
  }),
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: 'msg_1',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Write',
          input: { file_path: 'hello.txt', content: 'hi' },
        },
      ],
    },
  }),
  stream('msg_1', { type: 'content_block_stop', index: 0 }),
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: 0.37, resetsAt: 1792000800 },
        seven_day: { utilization: 0.05, resetsAt: 1792443600 },
      },
    },
  }),
  JSON.stringify({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'File created' }],
    },
  }),
  stream('msg_2', { type: 'message_start', message: { id: 'msg_2' } }),
  stream('msg_2', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  stream('msg_2', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'DO' },
  }),
  stream('msg_2', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'NE' },
  }),
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_2', content: [{ type: 'text', text: 'DONE' }] },
  }),
  stream('msg_2', { type: 'content_block_stop', index: 0 }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 3922,
    total_cost_usd: 0.008,
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 168,
    },
    result: 'DONE',
    uuid: 'result-1',
  }),
];

function parseAll(lines: string[]): SessionEvent[] {
  const parser = new ClaudeStreamParser();
  return lines.flatMap((line) => parser.parseLine(line));
}

describe('ClaudeStreamParser', () => {
  it('builds a transcript from a full turn', () => {
    const state = parseAll(TURN).reduce(applySessionEvent, createSessionState());

    expect(state.agentSessionId).toBe(SESSION);
    expect(state.model).toBe('claude-haiku-5-5');
    expect(state.usageLimits).toEqual({
      fiveHour: { utilization: 0.37, resetsAt: 1792000800 },
      sevenDay: { utilization: 0.05, resetsAt: 1792443600 },
    });
    expect(state.items).toEqual([
      {
        kind: 'tool-call',
        id: 'toolu_1',
        name: 'Write',
        input: { file_path: 'hello.txt', content: 'hi' },
        status: 'done',
        output: 'File created',
      },
      { kind: 'text', id: 'msg_2:0', text: 'DONE', streaming: false },
      {
        kind: 'turn-end',
        id: 'result-1',
        summary: {
          isError: false,
          durationMs: 3922,
          costUsd: 0.008,
          inputTokens: 34,
          outputTokens: 168,
        },
      },
    ]);
  });

  it('streams text before the complete message arrives', () => {
    const lines = TURN.slice(0, 12);
    const state = parseAll(lines).reduce(applySessionEvent, createSessionState());
    expect(state.items.at(-1)).toEqual({
      kind: 'text',
      id: 'msg_2:0',
      text: 'DONE',
      streaming: true,
    });
  });

  it('ignores malformed lines and unknown types', () => {
    expect(parseAll(['not json', '{"type":"something_new"}', ''])).toEqual([]);
  });

  it('shows subagent work inside the tool call that started it', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'assistant',
        uuid: 'entry-1',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'sub-1',
        parent_tool_use_id: 'toolu_agent',
        message: {
          id: 'msg_9',
          content: [
            { type: 'text', text: 'Looking around' },
            { type: 'tool_use', id: 'toolu_inner', name: 'Read', input: { file_path: 'a.ts' } },
          ],
          usage: { input_tokens: 99_999, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: 'toolu_agent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'code' }],
        },
      }),
    ]);
    // Subagent requests do not change the main conversation's context usage.
    expect(events.some((event) => event.type === 'context-usage')).toBe(false);
    const state = events.reduce(applySessionEvent, createSessionState());
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'tool-call',
      id: 'toolu_agent',
      children: [
        { kind: 'text', text: 'Looking around' },
        { kind: 'tool-call', id: 'toolu_inner', name: 'Read', status: 'done', output: 'code' },
      ],
    });
  });

  it('links sent messages to their entries and rewinds to them', () => {
    const user = (text: string) => ({ type: 'user-message', id: text, text }) as SessionEvent;
    let state = createSessionState();
    const apply = (events: SessionEvent[]) => {
      for (const event of events) state = applySessionEvent(state, event);
    };
    const parser = new ClaudeStreamParser();
    const replay = (uuid: string) =>
      JSON.stringify({
        type: 'user',
        uuid,
        isReplay: true,
        parent_tool_use_id: null,
        message: { content: [] },
      });
    const answer = (uuid: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parent_tool_use_id: null,
        message: { id: uuid, content: [] },
      });

    apply([user('first'), ...parser.parseLine(replay('p1')), ...parser.parseLine(answer('a1'))]);
    apply([user('second'), ...parser.parseLine(replay('p2')), ...parser.parseLine(answer('a2'))]);
    expect(state.items.map((item) => (item.kind === 'user' ? item.agentRef : null))).toEqual([
      { promptId: 'p1', resumeAt: null },
      { promptId: 'p2', resumeAt: 'a1' },
    ]);

    apply([{ type: 'rewound', itemId: 'second', resumeAt: 'a1', resetConversation: false }]);
    expect(state.items.map((item) => item.id)).toEqual(['first']);
    expect(state.resumeAt).toBe('a1');
    apply([user('again'), ...parser.parseLine(replay('p3'))]);
    expect(state.resumeAt).toBeNull();
    expect(state.items.at(-1)).toMatchObject({ agentRef: { promptId: 'p3', resumeAt: 'a1' } });
  });

  it('reports context usage, the context window and compactions', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: SESSION,
        model: 'claude-opus-5-5',
        permissionMode: 'default',
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'Hi' }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 30000,
            output_tokens: 90,
          },
        },
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        uuid: 'r1',
        modelUsage: {
          'claude-haiku-5-5': { contextWindow: 200000 },
          'claude-opus-5-5': { contextWindow: 1000000 },
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'c1',
        compact_metadata: { trigger: 'manual', pre_tokens: 32100 },
      }),
    ]);
    const contexts = events.filter((event) => event.type === 'context-usage');
    expect(contexts).toEqual([
      { type: 'context-usage', usedTokens: 32100, windowTokens: null },
      { type: 'context-usage', usedTokens: 32100, windowTokens: 1000000 },
    ]);
    const state = events.reduce(applySessionEvent, createSessionState());
    expect(state.items.at(-1)).toEqual({
      kind: 'compaction',
      id: 'c1',
      status: 'done',
      automatic: false,
      tokensBefore: 32100,
      summary: '',
    });
  });

  it('reports failed turns as errors', () => {
    const events = parseAll([
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Not logged in',
        uuid: 'r2',
      }),
    ]);
    expect(events[0]).toEqual({ type: 'error', id: 'r2:error', message: 'Not logged in' });
    expect(events[1]).toMatchObject({ type: 'turn-complete', summary: { isError: true } });
  });
});
