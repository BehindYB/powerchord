import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerHubTools, type HubContext } from '../hub/tools.ts';

/*
 * PowerChord's local MCP server. It listens on the loopback interface only. Every client (an agent
 * session driven by PowerChord, or an agent the user registered the hub in) authenticates with its
 * own bearer token. See the "PowerChord MCP server" rules in docs/COMPLIANCE.md.
 */

export const MCP_SERVER_NAME = 'powerchord';
export const PERMISSION_TOOL_NAME = 'permission_prompt';
const MCP_PATH = '/mcp';
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
  /** Name recorded as the author of hub changes made by this client. */
  label: string;
  /** Present for Claude Code sessions, which route permission prompts through PowerChord. */
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Whether the client gets the hub tools. */
  hub?: boolean;
  /** Working folder of the session, the default project of the memory tools. */
  projectFolder?: string;
}

export interface McpClientRegistration {
  url: string;
  token: string;
  /** HTTP headers the client must send. */
  headers: Record<string, string>;
  dispose(): void;
}

export interface McpServerStartResult {
  port: number;
  /** False when the preferred port was taken and another port was used. */
  usedPreferredPort: boolean;
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

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export function createToken(): string {
  return randomBytes(32).toString('hex');
}

export class PowerChordMcpServer {
  private server: Server | null = null;
  private port = 0;
  private readonly clients = new Map<string, McpClientHandlers>();
  private hub: HubContext | null = null;

  /** Provides the hub tools to clients registered with `hub: true`. */
  setHub(hub: HubContext | null): void {
    this.hub = hub;
  }

  async start(options: { preferredPort?: number } = {}): Promise<McpServerStartResult> {
    if (this.server) return { port: this.port, usedPreferredPort: true };
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) sendStatus(response, 500);
        else response.end();
      });
    });
    let usedPreferredPort = false;
    if (options.preferredPort) {
      try {
        await listen(server, options.preferredPort);
        usedPreferredPort = true;
      } catch {
        // The preferred port is taken; fall back to any free port.
      }
    }
    if (!usedPreferredPort) await listen(server, 0);
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return { port: this.port, usedPreferredPort };
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

  get url(): string {
    return `http://127.0.0.1:${this.port}${MCP_PATH}`;
  }

  /** Registers a client. Pass a token to keep a stable credential across restarts. */
  register(handlers: McpClientHandlers, token: string = createToken()): McpClientRegistration {
    if (!this.server) throw new Error('MCP server is not running');
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid token');
    this.clients.set(token, handlers);
    return {
      url: this.url,
      token,
      headers: { Authorization: `Bearer ${token}` },
      dispose: () => this.clients.delete(token),
    };
  }

  private authenticate(request: IncomingMessage): McpClientHandlers | undefined {
    const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
    if (!match) return undefined;
    const presented = Buffer.from(match[1]!);
    for (const [token, handlers] of this.clients) {
      const expected = Buffer.from(token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
        return handlers;
      }
    }
    return undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Browsers send Origin; agents do not. Rejecting it blocks cross-site requests from web pages.
    if (request.headers.origin !== undefined) return sendStatus(response, 403);
    if (request.headers.host !== `127.0.0.1:${this.port}`) return sendStatus(response, 403);
    if (request.url !== MCP_PATH) return sendStatus(response, 404);
    const handlers = this.authenticate(request);
    if (!handlers) return sendStatus(response, 401);
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
    const { requestPermission } = handlers;

    if (requestPermission) {
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
          const decision = await requestPermission({
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
    }

    if (handlers.hub && this.hub) {
      registerHubTools(server, this.hub, handlers.label, handlers.projectFolder ?? null);
    }
    return server;
  }
}
