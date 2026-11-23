/** Browser-safe entry point: session types and the transcript reducer, without Node.js APIs. */
export type {
  AgentQuestion,
  AgentTurnRef,
  ContextPart,
  ContextUsage,
  PermissionBehavior,
  QuestionAnswers,
  ModelChatMode,
  PermissionMode,
  SessionEvent,
  SessionState,
  SessionStatus,
  TranscriptItem,
  TurnSummary,
  UsageLimits,
  UsageWindow,
} from './types.ts';
export {
  CLAUDE_PERMISSION_MODES,
  createSessionState,
  isModelChatMode,
  MODEL_CHAT_AUTO_COMPACT_AT,
  MODEL_CHAT_MODES,
  parseAgentQuestions,
  QUESTION_TOOL_NAME,
} from './types.ts';
export { applySessionEvent, settleSessionState } from './transcript.ts';
export { delegationSessionId, DELEGATION_TOOL_TEXT } from '../hub/delegation.ts';
