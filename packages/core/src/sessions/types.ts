/*
 * Agent-neutral session model. Adapters translate each agent's protocol into `SessionEvent`s,
 * and `applySessionEvent` folds them into a transcript. This module has no Node.js dependencies
 * so the renderer can use it too.
 */

export type SessionStatus = 'idle' | 'starting' | 'running' | 'stopped';

/** Claude Code permission modes. Other agents define their own modes as plain strings. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

export const CLAUDE_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
];

export type PermissionBehavior = 'allow' | 'deny';

/** Whether an approval covers one call or the rest of the session. */
export type PermissionScope = 'once' | 'session';

/** A model or mode an agent offers, as reported by the agent. */
export interface SessionOption {
  id: string;
  label: string;
  description?: string;
}

/** Operations PowerChord performs on a running agent session, whatever the agent. */
export interface AgentSession {
  send(text: string): void;
  interrupt(): void;
  /** Applies from the next turn. Null selects the agent's default model. */
  setModel(model: string | null): void;
  /** Applies from the next turn. Throws if the agent has no such mode. */
  setMode(mode: string): void;
  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    scope: PermissionScope,
  ): void;
  answerQuestion(requestId: string, answers: QuestionAnswers): void;
  /** Author name for hub changes made by the session. */
  setLabel(label: string): void;
  close(): void;
}

/** Tool through which Claude Code asks the user multiple-choice questions. */
export const QUESTION_TOOL_NAME = 'AskUserQuestion';

export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** Answers keyed by question text; multiple selections are joined with ", ". */
export type QuestionAnswers = Record<string, string>;

/** Reads the questions of an AskUserQuestion request, ignoring malformed entries. */
export function parseAgentQuestions(input: unknown): AgentQuestion[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((entry): AgentQuestion[] => {
    const value = entry as Record<string, unknown> | null;
    if (typeof value?.['question'] !== 'string' || !Array.isArray(value['options'])) return [];
    const options = value['options'].flatMap((option) => {
      const item = option as Record<string, unknown> | null;
      return typeof item?.['label'] === 'string'
        ? [
            {
              label: item['label'],
              description: typeof item['description'] === 'string' ? item['description'] : '',
            },
          ]
        : [];
    });
    return [
      {
        question: value['question'],
        header: typeof value['header'] === 'string' ? value['header'] : '',
        options,
        multiSelect: value['multiSelect'] === true,
      },
    ];
  });
}

export interface UsageWindow {
  /** Fraction of the window's allowance used, from 0 to 1. */
  utilization: number;
  /** Unix time in seconds when the window resets. */
  resetsAt: number;
}

export interface UsageLimits {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

export interface TurnSummary {
  isError: boolean;
  durationMs: number | null;
  /** Estimated cost reported by the agent. For subscriptions this is informational only. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus }
  | {
      type: 'session-info';
      agentSessionId: string;
      model: string | null;
      permissionMode: string | null;
      /** Models the agent offers, when it reports them. */
      availableModels?: SessionOption[];
      /** Modes the agent offers, when it reports them. */
      availableModes?: SessionOption[];
    }
  | { type: 'user-message'; id: string; text: string }
  | { type: 'block-start'; id: string; kind: 'text' | 'thinking' }
  | { type: 'block-delta'; id: string; text: string }
  | { type: 'block-end'; id: string }
  | { type: 'text'; id: string; kind: 'text' | 'thinking'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; output: string; isError: boolean }
  | {
      type: 'permission-request';
      requestId: string;
      toolName: string;
      input: unknown;
      toolCallId: string | null;
    }
  | {
      type: 'permission-resolved';
      requestId: string;
      behavior: PermissionBehavior;
      /** The user's answers when the request was a question from the agent. */
      answers?: QuestionAnswers;
    }
  | { type: 'turn-complete'; id: string; summary: TurnSummary }
  | { type: 'interrupted'; id: string }
  | { type: 'usage-limits'; limits: UsageLimits }
  | { type: 'error'; id: string; message: string };

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text' | 'thinking'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool-call';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'done' | 'error';
      output: string | null;
    }
  | {
      kind: 'permission';
      id: string;
      toolName: string;
      input: unknown;
      toolCallId: string | null;
      status: 'pending' | PermissionBehavior;
      answers: QuestionAnswers | null;
    }
  | { kind: 'turn-end'; id: string; summary: TurnSummary }
  | { kind: 'interrupted'; id: string }
  | { kind: 'error'; id: string; message: string };

export interface SessionState {
  status: SessionStatus;
  agentSessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  availableModels: SessionOption[] | null;
  availableModes: SessionOption[] | null;
  usageLimits: UsageLimits | null;
  items: TranscriptItem[];
}

export function createSessionState(): SessionState {
  return {
    status: 'idle',
    agentSessionId: null,
    model: null,
    permissionMode: null,
    availableModels: null,
    availableModes: null,
    usageLimits: null,
    items: [],
  };
}
