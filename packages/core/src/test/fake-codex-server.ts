/*
 * Minimal Codex app-server for tests, run as `node fake-codex-server.ts app-server`.
 * Prompts: "hello" streams reasoning and a message; "run" requests approval for a command;
 * "wait" runs until interrupted; "whoami" reports the hub configuration. FAKE_SIGNED_OUT=1
 * reports a signed-out account.
 */
import { createInterface } from 'node:readline';

let nextId = 1000;
const waiting = new Map<number, (result: unknown) => void>();
let interrupt: (() => void) | null = null;
let hub = 'none';
let turnCount = 0;

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  write({ method, params: { threadId: 'thr_1', ...params } });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function message(turnId: string, id: string, text: string): void {
  notify('item/started', { turnId, item: { type: 'agentMessage', id, text: '' } });
  notify('item/agentMessage/delta', { turnId, itemId: id, delta: text });
  notify('item/completed', { turnId, item: { type: 'agentMessage', id, text } });
}

async function runTurn(turnId: string, input: string): Promise<void> {
  notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  if (input === 'wait') {
    await new Promise<void>((resolve) => (interrupt = resolve));
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted', error: null } });
    return;
  }
  if (input === 'whoami') {
    message(turnId, `${turnId}-msg`, hub);
  } else if (input === 'run') {
    const result = (await request('item/commandExecution/requestApproval', {
      threadId: 'thr_1',
      turnId,
      itemId: `${turnId}-cmd`,
      command: 'npm test',
      cwd: '/work',
      reason: null,
    })) as { decision: string };
    const accepted = result.decision === 'accept' || result.decision === 'acceptForSession';
    const item = {
      type: 'commandExecution',
      id: `${turnId}-cmd`,
      command: 'npm test',
      cwd: '/work',
    };
    notify('item/started', { turnId, item: { ...item, status: 'inProgress' } });
    notify('item/completed', {
      turnId,
      item: {
        ...item,
        status: accepted ? 'completed' : 'declined',
        aggregatedOutput: accepted ? `decision=${result.decision}` : null,
        exitCode: accepted ? 0 : null,
      },
    });
  } else {
    const reasoning = { type: 'reasoning', id: `${turnId}-r`, content: [] };
    notify('item/started', { turnId, item: { ...reasoning, summary: [] } });
    notify('item/reasoning/summaryTextDelta', {
      turnId,
      itemId: reasoning.id,
      delta: 'Thinking',
      summaryIndex: 0,
    });
    notify('item/completed', { turnId, item: { ...reasoning, summary: ['Thinking'] } });
    message(turnId, `${turnId}-msg`, 'Hello from Codex');
  }
  notify('thread/tokenUsage/updated', {
    turnId,
    tokenUsage: { last: { inputTokens: 10, outputTokens: 4 }, total: {}, modelContextWindow: null },
  });
  write({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
        secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1900500000 },
      },
    },
  });
  notify('turn/completed', { turn: { id: turnId, status: 'completed', error: null } });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return { userAgent: 'fake-codex/0.0.0' };
    case 'account/read':
      return process.env['FAKE_SIGNED_OUT']
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    case 'thread/start':
    case 'thread/resume': {
      const config = (params['config'] ?? {}) as Record<string, { bearer_token_env_var?: string }>;
      const [key] = Object.keys(config);
      const variable = key ? config[key]?.bearer_token_env_var : undefined;
      const token = variable && process.env[variable] ? 'set' : 'missing';
      hub = key ? `${key};token=${token};sandbox=${String(params['sandbox'])}` : 'none';
      return {
        thread: { id: method === 'thread/resume' ? params['threadId'] : 'thr_1' },
        model: params['model'] ?? 'gpt-test',
      };
    }
    case 'model/list':
      return {
        data: [
          { id: 'gpt-test', displayName: 'GPT Test', hidden: false },
          { id: 'gpt-hidden', displayName: 'Hidden', hidden: true },
        ],
        nextCursor: null,
      };
    case 'turn/start': {
      turnCount += 1;
      const turnId = `turn_${turnCount}`;
      const [input] = params['input'] as { text: string }[];
      setImmediate(() => void runTurn(turnId, input?.text ?? ''));
      return { turn: { id: turnId, status: 'inProgress', items: [], error: null } };
    }
    case 'turn/interrupt':
      interrupt?.();
      return {};
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const incoming = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  if (incoming.method && incoming.id !== undefined) {
    handle(incoming.method, incoming.params ?? {}).then(
      (result) => write({ id: incoming.id, result }),
      (error: Error) => write({ id: incoming.id, error: { code: -32601, message: error.message } }),
    );
    return;
  }
  if (incoming.method) return;
  if (incoming.id !== undefined) waiting.get(incoming.id)?.(incoming.result);
});
