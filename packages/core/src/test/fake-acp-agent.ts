/*
 * Minimal Agent Client Protocol agent for tests, run as `node fake-acp-agent.ts`.
 * Prompts: "hello" streams a thought, a message and a tool call that needs permission;
 * "wait" runs until cancelled; "whoami" reports the authentication method and MCP servers.
 */
import { createInterface } from 'node:readline';

let nextId = 1000;
const waiting = new Map<number, (result: unknown) => void>();
let cancel: (() => void) | null = null;
let authMethod = 'none';
let mcpNames: string[] = [];

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(sessionId: string, value: Record<string, unknown>): void {
  write({ method: 'session/update', params: { sessionId, update: value } });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const text = (value: string) => ({ type: 'text', text: value });

async function prompt(sessionId: string, input: string): Promise<unknown> {
  if (input === 'wait') {
    await new Promise<void>((resolve) => (cancel = resolve));
    return { stopReason: 'cancelled' };
  }
  if (input === 'whoami') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: text(`auth=${authMethod};mcp=${mcpNames.join(',')}`),
    });
    return { stopReason: 'end_turn' };
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: text('Planning') });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Hello ') });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('there') });
  const toolCall = {
    toolCallId: 'call_1',
    title: 'Write a.txt',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: 'a.txt' }],
  };
  update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
  const decision = (await request('session/request_permission', {
    sessionId,
    toolCall,
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  })) as { outcome: { outcome: string; optionId?: string } };
  const allowed = decision.outcome.optionId === 'yes' || decision.outcome.optionId === 'always';
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: allowed ? 'completed' : 'failed',
    content: [{ type: 'content', content: text(`decision=${decision.outcome.optionId}`) }],
  });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Done') });
  return { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 5 } };
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        authMethods: [{ id: 'test-key', name: 'Test key' }],
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      };
    case 'authenticate':
      authMethod = String(params['methodId']);
      return {};
    case 'session/new':
    case 'session/load': {
      mcpNames = (params['mcpServers'] as { name: string }[]).map((server) => server.name);
      const sessionId = method === 'session/load' ? String(params['sessionId']) : 'sess_1';
      if (method === 'session/load') {
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('replayed') });
      }
      return {
        sessionId,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'yolo', name: 'YOLO', description: 'Approve everything' },
          ],
        },
        models: {
          currentModelId: 'model-a',
          availableModels: [
            { modelId: 'model-a', name: 'Model A' },
            { modelId: 'model-b', name: 'Model B' },
          ],
        },
      };
    }
    case 'session/set_model':
    case 'session/set_mode':
      return {};
    case 'session/prompt': {
      const [block] = params['prompt'] as { text: string }[];
      return prompt(String(params['sessionId']), block?.text ?? '');
    }
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  if (message.method === 'session/cancel') {
    cancel?.();
    return;
  }
  if (message.method && message.id !== undefined) {
    handle(message.method, message.params ?? {}).then(
      (result) => write({ id: message.id, result }),
      (error: Error) => write({ id: message.id, error: { code: -32601, message: error.message } }),
    );
    return;
  }
  if (message.id !== undefined) waiting.get(message.id)?.(message.result);
});
