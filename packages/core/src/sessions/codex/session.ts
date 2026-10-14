import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CommandSpec } from '../../agents/types.ts';
import {
  MCP_SERVER_NAME,
  type McpClientHandlers,
  type McpClientRegistration,
  type PowerChordMcpServer,
} from '../../mcp/server.ts';
import { JsonRpcConnection, JsonRpcError, METHOD_NOT_FOUND } from '../../system/json-rpc.ts';
import { spawnAgentProcess, stopProcessTree } from '../../system/process.ts';
import type {
  AgentSession,
  PermissionBehavior,
  PermissionScope,
  SessionEvent,
  SessionOption,
  SessionStatus,
  UsageLimits,
  UsageWindow,
} from '../types.ts';

/*
 * Drives the user's installed Codex CLI through its app-server protocol (`codex app-server`,
 * https://developers.openai.com/codex/app-server). Codex signs in with its own `codex login`;
 * PowerChord never handles OpenAI credentials.
 */

export type CodexMode = 'read-only' | 'auto' | 'full-access';

export const CODEX_MODES: readonly CodexMode[] = ['read-only', 'auto', 'full-access'];

/** Sandbox and approval settings behind each mode, matching the modes of Codex's own interface. */
const MODE_SETTINGS: Record<CodexMode, { sandbox: string; approvalPolicy: string }> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

/** Environment variable through which Codex reads the hub token, so it never lands in a file. */
const HUB_TOKEN_VARIABLE = 'POWERCHORD_HUB_TOKEN';
const STDERR_TAIL_BYTES = 4000;
const FIVE_HOURS_MINUTES = 300;
const SEVEN_DAYS_MINUTES = 7 * 24 * 60;

export interface CodexSessionOptions {
  command: CommandSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcp: PowerChordMcpServer;
  model: string | null;
  mode: CodexMode;
  onEvent: (event: SessionEvent) => void;
  /** Codex thread to resume instead of starting a new one. */
  resumeThreadId?: string;
  hubTools?: boolean;
  label?: string;
}

type ThreadItem = { type: string; id: string } & Record<string, unknown>;

interface PendingApproval {
  kind: 'command' | 'fileChange' | 'elicitation';
  resolve: (result: unknown) => void;
}

interface TokenUsage {
  last?: { inputTokens?: number; outputTokens?: number };
}

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export function isCodexMode(value: unknown): value is CodexMode {
  return CODEX_MODES.includes(value as CodexMode);
}

function usageWindow(window: RateLimitWindow | null | undefined): UsageWindow | undefined {
  if (!window || typeof window.usedPercent !== 'number' || typeof window.resetsAt !== 'number') {
    return undefined;
  }
  return { utilization: window.usedPercent / 100, resetsAt: window.resetsAt };
}

/** Maps Codex rate-limit windows to the five-hour and weekly windows PowerChord displays. */
export function codexUsageLimits(snapshot: {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}): UsageLimits {
  const limits: UsageLimits = {};
  for (const window of [snapshot.primary, snapshot.secondary]) {
    const value = usageWindow(window);
    if (!value) continue;
    if (window?.windowDurationMins === FIVE_HOURS_MINUTES) limits.fiveHour = value;
    else if (window?.windowDurationMins === SEVEN_DAYS_MINUTES) limits.sevenDay = value;
  }
  return limits;
}

function itemToolCall(item: ThreadItem): { name: string; input: unknown } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Run', input: { command: item['command'], cwd: item['cwd'] } };
    case 'fileChange': {
      const changes = (item['changes'] as { path?: string }[] | undefined) ?? [];
      return {
        name: 'Edit',
        input: { file_path: changes.map((change) => change.path).join(', ') },
      };
    }
    case 'mcpToolCall':
      return {
        name: `mcp__${String(item['server'])}__${String(item['tool'])}`,
        input: item['arguments'],
      };
    case 'webSearch':
      return { name: 'WebSearch', input: { query: item['query'] } };
    default:
      return null;
  }
}

function itemResult(item: ThreadItem): { output: string; isError: boolean } {
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = item['exitCode'];
      const failed = item['status'] === 'failed' || item['status'] === 'declined';
      return {
        output:
          (item['aggregatedOutput'] as string | null) ?? (failed ? String(item['status']) : ''),
        isError: failed || (typeof exitCode === 'number' && exitCode !== 0),
      };
    }
    case 'fileChange': {
      const changes = (item['changes'] as { path?: string; diff?: string }[] | undefined) ?? [];
      return {
        output: changes.map((change) => change.diff || `Changed ${change.path}`).join('\n'),
        isError: item['status'] === 'failed' || item['status'] === 'declined',
      };
    }
    case 'mcpToolCall': {
      const error = item['error'] as { message?: string } | null;
      if (error) return { output: error.message ?? 'Failed', isError: true };
      const result = item['result'] as { content?: { type?: string; text?: string }[] } | null;
      const text = (result?.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('\n');
      return { output: text, isError: item['status'] === 'failed' };
    }
    default:
      return { output: '', isError: false };
  }
}

export class CodexSession implements AgentSession {
  private readonly options: CodexSessionOptions;
  private readonly registration: McpClientRegistration;
  private readonly mcpHandlers: McpClientHandlers;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: JsonRpcConnection | null = null;
  private ready: Promise<void> | null = null;
  private threadId: string | null;
  private turnId: string | null = null;
  private turnStarted = 0;
  private lastUsage: TokenUsage | null = null;
  private turnErrorReported = false;
  private model: string | null;
  private mode: CodexMode;
  private restartAfterTurn = false;
  private status: SessionStatus = 'idle';
  private stderrTail = '';
  private expectedExit = false;
  private closed = false;

  constructor(options: CodexSessionOptions) {
    this.options = options;
    this.threadId = options.resumeThreadId ?? null;
    this.model = options.model;
    this.mode = options.mode;
    this.mcpHandlers = { label: options.label ?? 'Codex', hub: options.hubTools ?? false };
    this.registration = options.mcp.register(this.mcpHandlers);
  }

  setLabel(label: string): void {
    this.mcpHandlers.label = label;
  }

  send(text: string): void {
    if (this.closed) throw new Error('Session is closed');
    if (this.status !== 'idle') throw new Error('Wait for the current turn or stop it first.');
    this.emit({ type: 'user-message', id: randomUUID(), text });
    void this.runTurn(text);
  }

  interrupt(): void {
    if (!this.connection || !this.threadId || !this.turnId) return;
    for (const requestId of [...this.pendingApprovals.keys()]) {
      this.respondToPermission(requestId, 'deny', 'once');
    }
    void this.connection
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch(() => {
        // The turn may have finished in the meantime.
      });
  }

  /** Applies from the next turn; the app-server restarts and resumes the thread. */
  setModel(model: string | null): void {
    this.model = model;
    this.scheduleRestart();
  }

  setMode(mode: string): void {
    if (!isCodexMode(mode)) throw new Error(`Unknown Codex mode: ${mode}`);
    this.mode = mode;
    this.scheduleRestart();
  }

  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    scope: PermissionScope,
  ): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    if (pending.kind === 'elicitation') {
      pending.resolve(
        behavior === 'allow'
          ? { action: 'accept', content: {}, _meta: null }
          : { action: 'decline', content: null, _meta: null },
      );
    } else {
      pending.resolve({
        decision:
          behavior === 'deny' ? 'decline' : scope === 'session' ? 'acceptForSession' : 'accept',
      });
    }
    this.emit({ type: 'permission-resolved', requestId, behavior });
  }

  answerQuestion(): void {
    // Codex questions are an experimental protocol feature PowerChord does not enable.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopProcess();
    this.registration.dispose();
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private errorEvent(message: string): void {
    this.emit({ type: 'error', id: randomUUID(), message });
  }

  private scheduleRestart(): void {
    if (!this.child) return;
    if (this.status === 'running') this.restartAfterTurn = true;
    else this.stopProcess();
  }

  private async runTurn(text: string): Promise<void> {
    this.turnStarted = Date.now();
    this.lastUsage = null;
    this.turnErrorReported = false;
    try {
      this.ready ??= this.start();
      await this.ready;
      this.setStatus('running');
      const result = await this.connection!.request<{ turn?: { id?: string } }>('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      this.turnId = result.turn?.id ?? this.turnId;
    } catch (error) {
      // Start over with a fresh process on the next message.
      this.stopProcess();
      this.ready = null;
      this.errorEvent(error instanceof Error ? error.message : String(error));
      this.finishTurn(true);
    }
  }

  private async start(): Promise<void> {
    this.setStatus('starting');
    this.stderrTail = '';
    this.expectedExit = false;
    this.restartAfterTurn = false;
    const env = this.mcpHandlers.hub
      ? { ...this.options.env, [HUB_TOKEN_VARIABLE]: this.registration.token }
      : this.options.env;
    const child = spawnAgentProcess(
      { command: this.options.command.command, args: [...this.options.command.args, 'app-server'] },
      { cwd: this.options.cwd, env },
    );
    this.child = child;
    const connection = new JsonRpcConnection(child.stdout, child.stdin, {
      versionField: false,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
    });
    this.connection = connection;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error) => connection.close(`Could not start Codex: ${error.message}`));
    child.on('close', (code) => this.handleExit(child, code));

    await connection.request('initialize', {
      clientInfo: { name: 'powerchord', title: 'PowerChord', version: '0.0.0' },
      capabilities: null,
    });
    connection.notify('initialized', {});

    const account = await connection.request<{
      account: unknown;
      requiresOpenaiAuth?: boolean;
    }>('account/read', {});
    if (!account.account && account.requiresOpenaiAuth !== false) {
      throw new Error('Codex is not signed in. Sign in from the Agents screen, then try again.');
    }

    const settings = MODE_SETTINGS[this.mode];
    const config = this.mcpHandlers.hub
      ? {
          [`mcp_servers.${MCP_SERVER_NAME}`]: {
            url: this.registration.url,
            bearer_token_env_var: HUB_TOKEN_VARIABLE,
          },
        }
      : null;
    const params = {
      cwd: this.options.cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      ...(this.model ? { model: this.model } : {}),
      ...(config ? { config } : {}),
    };
    const result = await connection.request<{ thread?: { id?: string }; model?: string }>(
      this.threadId ? 'thread/resume' : 'thread/start',
      this.threadId
        ? { ...params, threadId: this.threadId }
        : { ...params, serviceName: 'powerchord' },
    );
    if (!result.thread?.id) throw new Error('Codex did not start a thread.');
    this.threadId = result.thread.id;

    const availableModels = await this.listModels(connection);
    this.emit({
      type: 'session-info',
      agentSessionId: this.threadId,
      model: result.model ?? this.model,
      permissionMode: this.mode,
      ...(availableModels ? { availableModels } : {}),
    });
  }

  private async listModels(connection: JsonRpcConnection): Promise<SessionOption[] | undefined> {
    try {
      const result = await connection.request<{
        data?: { id: string; displayName?: string; description?: string; hidden?: boolean }[];
      }>('model/list', { includeHidden: false });
      return result.data
        ?.filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          label: model.displayName || model.id,
          ...(model.description ? { description: model.description } : {}),
        }));
    } catch {
      return undefined;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const data = (params ?? {}) as Record<string, unknown>;
    if (typeof data['threadId'] === 'string' && data['threadId'] !== this.threadId) return;

    switch (method) {
      case 'turn/started': {
        const turn = data['turn'] as { id?: string } | undefined;
        if (turn?.id) this.turnId = turn.id;
        break;
      }
      case 'item/started': {
        const item = data['item'] as ThreadItem;
        if (item.type === 'agentMessage') {
          this.emit({ type: 'block-start', id: item.id, kind: 'text' });
        } else if (item.type === 'reasoning') {
          this.emit({ type: 'block-start', id: item.id, kind: 'thinking' });
        } else {
          const call = itemToolCall(item);
          if (call) this.emit({ type: 'tool-call', toolCallId: item.id, ...call });
        }
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
        this.emit({
          type: 'block-delta',
          id: String(data['itemId']),
          text: String(data['delta'] ?? ''),
        });
        break;
      case 'item/completed': {
        const item = data['item'] as ThreadItem;
        if (item.type === 'agentMessage') {
          this.emit({ type: 'text', id: item.id, kind: 'text', text: String(item['text'] ?? '') });
        } else if (item.type === 'reasoning') {
          const summary = (item['summary'] as string[] | undefined) ?? [];
          this.emit({ type: 'text', id: item.id, kind: 'thinking', text: summary.join('\n\n') });
        } else if (itemToolCall(item)) {
          // Repeats the call with its final input, which can be fuller than at the start.
          this.emit({ type: 'tool-call', toolCallId: item.id, ...itemToolCall(item)! });
          this.emit({ type: 'tool-result', toolCallId: item.id, ...itemResult(item) });
        }
        break;
      }
      case 'thread/tokenUsage/updated':
        this.lastUsage = (data['tokenUsage'] as TokenUsage | undefined) ?? null;
        break;
      case 'account/rateLimits/updated': {
        const limits = codexUsageLimits(
          (data['rateLimits'] as Parameters<typeof codexUsageLimits>[0] | undefined) ?? {},
        );
        if (limits.fiveHour || limits.sevenDay) this.emit({ type: 'usage-limits', limits });
        break;
      }
      case 'error': {
        const error = data['error'] as { message?: string } | undefined;
        if (data['willRetry'] !== true) {
          this.turnErrorReported = true;
          this.errorEvent(error?.message ?? 'Codex reported an error.');
        }
        break;
      }
      case 'turn/completed': {
        const turn = (data['turn'] ?? {}) as {
          status?: string;
          error?: { message?: string } | null;
        };
        if (turn.status === 'interrupted') {
          this.emit({ type: 'interrupted', id: randomUUID() });
          this.finishTurn(null);
        } else {
          if (turn.status === 'failed' && turn.error?.message && !this.turnErrorReported) {
            this.errorEvent(turn.error.message);
          }
          this.finishTurn(turn.status === 'failed');
        }
        break;
      }
    }
  }

  /** Ends the current turn; `isError` null means it was interrupted and has no summary. */
  private finishTurn(isError: boolean | null): void {
    if (isError !== null) {
      this.emit({
        type: 'turn-complete',
        id: randomUUID(),
        summary: {
          isError,
          durationMs: Date.now() - this.turnStarted,
          costUsd: null,
          inputTokens: this.lastUsage?.last?.inputTokens ?? null,
          outputTokens: this.lastUsage?.last?.outputTokens ?? null,
        },
      });
    }
    this.turnId = null;
    this.setStatus('idle');
    if (this.restartAfterTurn) this.stopProcess();
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const data = (params ?? {}) as Record<string, unknown>;
    let kind: PendingApproval['kind'];
    let toolName: string;
    let input: Record<string, unknown>;

    if (method === 'item/commandExecution/requestApproval') {
      kind = 'command';
      toolName = 'Run';
      input = { command: data['command'], cwd: data['cwd'], description: data['reason'] };
    } else if (method === 'item/fileChange/requestApproval') {
      kind = 'fileChange';
      toolName = 'Edit';
      input = { description: data['reason'] ?? 'Apply file changes', path: data['grantRoot'] };
    } else if (method === 'mcpServer/elicitation/request' && data['mode'] !== 'url') {
      kind = 'elicitation';
      toolName = `${String(data['serverName'])} request`;
      input = { description: data['message'] };
    } else {
      throw new JsonRpcError(METHOD_NOT_FOUND, `${method} is not supported by PowerChord`);
    }

    const requestId = randomUUID();
    return new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(requestId, { kind, resolve });
      this.emit({
        type: 'permission-request',
        requestId,
        toolName,
        input,
        toolCallId: typeof data['itemId'] === 'string' ? data['itemId'] : null,
      });
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    const detail = this.stderrTail.trim();
    const message = `Codex exited${code === null ? '' : ` with code ${code}`}.${detail ? `\n${detail}` : ''}`;
    this.connection?.close(message);
    this.connection = null;
    for (const requestId of [...this.pendingApprovals.keys()]) {
      this.respondToPermission(requestId, 'deny', 'once');
    }
    if (!this.expectedExit && !this.closed) {
      this.errorEvent(message);
      if (this.status === 'running') this.finishTurn(true);
    }
    this.setStatus(this.closed ? 'stopped' : 'idle');
  }

  private stopProcess(): void {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    this.connection?.close('Codex stopped.');
    stopProcessTree(child);
  }
}
