import { describe, expect, it } from 'vitest';
import { chatHistoryFromTranscript } from './model-chat/session.ts';
import { applySessionEvent, settleSessionState } from './transcript.ts';
import {
  createSessionState,
  parseAgentQuestions,
  type SessionEvent,
  type SessionState,
} from './types.ts';

function run(events: SessionEvent[], state: SessionState = createSessionState()): SessionState {
  return events.reduce(applySessionEvent, state);
}

describe('applySessionEvent', () => {
  it('tracks permission requests and their resolution', () => {
    const state = run([
      {
        type: 'permission-request',
        requestId: 'p1',
        toolName: 'Bash',
        input: { command: 'ls' },
        toolCallId: 't1',
      },
      { type: 'permission-resolved', requestId: 'p1', behavior: 'allow' },
    ]);
    expect(state.items).toEqual([
      {
        kind: 'permission',
        id: 'p1',
        toolName: 'Bash',
        input: { command: 'ls' },
        toolCallId: 't1',
        status: 'allow',
        answers: null,
      },
    ]);
  });

  it('closes open items when a turn is interrupted', () => {
    const state = run([
      { type: 'block-start', id: 'b1', kind: 'text' },
      { type: 'block-delta', id: 'b1', text: 'partial' },
      { type: 'tool-call', toolCallId: 't1', name: 'Bash', input: {} },
      {
        type: 'permission-request',
        requestId: 'p1',
        toolName: 'Bash',
        input: {},
        toolCallId: 't1',
      },
      { type: 'interrupted', id: 'i1' },
    ]);
    expect(state.items.map((item) => [item.kind, 'status' in item ? item.status : null])).toEqual([
      ['text', null],
      ['tool-call', 'error'],
      ['permission', 'deny'],
      ['interrupted', null],
    ]);
    expect(state.items[0]).toMatchObject({ text: 'partial', streaming: false });
  });

  it('returns the same state object for no-op events', () => {
    const state = createSessionState();
    expect(applySessionEvent(state, { type: 'block-delta', id: 'missing', text: 'x' })).toBe(state);
  });

  it('merges usage windows', () => {
    const state = run([
      { type: 'usage-limits', limits: { fiveHour: { utilization: 0.1, resetsAt: 1 } } },
      { type: 'usage-limits', limits: { sevenDay: { utilization: 0.2, resetsAt: 2 } } },
    ]);
    expect(state.usageLimits).toEqual({
      fiveHour: { utilization: 0.1, resetsAt: 1 },
      sevenDay: { utilization: 0.2, resetsAt: 2 },
    });
  });
});

describe('restored sessions', () => {
  const events: SessionEvent[] = [
    { type: 'status', status: 'running' },
    { type: 'user-message', id: 'u1', text: 'Hi' },
    { type: 'block-start', id: 'a1', kind: 'thinking' },
    { type: 'block-delta', id: 'a1', text: 'Greeting' },
    { type: 'block-end', id: 'a1' },
    { type: 'block-start', id: 'a2', kind: 'text' },
    { type: 'block-delta', id: 'a2', text: 'Hello' },
    { type: 'user-message', id: 'u2', text: 'Failed request' },
    { type: 'error', id: 'e1', message: 'Server unavailable' },
    { type: 'user-message', id: 'u3', text: 'Again' },
    { type: 'text', id: 'a3', kind: 'text', text: 'Sure' },
    {
      type: 'permission-request',
      requestId: 'p1',
      toolName: 'Bash',
      input: {},
      toolCallId: null,
    },
  ];

  it('closes open items and stops running', () => {
    const state = settleSessionState(run(events));
    expect(state.status).toBe('idle');
    expect(state.items.find((item) => item.id === 'a2')).toMatchObject({ streaming: false });
    expect(state.items.find((item) => item.id === 'p1')).toMatchObject({ status: 'deny' });
  });

  it('rebuilds chat history from answered messages only', () => {
    expect(chatHistoryFromTranscript(run(events).items)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Again' },
      { role: 'assistant', content: 'Sure' },
    ]);
  });
});

describe('parseAgentQuestions', () => {
  it('reads well-formed questions and skips malformed ones', () => {
    expect(
      parseAgentQuestions({
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres' }, 3],
            multiSelect: false,
          },
          { header: 'Missing question' },
        ],
      }),
    ).toEqual([
      {
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'SQLite', description: 'Embedded' },
          { label: 'Postgres', description: '' },
        ],
        multiSelect: false,
      },
    ]);
    expect(parseAgentQuestions(null)).toEqual([]);
  });
});
