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

  it('ignores subagent traffic, malformed lines and unknown types', () => {
    const subagent = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { id: 'msg_9', content: [{ type: 'text', text: 'inner' }] },
    });
    expect(parseAll([subagent, 'not json', '{"type":"something_new"}', ''])).toEqual([]);
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
