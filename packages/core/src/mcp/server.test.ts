import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_TOOL_NAME, PowerChordMcpServer, type PermissionRequest } from './server.ts';

let server: PowerChordMcpServer;

beforeEach(async () => {
  server = new PowerChordMcpServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

async function callPermissionTool(url: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  try {
    const result = await client.callTool({ name: PERMISSION_TOOL_NAME, arguments: args });
    const [block] = result.content as { type: string; text: string }[];
    return JSON.parse(block!.text);
  } finally {
    await client.close();
  }
}

describe('PowerChordMcpServer', () => {
  it('routes permission prompts to the registered client', async () => {
    const received: PermissionRequest[] = [];
    const registration = server.register({
      requestPermission: async (request) => {
        received.push(request);
        return { behavior: 'allow' };
      },
    });

    const decision = await callPermissionTool(registration.url, {
      tool_name: 'Write',
      input: { file_path: 'a.txt' },
      tool_use_id: 'toolu_1',
    });

    expect(received).toEqual([
      { toolName: 'Write', input: { file_path: 'a.txt' }, toolCallId: 'toolu_1' },
    ]);
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { file_path: 'a.txt' } });
  });

  it('returns denials with their message', async () => {
    const registration = server.register({
      requestPermission: async () => ({ behavior: 'deny', message: 'No' }),
    });
    const decision = await callPermissionTool(registration.url, { tool_name: 'Bash', input: {} });
    expect(decision).toEqual({ behavior: 'deny', message: 'No' });
  });

  it('rejects unknown tokens, disposed clients and browser requests', async () => {
    const registration = server.register({
      requestPermission: async () => ({ behavior: 'allow' }),
    });
    const unknown = registration.url.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    expect((await fetch(unknown, { method: 'POST', body: '{}' })).status).toBe(404);

    const fromBrowser = await fetch(registration.url, {
      method: 'POST',
      body: '{}',
      headers: { Origin: 'https://example.com' },
    });
    expect(fromBrowser.status).toBe(403);

    registration.dispose();
    expect((await fetch(registration.url, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
