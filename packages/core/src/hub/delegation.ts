/*
 * Delegation between agents: an agent asks PowerChord to start another agent or model in a chat of
 * its own (a sub-chat), in the same project folder, and receives its answer. The sub-chat is an
 * ordinary PowerChord session the user can open, follow and answer permission prompts in; the
 * agents it runs are the same official, unmodified ones the user starts by hand.
 */

/** An agent or model a delegation can start. */
export interface DelegationTarget {
  /** Value for the `agent` argument: an agent id, `local:<endpoint id>` or `api:<provider>`. */
  agent: string;
  name: string;
  /** Models to choose from; empty when the agent picks its own default. */
  models: string[];
  /** Whether `model` must be given. */
  modelRequired: boolean;
}

export type DelegationStatus = 'completed' | 'running' | 'failed' | 'interrupted';

export interface DelegationResult {
  /** PowerChord session id of the sub-chat, for follow-ups and waits. */
  sessionId: string;
  title: string;
  agent: string;
  status: DelegationStatus;
  /** Whether the sub-chat is waiting for the user to answer a permission prompt or question. */
  waitingForUser: boolean;
  /** The sub-chat's answer in its latest turn so far. */
  response: string;
  error: string | null;
}

export interface DelegationRequest {
  /** PowerChord session that delegates; null for agents outside PowerChord. */
  parentSessionId: string | null;
  /** Project folder for clients without a session. */
  folder: string | null;
  /** Name of the delegating client, shown to the user. */
  author: string;
  agent: string;
  model: string | null;
  prompt: string;
  waitMs: number;
  /** Stops waiting early, for example when the delegating turn is interrupted. */
  signal?: AbortSignal;
}

/** Starts and follows sub-chats; implemented by the desktop app. */
export interface AgentDelegationGateway {
  targets(): Promise<DelegationTarget[]>;
  /** Starts a sub-chat with the prompt as its first message. */
  start(request: DelegationRequest): Promise<DelegationResult>;
  /** Sends a follow-up message to a sub-chat this session started. */
  send(request: {
    parentSessionId: string | null;
    sessionId: string;
    prompt: string;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<DelegationResult>;
  /** Waits for a sub-chat's current turn to finish, up to `waitMs`. */
  wait(request: {
    parentSessionId: string | null;
    sessionId: string;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<DelegationResult>;
}

/** Delegation for one session, as a model chat uses it. */
export interface SessionDelegation {
  gateway: AgentDelegationGateway;
  parentSessionId: string;
  folder: string;
  author: () => string;
}

/**
 * Longest single wait. Agents time out tool calls (Gemini CLI after ten minutes by default), so
 * longer work is followed with repeated waits.
 */
export const MAX_DELEGATION_WAIT_SECONDS = 540;
export const DEFAULT_DELEGATION_WAIT_SECONDS = 300;

export function delegationWaitMs(seconds: unknown): number {
  const value =
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? seconds
      : DEFAULT_DELEGATION_WAIT_SECONDS;
  return Math.round(Math.min(Math.max(value, 1), MAX_DELEGATION_WAIT_SECONDS) * 1000);
}

export const DELEGATION_TOOL_TEXT = {
  list: {
    name: 'list_agents',
    description:
      'Lists the coding agents and models PowerChord can start for delegate_to_agent, with their ' +
      'models.',
  },
  delegate: {
    name: 'delegate_to_agent',
    description:
      'Delegates work to another coding agent or model. PowerChord opens a sub-chat with it in the ' +
      'same project folder, which the user can follow, and returns its answer. Write a complete, ' +
      'self-contained prompt: the other agent does not see this conversation. Pass session_id to ' +
      'send a follow-up to a sub-chat you started. If the answer is not ready within wait_seconds, ' +
      'the result says "running"; call wait_for_agent to keep waiting. The sub-chat may pause ' +
      'until the user approves its actions.',
    agent: 'Agent from list_agents, such as "claude-code", "codex" or "local:<id>"',
    model: 'Model id; optional for coding agents, which use their default',
    prompt: 'Complete task description, including the context the agent needs',
    sessionId: 'Session id of an earlier sub-chat, to continue it instead of starting a new one',
    wait: `Seconds to wait for the answer (1-${MAX_DELEGATION_WAIT_SECONDS}, default ${DEFAULT_DELEGATION_WAIT_SECONDS})`,
  },
  wait: {
    name: 'wait_for_agent',
    description:
      'Waits for a sub-chat started with delegate_to_agent to finish its current turn and ' +
      'returns its answer.',
    sessionId: 'Session id returned by delegate_to_agent',
  },
} as const;

/** Text returned to the delegating agent. */
export function formatDelegationResult(result: DelegationResult): string {
  return JSON.stringify(
    {
      session_id: result.sessionId,
      title: result.title,
      agent: result.agent,
      status: result.status,
      ...(result.waitingForUser
        ? {
            note: 'The sub-chat is waiting for the user to approve an action or answer a question.',
          }
        : {}),
      ...(result.error ? { error: result.error } : {}),
      response: result.response,
    },
    null,
    2,
  );
}

/** Finds the session id in a delegation tool result, for linking to the sub-chat. */
export function delegationSessionId(output: string | null): string | null {
  return /"session_id":\s*"([0-9a-f-]{36})"/.exec(output ?? '')?.[1] ?? null;
}
