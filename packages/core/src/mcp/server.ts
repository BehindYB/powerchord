import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/*
 * PowerChord's local MCP server. It listens on the loopback interface only, and each client
 * (one per agent session) reaches it through an unguessable per-client URL. See the
 * "PowerChord MCP server" rules in docs/COMPLIANCE.md.
 */

export const MCP_SERVER_NAME = 'powerchord';
export const PERMISSION_TOOL_NAME = 'permission_prompt';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string | null;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface McpClientHandlers {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface McpClientRegistration {
  /** URL the agent connects to; contains the client's secret token. */
  url: string;
  dispose(): void;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendStatus(response: ServerResponse, status: number): void {
  response.writeHead(status).end();
}

export class PowerChordMcpServer {
  private server: Server | null = null;
  private port = 0;
  private readonly clients = new Map<string, McpClientHandlers>();

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) sendStatus(response, 500);
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.clients.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  register(handlers: McpClientHandlers): McpClientRegistration {
    if (!this.server) throw new Error('MCP server is not running');
    const token = randomBytes(32).toString('hex');
    this.clients.set(token, handlers);
    return {
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      dispose: () => this.clients.delete(token),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Browsers send Origin; agents do not. Rejecting it blocks cross-site requests from web pages.
    if (request.headers.origin !== undefined) return sendStatus(response, 403);
    if (request.headers.host !== `127.0.0.1:${this.port}`) return sendStatus(response, 403);

    const match = /^\/mcp\/([0-9a-f]{64})$/.exec(request.url ?? '');
    const handlers = match ? this.clients.get(match[1]!) : undefined;
    if (!handlers) return sendStatus(response, 404);
    if (request.method !== 'POST') return sendStatus(response, 405);

    const body = await readBody(request);
    const server = this.createMcpServer(handlers);
    // Stateless mode (no session id generator): a fresh server and transport per request.
    const transport = new StreamableHTTPServerTransport({});
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's transport typings predate `exactOptionalPropertyTypes`; the runtime types match.
    await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
    await transport.handleRequest(request, response, body);
  }

  private createMcpServer(handlers: McpClientHandlers): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.0' });

    server.registerTool(
      PERMISSION_TOOL_NAME,
      {
        description: 'Asks the PowerChord user to approve or deny a tool call.',
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()),
          tool_use_id: z.string().optional(),
        },
      },
      async (args) => {
        const decision = await handlers.requestPermission({
          toolName: args.tool_name,
          input: args.input,
          toolCallId: args.tool_use_id ?? null,
        });
        const payload =
          decision.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: decision.updatedInput ?? args.input }
            : decision;
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      },
    );

    return server;
  }
}
