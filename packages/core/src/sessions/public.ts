/** Browser-safe entry point: session types and the transcript reducer, without Node.js APIs. */
export type {
  PermissionBehavior,
  PermissionMode,
  SessionEvent,
  SessionState,
  SessionStatus,
  TranscriptItem,
  TurnSummary,
  UsageLimits,
  UsageWindow,
} from './types.ts';
export { createSessionState } from './types.ts';
export { applySessionEvent } from './transcript.ts';
