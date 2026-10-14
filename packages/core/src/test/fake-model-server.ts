import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A minimal OpenAI-compatible server for tests. */
export interface FakeModelServer {
  baseUrl: string;
  port: number;
  /** Request bodies received on /v1/chat/completions. */
  chatRequests: unknown[];
  close(): Promise<void>;
}

export interface FakeModelServerOptions {
  models?: string[];
  reasoning?: string[];
  answer?: string[];
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
  /** Port to listen on; a free port by default. */
  port?: number;
  /** When set, requests must carry this bearer token. */
  apiKey?: string;
}

export async function startFakeModelServer(
  options: FakeModelServerOptions = {},
): Promise<FakeModelServer> {
  const models = options.models ?? ['qwen3:0.6b', 'llama3.2:1b'];
  const reasoning = options.reasoning ?? [];
  const answer = options.answer ?? ['Hello', ' there'];
  const chatRequests: unknown[] = [];

  const server: Server = createServer((request, response) => {
    if (options.apiKey && request.headers.authorization !== `Bearer ${options.apiKey}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }),
      );
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', async () => {
        chatRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
        const pause = () =>
          new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs ?? 0));
        for (const text of reasoning) {
          send({ choices: [{ delta: { reasoning_content: text } }] });
          await pause();
        }
        for (const text of answer) {
          if (response.destroyed) return;
          send({ choices: [{ delta: { content: text } }] });
          await pause();
        }
        send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: answer.length } });
        response.end('data: [DONE]\n\n');
      });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    chatRequests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
