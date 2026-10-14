import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore } from '../hub/store.ts';
import type { LocalModelGateway } from '../hub/tools.ts';
import {
  PERMISSION_TOOL_NAME,
  PowerChordMcpServer,
  type McpClientRegistration,
  type PermissionRequest,
} from './server.ts';

let server: PowerChordMcpServer;
let directory: string;

beforeEach(async () => {
  server = new PowerChordMcpServer();
  await server.start();
  directory = await mkdtemp(join(tmpdir(), 'powerchord-mcp-'));
});

afterEach(async () => {
  await server.stop();
  await rm(directory, { recursive: true, force: true });
});

async function withClient<T>(
  registration: McpClientRegistration,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(registration.url), {
    requestInit: { headers: registration.headers },
  });
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

async function callTool(
  registration: McpClientRegistration,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return withClient(registration, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    const [block] = result.content as { type: string; text: string }[];
    return { text: block!.text, isError: result.isError === true };
  });
}

describe('PowerChordMcpServer', () => {
  it('routes permission prompts to the registered client', async () => {
    const received: PermissionRequest[] = [];
    const registration = server.register({
      label: 'Session',
      requestPermission: async (request) => {
        received.push(request);
        return { behavior: 'allow' };
      },
    });

    const result = await callTool(registration, PERMISSION_TOOL_NAME, {
      tool_name: 'Write',
      input: { file_path: 'a.txt' },
      tool_use_id: 'toolu_1',
    });

    expect(received).toEqual([
      { toolName: 'Write', input: { file_path: 'a.txt' }, toolCallId: 'toolu_1' },
    ]);
    expect(JSON.parse(result.text)).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'a.txt' },
    });
  });

  it('returns denials with their message', async () => {
    const registration = server.register({
      label: 'Session',
      requestPermission: async () => ({ behavior: 'deny', message: 'No' }),
    });
    const result = await callTool(registration, PERMISSION_TOOL_NAME, {
      tool_name: 'Bash',
      input: {},
    });
    expect(JSON.parse(result.text)).toEqual({ behavior: 'deny', message: 'No' });
  });

  it('rejects missing or unknown tokens, disposed clients and browser requests', async () => {
    const registration = server.register({ label: 'Session', hub: true });
    const post = (headers: Record<string, string>) =>
      fetch(registration.url, { method: 'POST', body: '{}', headers });

    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post({ ...registration.headers, Origin: 'https://example.com' })).status).toBe(
      403,
    );

    registration.dispose();
    expect((await post(registration.headers)).status).toBe(401);
  });

  it('keeps a client token stable when one is supplied', () => {
    const token = 'a'.repeat(64);
    expect(server.register({ label: 'External' }, token).token).toBe(token);
    expect(() => server.register({ label: 'External' }, 'short')).toThrow(/Invalid token/);
  });

  it('falls back to a free port when the preferred one is taken', async () => {
    const other = new PowerChordMcpServer();
    const port = Number(new URL(server.url).port);
    const result = await other.start({ preferredPort: port });
    expect(result.usedPreferredPort).toBe(false);
    expect(result.port).not.toBe(port);
    await other.stop();
  });
});

describe('hub tools', () => {
  const models: LocalModelGateway = {
    listModels: async () => [{ server: 'Ollama on 10.0.0.5', models: ['qwen3:0.6b'] }],
    complete: async (request) => ({
      server: 'Ollama on 10.0.0.5',
      model: request.model ?? 'qwen3:0.6b',
      text: `echo: ${request.prompt}`,
    }),
  };

  it('are offered only to hub clients', async () => {
    server.setHub({ store: new HubStore(join(directory, 'hub.json')), models });
    const names = (registration: McpClientRegistration) =>
      withClient(registration, async (client) =>
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
      );

    expect(
      await names(
        server.register({ label: 'Plain', requestPermission: async () => ({ behavior: 'allow' }) }),
      ),
    ).toEqual([PERMISSION_TOOL_NAME]);
    expect(await names(server.register({ label: 'Hub', hub: true }))).toEqual([
      'add_task',
      'ask_local_model',
      'get_task',
      'list_local_models',
      'list_notes',
      'list_tasks',
      'read_note',
      'update_task',
      'write_note',
    ]);
  });

  it('share tasks and notes between clients and record authors', async () => {
    const store = new HubStore(join(directory, 'hub.json'));
    server.setHub({ store, models });
    const claude = server.register({ label: 'Claude Code: plan', hub: true });
    const antigravity = server.register({ label: 'Antigravity', hub: true });

    const created = JSON.parse(
      (await callTool(claude, 'add_task', { title: 'Build login page' })).text,
    );
    await callTool(antigravity, 'update_task', {
      id: created.id,
      status: 'done',
      summary: 'Implemented',
    });
    await callTool(claude, 'write_note', { title: 'Decisions', content: 'Use OAuth' });

    const { tasks, notes } = await new HubStore(join(directory, 'hub.json')).snapshot();
    expect(tasks).toMatchObject([
      {
        title: 'Build login page',
        status: 'done',
        summary: 'Implemented',
        createdBy: 'Claude Code: plan',
        updatedBy: 'Antigravity',
      },
    ]);
    expect(notes).toMatchObject([
      { title: 'Decisions', content: 'Use OAuth', updatedBy: 'Claude Code: plan' },
    ]);

    const missing = await callTool(antigravity, 'get_task', { id: 'nope' });
    expect(missing).toEqual({ text: 'No task with id nope', isError: true });
  });

  it('delegate prompts to local models', async () => {
    server.setHub({ store: new HubStore(join(directory, 'hub.json')), models });
    const client = server.register({ label: 'Claude Code', hub: true });
    const result = await callTool(client, 'ask_local_model', { prompt: 'Summarize this' });
    expect(result.text).toBe('[qwen3:0.6b on Ollama on 10.0.0.5]\n\necho: Summarize this');
  });
});
