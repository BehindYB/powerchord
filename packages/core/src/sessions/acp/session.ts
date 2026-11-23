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
import { readableErrorMessage } from '../../system/errors.ts';
import { spawnAgentProcess, stopProcessTree } from '../../system/process.ts';
import type {
  AgentSession,
  PermissionBehavior,
  PermissionScope,
  SessionEvent,
  SessionOption,
  SessionStatus,
} from '../types.ts';

/*
 * Drives an agent that implements the Agent Client Protocol (https://agentclientprotocol.com),
 * such as Gemini CLI started with `--acp`. The agent authenticates itself; PowerChord only
 * selects one of the authentication methods the agent advertises.
 */

const PROTOCOL_VERSION = 1;
const STDERR_TAIL_BYTES = 4000;

export interface AcpSessionOptions {
  /** Display name used in messages, for example "Gemini CLI". */
  agentName: string;
  command: CommandSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcp: PowerChordMcpServer;
  /** Preferred model; null keeps the agent's default. */
  model: string | null;
  /** Preferred mode; null keeps the agent's default. */
  mode: string | null;
  onEvent: (event: SessionEvent) => void;
  /** Authentication method to select after initializing, for example "gemini-api-key". */
  authMethodId?: string;
  /** Agent session to load instead of starting a new one. */
  resumeSessionId?: string;
  hubTools?: boolean;
  /** PowerChord session id given to the hub, which links delegated sub-chats to this session. */
  hubSessionId?: string;
  label?: string;
}

interface ToolCallContent {
  type?: string;
  content?: { type?: string; text?: string };
  path?: string;
  newText?: string;
}

interface ToolCallUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[] | null;
  locations?: { path?: string }[] | null;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

interface PendingPermission {
  options: PermissionOption[];
  resolve: (outcome: unknown) => void;
}

interface ModeState {
  currentModeId?: string;
  availableModes?: { id: string; name: string; description?: string | null }[];
}

interface ModelState {
  currentModelId?: string;
  availableModels?: { modelId: string; name: string; description?: string | null }[];
}

const TOOL_KIND_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Think',
  fetch: 'Fetch',
};

function toOptions(
  entries: { id: string; name: string; description?: string | null }[] | undefined,
): SessionOption[] | undefined {
  return entries?.map((entry) => ({
    id: entry.id,
    label: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

/** Text shown as a tool call's result. */
function toolOutput(update: ToolCallUpdate): string {
  const parts = (update.content ?? []).map((entry) => {
    if (entry.type === 'diff') return `Edited ${entry.path ?? 'a file'}`;
    if (entry.type === 'content' && entry.content?.type === 'text') return entry.content.text ?? '';
    return '';
  });
  const text = parts.filter(Boolean).join('\n');
  if (text) return text;
  if (update.rawOutput === undefined || update.rawOutput === null) return '';
  return typeof update.rawOutput === 'string'
    ? update.rawOutput
    : JSON.stringify(update.rawOutput, null, 2);
}

function toolInput(update: ToolCallUpdate): Record<string, unknown> {
  const raw =
    typeof update.rawInput === 'object' && update.rawInput !== null
      ? (update.rawInput as Record<string, unknown>)
      : {};
  const path = update.locations?.[0]?.path;
  return {
    ...(update.title ? { title: update.title } : {}),
    ...(path ? { path } : {}),
    ...raw,
  };
}

export class AcpSession implements AgentSession {
  private readonly options: AcpSessionOptions;
  private readonly registration: McpClientRegistration;
  private readonly mcpHandlers: McpClientHandlers;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly queue: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: JsonRpcConnection | null = null;
  private ready: Promise<void> | null = null;
  private sessionId: string | null;
  private model: string | null;
  private mode: string | null;
  private currentModel: string | null = null;
  private currentMode: string | null = null;
  private status: SessionStatus = 'idle';
  private turnPrefix = '';
  private blockCount = 0;
  private openBlock: { id: string; kind: 'text' | 'thinking' } | null = null;
  private loadingHistory = false;
  private stderrTail = '';
  private closed = false;
  private expectedExit = false;

  constructor(options: AcpSessionOptions) {
    this.options = options;
    this.sessionId = options.resumeSessionId ?? null;
    this.model = options.model;
    this.mode = options.mode;
    this.mcpHandlers = {
      label: options.label ?? options.agentName,
      hub: options.hubTools ?? false,
      projectFolder: options.cwd,
      ...(options.hubSessionId ? { sessionId: options.hubSessionId } : {}),
    };
    this.registration = options.mcp.register(this.mcpHandlers);
  }

  setLabel(label: string): void {
    this.mcpHandlers.label = label;
  }

  send(text: string): void {
    if (this.closed) throw new Error('Session is closed');
    if (this.status === 'running' || this.queue.length > 0) {
      throw new Error('Wait for the current turn or stop it first.');
    }
    this.emit({ type: 'user-message', id: randomUUID(), text });
    this.queue.push(text);
    void this.drain();
  }

  interrupt(): void {
    this.queue.length = 0;
    if (!this.connection || this.status !== 'running' || !this.sessionId) return;
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.settlePermission(requestId, { outcome: 'cancelled' }, 'deny');
    }
    this.connection.notify('session/cancel', { sessionId: this.sessionId });
  }

  setModel(model: string | null): void {
    this.model = model;
    if (this.status !== 'running') void this.applyPreferences();
  }

  setMode(mode: string): void {
    this.mode = mode;
    if (this.status !== 'running') void this.applyPreferences();
  }

  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    scope: PermissionScope,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    const preferred: PermissionOption['kind'][] =
      behavior === 'deny'
        ? ['reject_once', 'reject_always']
        : scope === 'session'
          ? ['allow_always', 'allow_once']
          : ['allow_once', 'allow_always'];
    const option = preferred
      .map((kind) => pending.options.find((entry) => entry.kind === kind))
      .find((entry) => entry !== undefined);
    this.settlePermission(
      requestId,
      option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
      behavior,
    );
  }

  answerQuestion(): void {
    // ACP agents ask for permission but not structured questions.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
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
    this.emit({ type: 'error', id: randomUUID(), message: readableErrorMessage(message) });
  }

  private async drain(): Promise<void> {
    const text = this.queue.shift();
    if (text === undefined) return;
    try {
      this.ready ??= this.start();
      await this.ready;
    } catch (error) {
      this.ready = null;
      this.stopProcess();
      this.errorEvent(error instanceof Error ? error.message : String(error));
      this.setStatus('idle');
      return;
    }
    await this.prompt(text);
  }

  private async start(): Promise<void> {
    this.setStatus('starting');
    this.stderrTail = '';
    this.expectedExit = false;
    const child = spawnAgentProcess(this.options.command, {
      cwd: this.options.cwd,
      env: this.options.env,
    });
    this.child = child;
    const connection = new JsonRpcConnection(child.stdout, child.stdin, {
      versionField: true,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
    });
    this.connection = connection;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error) =>
      connection.close(`Could not start ${this.options.agentName}: ${error.message}`),
    );
    child.on('close', (code) => this.handleExit(child, code));

    const initialized = await connection.request<{
      agentCapabilities?: {
        loadSession?: boolean;
        mcpCapabilities?: { http?: boolean };
      };
      authMethods?: { id: string }[];
    }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // PowerChord does not proxy file access or terminals; the agent uses its own.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'powerchord', title: 'PowerChord', version: '0.0.0' },
    });

    const { authMethodId } = this.options;
    if (authMethodId && initialized.authMethods?.some((method) => method.id === authMethodId)) {
      await connection.request('authenticate', { methodId: authMethodId });
    }

    const mcpServers =
      this.mcpHandlers.hub && initialized.agentCapabilities?.mcpCapabilities?.http
        ? [
            {
              type: 'http',
              name: MCP_SERVER_NAME,
              url: this.registration.url,
              headers: Object.entries(this.registration.headers).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ]
        : [];

    let result: { sessionId?: string; modes?: ModeState | null; models?: ModelState | null };
    if (this.sessionId && initialized.agentCapabilities?.loadSession) {
      // The agent replays the conversation as updates; PowerChord already shows it.
      this.loadingHistory = true;
      try {
        result = await connection.request('session/load', {
          sessionId: this.sessionId,
          cwd: this.options.cwd,
          mcpServers,
        });
      } finally {
        this.loadingHistory = false;
      }
    } else {
      result = await connection.request('session/new', { cwd: this.options.cwd, mcpServers });
      if (typeof result.sessionId !== 'string')
        throw new Error('The agent did not start a session.');
      this.sessionId = result.sessionId;
    }

    this.currentModel = result.models?.currentModelId ?? null;
    this.currentMode = result.modes?.currentModeId ?? null;
    const availableModels = toOptions(
      result.models?.availableModels?.map((entry) => ({ ...entry, id: entry.modelId })),
    );
    const availableModes = toOptions(result.modes?.availableModes);
    this.emit({
      type: 'session-info',
      agentSessionId: this.sessionId!,
      model: this.currentModel,
      permissionMode: this.currentMode,
      ...(availableModels ? { availableModels } : {}),
      ...(availableModes ? { availableModes } : {}),
    });
    await this.applyPreferences();
  }

  /** Switches the agent to the preferred model and mode when they differ from the current ones. */
  private async applyPreferences(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId || !this.ready) return;
    try {
      if (this.model && this.model !== this.currentModel) {
        await connection.request('session/set_model', { sessionId, modelId: this.model });
        this.currentModel = this.model;
      }
      if (this.mode && this.mode !== this.currentMode) {
        await connection.request('session/set_mode', { sessionId, modeId: this.mode });
        this.currentMode = this.mode;
      }
      this.emit({
        type: 'session-info',
        agentSessionId: sessionId,
        model: this.currentModel,
        permissionMode: this.currentMode,
      });
    } catch (error) {
      this.errorEvent(
        `${this.options.agentName} did not accept the setting: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prompt(text: string): Promise<void> {
    const connection = this.connection!;
    this.turnPrefix = randomUUID();
    this.blockCount = 0;
    this.openBlock = null;
    this.setStatus('running');
    const started = Date.now();
    try {
      const result = await connection.request<{
        stopReason?: string;
        usage?: { inputTokens?: number; outputTokens?: number } | null;
      }>('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      this.closeBlock();
      if (result.stopReason === 'cancelled') {
        this.emit({ type: 'interrupted', id: randomUUID() });
      } else {
        if (result.stopReason === 'refusal') this.errorEvent('The model declined to answer.');
        if (result.stopReason === 'max_tokens')
          this.errorEvent('The answer reached the token limit.');
        this.emit({
          type: 'turn-complete',
          id: randomUUID(),
          summary: {
            isError: result.stopReason === 'refusal',
            durationMs: Date.now() - started,
            costUsd: null,
            inputTokens: result.usage?.inputTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
          },
        });
      }
    } catch (error) {
      this.closeBlock();
      if (!this.closed) {
        this.errorEvent(error instanceof Error ? error.message : String(error));
        this.emit({
          type: 'turn-complete',
          id: randomUUID(),
          summary: {
            isError: true,
            durationMs: Date.now() - started,
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
          },
        });
      }
    } finally {
      if (!this.closed) this.setStatus('idle');
    }
  }

  private appendText(kind: 'text' | 'thinking', text: string): void {
    if (!text) return;
    if (this.openBlock?.kind !== kind) {
      this.closeBlock();
      this.blockCount += 1;
      this.openBlock = { id: `${this.turnPrefix}:${this.blockCount}`, kind };
      this.emit({ type: 'block-start', id: this.openBlock.id, kind });
    }
    this.emit({ type: 'block-delta', id: this.openBlock.id, text });
  }

  private closeBlock(): void {
    if (!this.openBlock) return;
    this.emit({ type: 'block-end', id: this.openBlock.id });
    this.openBlock = null;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.loadingHistory) return;
    const update = (params as { update?: Record<string, unknown> } | null)?.update;
    if (!update) return;
    const content = update['content'] as { type?: string; text?: string } | undefined;

    switch (update['sessionUpdate']) {
      case 'agent_message_chunk':
        if (content?.type === 'text') this.appendText('text', content.text ?? '');
        break;
      case 'agent_thought_chunk':
        if (content?.type === 'text') this.appendText('thinking', content.text ?? '');
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const call = update as ToolCallUpdate;
        if (!call.toolCallId) break;
        if (update['sessionUpdate'] === 'tool_call') {
          this.closeBlock();
          this.emit({
            type: 'tool-call',
            toolCallId: call.toolCallId,
            name: TOOL_KIND_NAMES[call.kind ?? ''] ?? 'Tool',
            input: toolInput(call),
          });
        }
        if (call.status === 'completed' || call.status === 'failed') {
          this.emit({
            type: 'tool-result',
            toolCallId: call.toolCallId,
            output: toolOutput(call),
            isError: call.status === 'failed',
          });
        }
        break;
      }
      case 'current_mode_update':
        if (typeof update['currentModeId'] === 'string' && this.sessionId) {
          this.currentMode = update['currentModeId'];
          this.emit({
            type: 'session-info',
            agentSessionId: this.sessionId,
            model: this.currentModel,
            permissionMode: this.currentMode,
          });
        }
        break;
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new JsonRpcError(METHOD_NOT_FOUND, `${method} is not supported by PowerChord`);
    }
    const request = params as { toolCall?: ToolCallUpdate; options?: PermissionOption[] };
    const toolCall = request.toolCall ?? {};
    const requestId = randomUUID();
    this.closeBlock();
    return new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, {
        options: request.options ?? [],
        resolve: (outcome) => resolve({ outcome }),
      });
      this.emit({
        type: 'permission-request',
        requestId,
        toolName: toolCall.title ?? TOOL_KIND_NAMES[toolCall.kind ?? ''] ?? 'a tool',
        input: toolInput(toolCall),
        toolCallId: toolCall.toolCallId ?? null,
      });
    });
  }

  private settlePermission(
    requestId: string,
    outcome: unknown,
    behavior: PermissionBehavior,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(outcome);
    this.emit({ type: 'permission-resolved', requestId, behavior });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    const detail = this.stderrTail.trim();
    const message = `${this.options.agentName} exited${code === null ? '' : ` with code ${code}`}.${detail ? `\n${detail}` : ''}`;
    this.connection?.close(message);
    this.connection = null;
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.settlePermission(requestId, { outcome: 'cancelled' }, 'deny');
    }
    if (!this.expectedExit && !this.closed && this.status !== 'running') this.errorEvent(message);
    this.setStatus(this.closed ? 'stopped' : 'idle');
  }

  private stopProcess(): void {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    this.connection?.close(`${this.options.agentName} stopped.`);
    stopProcessTree(child);
  }
}
