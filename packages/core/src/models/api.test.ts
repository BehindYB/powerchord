import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listAnthropicModels, streamAnthropicChat } from './anthropic.ts';
import type { ChatStreamChunk } from './openai-compatible.ts';
import { estimateCost, findPrice } from './pricing.ts';

describe('pricing', () => {
  it('matches exact ids, dated snapshots and Gemini resource names only', () => {
    expect(findPrice('anthropic', 'claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    expect(findPrice('gemini', 'models/gemini-2.5-flash')).toEqual({ input: 0.3, output: 2.5 });
    expect(findPrice('openai', 'o3-pro')).toEqual({ input: 20, output: 80 });
    expect(findPrice('openai', 'o3-mini')).toBeNull();
    expect(findPrice('openai', 'unknown-model')).toBeNull();
  });

  it('applies long-prompt rates above the threshold', () => {
    const price = findPrice('gemini', 'gemini-2.5-pro')!;
    expect(estimateCost(price, 100_000, 0)).toBeCloseTo(0.125);
    expect(estimateCost(price, 300_000, 100_000)).toBeCloseTo(0.75 + 1.5);
  });
});

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe('Anthropic client', () => {
  it('streams text, thinking and usage with the key in x-api-key', async () => {
    let received: { key?: string; body?: Record<string, unknown> } = {};
    const baseUrl = await serve((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received = {
          key: request.headers['x-api-key'] as string,
          body: JSON.parse(body) as Record<string, unknown>,
        };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          {
            type: 'message_start',
            message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Hmm' },
          },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
          { type: 'message_delta', usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ];
        for (const event of events) {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
    });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of streamAnthropicChat(
      { baseUrl, apiKey: 'sk-test' },
      {
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: 'Hello' },
        ],
      },
    )) {
      chunks.push(chunk);
    }
    expect(received.key).toBe('sk-test');
    expect(received.body).toMatchObject({
      model: 'claude-haiku-5-5',
      system: 'Be brief',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(chunks).toEqual([
      { type: 'reasoning', text: 'Hmm' },
      { type: 'text', text: 'Hi' },
      { type: 'usage', usage: { inputTokens: 15, outputTokens: 7 } },
    ]);
  });

  it('reports API errors with their message', async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { message: 'invalid x-api-key' } }));
    });
    await expect(listAnthropicModels({ baseUrl, apiKey: 'bad' })).rejects.toThrow(
      /401.*invalid x-api-key/,
    );
  });
});
