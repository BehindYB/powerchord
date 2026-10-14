import { describe, expect, it } from 'vitest';
import { applySessionEvent } from './transcript.ts';
import { createSessionState, type SessionEvent, type SessionState } from './types.ts';

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
