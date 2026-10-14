import type { Readable, Writable } from 'node:stream';

/*
 * JSON-RPC 2.0 over newline-delimited JSON, as used by agent protocols on stdio
 * (Agent Client Protocol, Codex app-server). Both sides can send requests.
 */

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export const METHOD_NOT_FOUND = -32601;

export interface JsonRpcConnectionOptions {
  /** Whether messages carry `"jsonrpc": "2.0"`. Codex's app-server omits the field. */
  versionField: boolean;
  onNotification: (method: string, params: unknown) => void;
  /** Handles a request from the other side; throw a JsonRpcError to answer with an error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
}

type MessageId = number | string;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcConnection {
  private readonly output: Writable;
  private readonly options: JsonRpcConnectionOptions;
  private readonly pending = new Map<MessageId, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private closedReason: string | null = null;

  constructor(input: Readable, output: Writable, options: JsonRpcConnectionOptions) {
    this.output = output;
    this.options = options;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.receive(chunk));
    output.on('error', () => {
      // Writes fail once the process has exited; `close` reports that to pending requests.
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.write({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== null) return;
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** Rejects every pending request; later calls fail immediately. */
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const request of this.pending.values()) request.reject(new Error(reason));
    this.pending.clear();
  }

  private write(message: Record<string, unknown>): void {
    const payload = this.options.versionField ? { jsonrpc: '2.0', ...message } : message;
    this.output.write(`${JSON.stringify(payload)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Agents may print diagnostics on stdout; anything that is not JSON is ignored.
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const id = message['id'] as MessageId | undefined;
    const method = message['method'];

    if (typeof method === 'string') {
      if (id === undefined || id === null) {
        this.options.onNotification(method, message['params']);
      } else {
        void this.answer(id, method, message['params']);
      }
      return;
    }

    if (id === undefined || id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = message['error'] as { code?: unknown; message?: unknown; data?: unknown } | null;
    if (error && typeof error === 'object') {
      pending.reject(
        new JsonRpcError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'Request failed',
          error.data,
        ),
      );
    } else {
      pending.resolve(message['result']);
    }
  }

  private async answer(id: MessageId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      if (this.closedReason === null) this.write({ id, result: result ?? null });
    } catch (error) {
      if (this.closedReason !== null) return;
      const code = error instanceof JsonRpcError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      this.write({ id, error: { code, message } });
    }
  }
}
