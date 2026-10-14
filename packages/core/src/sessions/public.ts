/** Browser-safe entry point: session types and the transcript reducer, without Node.js APIs. */
export type {
  AgentQuestion,
  PermissionBehavior,
  QuestionAnswers,
  PermissionMode,
  SessionEvent,
  SessionState,
  SessionStatus,
  TranscriptItem,
  TurnSummary,
  UsageLimits,
  UsageWindow,
} from './types.ts';
export { createSessionState, parseAgentQuestions, QUESTION_TOOL_NAME } from './types.ts';
export { applySessionEvent, settleSessionState } from './transcript.ts';
