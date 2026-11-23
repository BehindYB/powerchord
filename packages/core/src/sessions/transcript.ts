import {
  createSessionState,
  type SessionEvent,
  type SessionState,
  type TranscriptItem,
} from './types.ts';

function replaceItem(
  items: TranscriptItem[],
  id: string,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return items;
  const next = items.slice();
  next[index] = update(items[index]!);
  return next;
}

function hasItem(items: TranscriptItem[], id: string): boolean {
  return items.some((item) => item.id === id);
}

function withItems(state: SessionState, items: TranscriptItem[]): SessionState {
  return items === state.items ? state : { ...state, items };
}

/** Applies a subagent's event to the tool call that started it, at any depth. */
function applyToToolCall(
  items: TranscriptItem[],
  toolCallId: string,
  event: SessionEvent,
): TranscriptItem[] {
  let changed = false;
  const next = items.map((item): TranscriptItem => {
    if (changed || item.kind !== 'tool-call') return item;
    if (item.id === toolCallId) {
      changed = true;
      const nested = applySessionEvent(
        { ...createSessionState(), items: item.children ?? [] },
        event,
      );
      return { ...item, children: nested.items };
    }
    if (item.children) {
      const children = applyToToolCall(item.children, toolCallId, event);
      if (children !== item.children) {
        changed = true;
        return { ...item, children };
      }
    }
    return item;
  });
  return changed ? next : items;
}

/** Folds one event into the session state. Pure: returns a new state, sharing unchanged items. */
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
  const { items } = state;

  switch (event.type) {
    case 'status':
      return { ...state, status: event.status };

    case 'session-info':
      return {
        ...state,
        agentSessionId: event.agentSessionId,
        model: event.model ?? state.model,
        permissionMode: event.permissionMode ?? state.permissionMode,
        availableModels: event.availableModels ?? state.availableModels,
        availableModes: event.availableModes ?? state.availableModes,
      };

    case 'usage-limits':
      return { ...state, usageLimits: { ...state.usageLimits, ...event.limits } };

    case 'context-usage':
      return {
        ...state,
        context: { usedTokens: event.usedTokens, windowTokens: event.windowTokens },
      };

    case 'compaction-start':
      return withItems(state, [
        ...items,
        {
          kind: 'compaction',
          id: event.id,
          status: 'running',
          automatic: event.automatic,
          tokensBefore: event.tokensBefore,
          summary: null,
        },
      ]);

    case 'compaction-end':
      return withItems(
        state,
        replaceItem(items, event.id, (item) =>
          item.kind === 'compaction'
            ? { ...item, status: event.summary === null ? 'error' : 'done', summary: event.summary }
            : item,
        ),
      );

    case 'user-message':
      return withItems(state, [...items, { kind: 'user', id: event.id, text: event.text }]);

    case 'block-start':
      if (hasItem(items, event.id)) return state;
      return withItems(state, [
        ...items,
        { kind: event.kind, id: event.id, text: '', streaming: true },
      ]);

    case 'block-delta':
      return withItems(
        state,
        replaceItem(items, event.id, (item) =>
          item.kind === 'text' || item.kind === 'thinking'
            ? { ...item, text: item.text + event.text }
            : item,
        ),
      );

    case 'block-end':
      return withItems(
        state,
        replaceItem(items, event.id, (item) =>
          item.kind === 'text' || item.kind === 'thinking' ? { ...item, streaming: false } : item,
        ),
      );

    case 'text':
      // Complete blocks arrive after their streamed deltas; keep the streamed item if present.
      if (hasItem(items, event.id)) {
        return withItems(
          state,
          replaceItem(items, event.id, (item) =>
            item.kind === 'text' || item.kind === 'thinking'
              ? { ...item, text: event.text, streaming: false }
              : item,
          ),
        );
      }
      return withItems(state, [
        ...items,
        { kind: event.kind, id: event.id, text: event.text, streaming: false },
      ]);

    case 'tool-call':
      if (hasItem(items, event.toolCallId)) {
        return withItems(
          state,
          replaceItem(items, event.toolCallId, (item) =>
            item.kind === 'tool-call' ? { ...item, name: event.name, input: event.input } : item,
          ),
        );
      }
      return withItems(state, [
        ...items,
        {
          kind: 'tool-call',
          id: event.toolCallId,
          name: event.name,
          input: event.input,
          status: 'running',
          output: null,
        },
      ]);

    case 'tool-result':
      return withItems(
        state,
        replaceItem(items, event.toolCallId, (item) =>
          item.kind === 'tool-call'
            ? { ...item, status: event.isError ? 'error' : 'done', output: event.output }
            : item,
        ),
      );

    case 'permission-request':
      return withItems(state, [
        ...items,
        {
          kind: 'permission',
          id: event.requestId,
          toolName: event.toolName,
          input: event.input,
          toolCallId: event.toolCallId,
          status: 'pending',
          answers: null,
        },
      ]);

    case 'permission-resolved':
      return withItems(
        state,
        replaceItem(items, event.requestId, (item) =>
          item.kind === 'permission'
            ? { ...item, status: event.behavior, answers: event.answers ?? null }
            : item,
        ),
      );

    case 'turn-complete':
      return withItems(state, [
        ...finishOpenItems(items),
        { kind: 'turn-end', id: event.id, summary: event.summary },
      ]);

    case 'interrupted':
      return withItems(state, [...finishOpenItems(items), { kind: 'interrupted', id: event.id }]);

    case 'error':
      return withItems(state, [...items, { kind: 'error', id: event.id, message: event.message }]);

    case 'agent-entry': {
      if (!event.prompt) return { ...state, lastAgentEntryId: event.id };
      // The entry of a sent message belongs to the latest user message without one.
      let index = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.kind === 'user') {
          if (!item.agentRef) index = i;
          break;
        }
      }
      const next = items.slice();
      if (index >= 0) {
        const item = items[index] as Extract<TranscriptItem, { kind: 'user' }>;
        next[index] = {
          ...item,
          agentRef: { promptId: event.id, resumeAt: state.lastAgentEntryId },
        };
      }
      // A new turn continues the conversation, so a pending rewind point is no longer needed.
      return {
        ...state,
        items: index >= 0 ? next : items,
        lastAgentEntryId: event.id,
        resumeAt: null,
      };
    }

    case 'subagent-event':
      return withItems(state, applyToToolCall(items, event.parentToolCallId, event.event));

    case 'rewound': {
      const index = items.findIndex((item) => item.id === event.itemId);
      if (index === -1) return state;
      return {
        ...state,
        items: items.slice(0, index),
        agentSessionId: event.resetConversation ? null : state.agentSessionId,
        lastAgentEntryId: event.resumeAt,
        resumeAt: event.resumeAt,
        context: null,
      };
    }
  }
}

/**
 * Prepares a saved session for display after a restart: nothing is running any more, so open
 * blocks, prompts and tool calls are closed.
 */
export function settleSessionState(state: SessionState): SessionState {
  return {
    ...state,
    // Files saved by earlier versions lack these fields.
    availableModels: state.availableModels ?? null,
    availableModes: state.availableModes ?? null,
    context: state.context ?? null,
    lastAgentEntryId: state.lastAgentEntryId ?? null,
    resumeAt: state.resumeAt ?? null,
    status: 'idle',
    items: finishOpenItems(state.items),
  };
}

/** Marks streaming blocks and unanswered prompts as finished when a turn ends. */
function finishOpenItems(items: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const next = items.map((item): TranscriptItem => {
    if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    if (item.kind === 'permission' && item.status === 'pending') {
      changed = true;
      return { ...item, status: 'deny' };
    }
    if (item.kind === 'compaction' && item.status === 'running') {
      changed = true;
      return { ...item, status: 'error' };
    }
    if (item.kind === 'tool-call') {
      const children = item.children ? finishOpenItems(item.children) : item.children;
      if (item.status === 'running' || children !== item.children) {
        changed = true;
        return {
          ...item,
          ...(children ? { children } : {}),
          ...(item.status === 'running'
            ? { status: 'error' as const, output: item.output ?? 'Not completed' }
            : {}),
        };
      }
    }
    return item;
  });
  return changed ? next : items;
}
