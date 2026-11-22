import { randomUUID } from 'node:crypto';
import {
  streamChat,
  type ChatMessage,
  type ChatUsage,
  type ModelEndpoint,
  type ToolCall,
} from '../../models/openai-compatible.ts';
import { streamAnthropicChat } from '../../models/anthropic.ts';
import { approximateTokens, estimateCost, type ModelPrice } from '../../models/pricing.ts';
import {
  isModelChatMode,
  MODEL_CHAT_MODES,
  type AgentSession,
  type ModelChatMode,
  type PermissionBehavior,
  type PermissionScope,
  type SessionEvent,
  type SessionStatus,
  type TranscriptItem,
  type TurnSummary,
} from '../types.ts';
import {
  AUTO_COMPACT_AT,
  cleanSummary,
  COMPACTED_QUESTION,
  CONTINUE_NOTE,
  historyTokens,
  summaryRequest,
} from './compaction.ts';
import { commandShell, needsApproval, WORKSPACE_TOOLS, type WorkspaceTool } from './tools.ts';

/** Model requests in one turn before the session stops a model that keeps calling tools. */
const MAX_STEPS = 50;

export interface ModelChatWorkspace {
  /** Project folder the tools work in. */
  cwd: string;
  /** Environment for commands the model runs. */
  env: NodeJS.ProcessEnv;
  mode: ModelChatMode;
}

export interface ModelChatSessionOptions {
  endpoint: ModelEndpoint;
  model: string;
  systemPrompt?: string;
  onEvent: (event: SessionEvent) => void;
  /** Earlier conversation, for example restored from a saved transcript. */
  history?: ChatMessage[];
  /** Identifier of a restored conversation. */
  agentSessionId?: string;
  /** Wire protocol of the endpoint; OpenAI-compatible unless stated. */
  protocol?: 'openai-compatible' | 'anthropic';
  /** List price of a model, used to estimate each turn's cost; null when unknown or free. */
  priceFor?: (model: string) => ModelPrice | null;
  /** Project folder; when set, the model can read and change files there and run commands. */
  workspace?: ModelChatWorkspace;
  /** Looks up a model's context window; resolves null when it is unknown. */
  contextWindow?: (model: string) => Promise<number | null>;
}

/**
 * Rebuilds the chat history from a transcript. Only questions and answers are kept: tool calls
 * are left out because providers attach data to them (such as Gemini's thought signatures)
 * that a transcript does not store. Messages without an answer are left out, matching what a
 * live session keeps after a failed or interrupted request.
 */
export function chatHistoryFromTranscript(items: readonly TranscriptItem[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  let question: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    if (question !== null && answer.length > 0) {
      history.push(
        { role: 'user', content: question },
        { role: 'assistant', content: answer.join('\n\n') },
      );
    }
    question = null;
    answer = [];
  };
  for (const item of items) {
    if (item.kind === 'user') {
      flush();
      question = item.text;
    } else if (item.kind === 'compaction' && item.status === 'done' && item.summary) {
      // Everything before a compaction, including earlier answers to the current question,
      // lives on in its summary.
      history.length = 0;
      history.push(
        { role: 'user', content: COMPACTED_QUESTION },
        { role: 'assistant', content: item.summary },
      );
      answer = [];
    } else if (item.kind === 'text' && question !== null && item.text) {
      answer.push(item.text);
    }
  }
  flush();
  return history;
}

/** Instructions for a model that works in a project folder. */
export function workspaceSystemPrompt(cwd: string): string {
  const system =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return [
    `You are a coding assistant working in the user's project folder: ${cwd}`,
    `Operating system: ${system}. Commands run in ${commandShell().name}.`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    'Use the tools to look at files, change them, run commands and read web pages instead of ' +
      'guessing. File paths are relative to the project folder; tools cannot reach outside it.',
    'Read a file before editing it. Some actions need the user’s approval; when one is denied, ' +
      'do not try it again in another way: explain what you wanted to do or ask the user.',
    'When the task is done, answer briefly with what you did.',
  ].join('\n');
}

interface PendingPermission {
  toolName: string;
  resolve: (behavior: PermissionBehavior) => void;
}

interface CompactionRequest {
  automatic: boolean;
  /** The request of the turn in progress, kept word for word after the summary. */
  keep: string | null;
  /** Whether work on `keep` has started, so the summary covers part of it. */
  inProgress: boolean;
}

interface ToolOutcome {
  output: string;
  isError: boolean;
}

function compactionError(error: unknown): string {
  return `Could not compact the conversation: ${error instanceof Error ? error.message : String(error)}`;
}

function parseArguments(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text || '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A chat session with a model served by an OpenAI-compatible endpoint or Anthropic's API. With a
 * project folder, the model can call workspace tools; each turn then runs until the model answers
 * without calling more tools.
 */
export class ModelChatSession implements AgentSession {
  readonly agentSessionId: string;
  private readonly options: ModelChatSessionOptions;
  private readonly history: ChatMessage[] = [];
  private readonly tools: readonly WorkspaceTool[];
  private readonly pending = new Map<string, PendingPermission>();
  /** Tools the user allowed for the rest of the session. */
  private readonly allowedTools = new Set<string>();
  private model: string;
  private mode: ModelChatMode | null;
  private status: SessionStatus = 'idle';
  private controller: AbortController | null = null;
  private closed = false;
  private windowTokens: number | null = null;
  /** Tokens the server counted for the history up to `length` messages, after the last reply. */
  private baseline: { tokens: number; length: number } | null = null;

  constructor(options: ModelChatSessionOptions) {
    this.options = options;
    this.agentSessionId = options.agentSessionId ?? randomUUID();
    this.model = options.model;
    this.mode = options.workspace?.mode ?? null;
    this.tools = options.workspace ? WORKSPACE_TOOLS : [];
    const system = [
      options.workspace ? workspaceSystemPrompt(options.workspace.cwd) : '',
      options.systemPrompt ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (system) this.history.push({ role: 'system', content: system });
    if (options.history) this.history.push(...options.history);
    // Deferred so the owner can finish registering the session before the first event.
    queueMicrotask(() => {
      this.emitInfo();
      void this.refreshContextWindow();
    });
  }

  send(text: string): void {
    if (this.closed) throw new Error('Session is closed');
    if (this.controller) throw new Error('Wait for the current answer or stop it first.');
    this.emit({ type: 'user-message', id: randomUUID(), text });
    this.history.push({ role: 'user', content: text });
    void this.runTurn();
  }

  interrupt(): void {
    this.controller?.abort();
    this.denyPending();
  }

  setModel(model: string | null): void {
    if (!model) throw new Error('A model is required');
    this.model = model;
    // Another model counts tokens differently and may have another window.
    this.baseline = null;
    this.emitInfo();
    void this.refreshContextWindow();
  }

  compact(): void {
    if (this.closed) throw new Error('Session is closed');
    if (this.controller) throw new Error('Wait for the current answer or stop it first.');
    if (this.history.every((message) => message.role === 'system')) {
      throw new Error('There is nothing to compact yet.');
    }
    void this.runCompaction();
  }

  setMode(mode: string): void {
    if (this.mode === null) throw new Error('Chats without a project folder have no modes.');
    if (!isModelChatMode(mode)) throw new Error(`Unknown mode ${mode}`);
    this.mode = mode;
    this.emitInfo();
  }

  respondToPermission(requestId: string, behavior: PermissionBehavior, scope: PermissionScope) {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    if (behavior === 'allow' && scope === 'session') this.allowedTools.add(request.toolName);
    this.emit({ type: 'permission-resolved', requestId, behavior });
    request.resolve(behavior);
  }

  answerQuestion(): void {
    // Model chats never ask structured questions.
  }

  setLabel(): void {
    // Model chats do not use the hub.
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.denyPending();
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event);
  }

  private emitInfo(): void {
    this.emit({
      type: 'session-info',
      agentSessionId: this.agentSessionId,
      model: this.model,
      permissionMode: this.mode,
      ...(this.mode !== null ? { availableModes: [...MODEL_CHAT_MODES] } : {}),
    });
  }

  private async refreshContextWindow(): Promise<void> {
    const model = this.model;
    const lookup = this.options.contextWindow;
    const size = lookup ? await lookup(model).catch(() => null) : null;
    if (this.closed || model !== this.model) return;
    this.windowTokens = size;
    this.emitContext();
  }

  /** Tokens the next request will use: measured by the server where possible, else estimated. */
  private contextEstimate(): number {
    const baseline = this.baseline;
    if (baseline && baseline.length <= this.history.length) {
      return baseline.tokens + historyTokens(this.history.slice(baseline.length));
    }
    const tools =
      this.tools.length > 0
        ? approximateTokens(JSON.stringify(this.tools.map((tool) => tool.definition)))
        : 0;
    return historyTokens(this.history) + tools;
  }

  private emitContext(): void {
    this.emit({
      type: 'context-usage',
      usedTokens: this.contextEstimate(),
      windowTokens: this.windowTokens,
    });
  }

  private shouldCompact(): boolean {
    if (this.windowTokens === null) return false;
    // A history that is just a summary and the current request cannot shrink further.
    const conversation = this.history.filter((message) => message.role !== 'system').length;
    return conversation > 3 && this.contextEstimate() >= this.windowTokens * AUTO_COMPACT_AT;
  }

  /** Replaces the history with a summary written by the model; returns the request's usage. */
  private async compactHistory(
    signal: AbortSignal,
    request: CompactionRequest,
  ): Promise<ChatUsage> {
    const id = randomUUID();
    this.emit({
      type: 'compaction-start',
      id,
      automatic: request.automatic,
      tokensBefore: this.contextEstimate(),
    });
    try {
      const conversation = this.history.filter((message) => message.role !== 'system');
      const source =
        request.keep !== null && !request.inProgress ? conversation.slice(0, -1) : conversation;
      let text = '';
      let usage: ChatUsage = { inputTokens: null, outputTokens: null };
      const stream = (this.options.protocol === 'anthropic' ? streamAnthropicChat : streamChat)(
        this.options.endpoint,
        { model: this.model, messages: summaryRequest(source, this.windowTokens) },
        signal,
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'usage') usage = chunk.usage;
      }
      const summary = cleanSummary(text);
      if (!summary) throw new Error('The model returned an empty summary.');

      const compacted: ChatMessage[] = [
        ...this.history.filter((message) => message.role === 'system'),
        { role: 'user', content: COMPACTED_QUESTION },
        { role: 'assistant', content: summary },
      ];
      if (request.keep !== null) {
        compacted.push({
          role: 'user',
          content: request.inProgress ? `${request.keep}\n\n${CONTINUE_NOTE}` : request.keep,
        });
      }
      this.history.splice(0, this.history.length, ...compacted);
      this.baseline = null;
      this.emit({ type: 'compaction-end', id, summary });
      this.emitContext();
      return usage;
    } catch (error) {
      this.emit({ type: 'compaction-end', id, summary: null });
      throw error;
    }
  }

  /** A compaction the user asked for, run like a turn so that its cost is recorded. */
  private async runCompaction(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('running');
    const started = Date.now();
    const complete = (summary: TurnSummary) =>
      this.emit({ type: 'turn-complete', id: randomUUID(), summary });
    try {
      const usage = await this.compactHistory(controller.signal, {
        automatic: false,
        keep: null,
        inProgress: false,
      });
      complete({
        isError: false,
        durationMs: Date.now() - started,
        costUsd: this.estimate(usage),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!this.closed) this.emit({ type: 'interrupted', id: randomUUID() });
      } else {
        this.emit({ type: 'error', id: randomUUID(), message: compactionError(error) });
        complete({
          isError: true,
          durationMs: Date.now() - started,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
        });
      }
    } finally {
      this.controller = null;
      this.setStatus(this.closed ? 'stopped' : 'idle');
    }
  }

  private denyPending(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.respondToPermission(requestId, 'deny', 'once');
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private estimate(usage: ChatUsage): number | null {
    const price = this.options.priceFor?.(this.model);
    if (!price || usage.inputTokens === null || usage.outputTokens === null) return null;
    return estimateCost(price, usage.inputTokens, usage.outputTokens);
  }

  /** Streams one model reply into the transcript and returns its text and tool calls. */
  private async streamStep(
    signal: AbortSignal,
    partial: { text: string },
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage: ChatUsage }> {
    const messageId = randomUUID();
    const textId = `${messageId}:text`;
    const reasoningId = `${messageId}:reasoning`;
    let reasoningOpen = false;
    let textOpen = false;
    let usage: ChatUsage = { inputTokens: null, outputTokens: null };
    const toolCalls: ToolCall[] = [];

    const closeReasoning = () => {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      this.emit({ type: 'block-end', id: reasoningId });
    };
    const closeBlocks = () => {
      closeReasoning();
      if (textOpen) {
        textOpen = false;
        this.emit({ type: 'block-end', id: textId });
      }
    };

    try {
      const stream = (this.options.protocol === 'anthropic' ? streamAnthropicChat : streamChat)(
        this.options.endpoint,
        {
          model: this.model,
          messages: [...this.history],
          ...(this.tools.length > 0 ? { tools: this.tools.map((tool) => tool.definition) } : {}),
        },
        signal,
      );
      for await (const chunk of stream) {
        if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'tool-call') {
          toolCalls.push(chunk.call);
        } else if (chunk.type === 'reasoning') {
          if (!reasoningOpen && !textOpen) {
            reasoningOpen = true;
            this.emit({ type: 'block-start', id: reasoningId, kind: 'thinking' });
          }
          if (reasoningOpen) this.emit({ type: 'block-delta', id: reasoningId, text: chunk.text });
        } else {
          closeReasoning();
          if (!textOpen) {
            textOpen = true;
            this.emit({ type: 'block-start', id: textId, kind: 'text' });
          }
          partial.text += chunk.text;
          this.emit({ type: 'block-delta', id: textId, text: chunk.text });
        }
      }
    } finally {
      closeBlocks();
    }
    return { text: partial.text, toolCalls, usage };
  }

  /** Asks the user to approve a tool call; resolves with their decision. */
  private requestPermission(
    toolName: string,
    input: unknown,
    toolCallId: string,
  ): Promise<PermissionBehavior> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, { toolName, resolve });
      this.emit({ type: 'permission-request', requestId, toolName, input, toolCallId });
    });
  }

  private async runTool(
    call: ToolCall,
    eventId: string,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const input = parseArguments(call.arguments);
    this.emit({
      type: 'tool-call',
      toolCallId: eventId,
      name: call.name,
      input: input ?? call.arguments,
    });
    const finish = (outcome: ToolOutcome): ToolOutcome => {
      this.emit({ type: 'tool-result', toolCallId: eventId, ...outcome });
      return outcome;
    };

    const tool = this.tools.find((entry) => entry.definition.name === call.name);
    if (!tool) return finish({ output: `There is no tool named ${call.name}.`, isError: true });
    if (!input) {
      return finish({ output: 'The arguments are not a valid JSON object.', isError: true });
    }
    const workspace = this.options.workspace;
    if (!workspace || this.mode === null) {
      return finish({ output: 'Tools are not available in this chat.', isError: true });
    }
    if (needsApproval(tool.access, this.mode) && !this.allowedTools.has(call.name)) {
      const behavior = await this.requestPermission(call.name, input, eventId);
      if (signal.aborted) return finish({ output: 'Stopped by the user.', isError: true });
      if (behavior === 'deny') {
        return finish({ output: 'The user denied this action.', isError: true });
      }
    }
    try {
      const output = await tool.run(input, { cwd: workspace.cwd, env: workspace.env, signal });
      return finish({ output, isError: false });
    } catch (error) {
      return finish({
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }

  private async runTurn(): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    this.controller = controller;
    this.setStatus('running');

    /** Index of this turn's user message, to undo the turn when it produced nothing. */
    let turnStart = this.history.length - 1;
    const turnMessage = this.history[turnStart];
    const request = turnMessage?.role === 'user' ? turnMessage.content : null;
    const started = Date.now();
    const totals = { input: 0, output: 0, cost: 0, complete: true, priced: true };
    const partial = { text: '' };

    const addUsage = (usage: ChatUsage) => {
      if (usage.inputTokens === null || usage.outputTokens === null) {
        totals.complete = false;
        return;
      }
      totals.input += usage.inputTokens;
      totals.output += usage.outputTokens;
      const cost = this.estimate(usage);
      if (cost === null) totals.priced = false;
      else totals.cost += cost;
    };

    const finishTurn = (isError: boolean) => {
      this.emit({
        type: 'turn-complete',
        id: randomUUID(),
        summary: {
          isError,
          durationMs: Date.now() - started,
          costUsd: totals.priced && totals.complete ? totals.cost : null,
          inputTokens: totals.complete ? totals.input : null,
          outputTokens: totals.complete ? totals.output : null,
        },
      });
    };

    try {
      this.emitContext();
      for (let step = 1; ; step++) {
        if (this.shouldCompact()) {
          try {
            addUsage(
              await this.compactHistory(signal, {
                automatic: true,
                keep: request,
                inProgress: step > 1,
              }),
            );
            turnStart = this.history.length - 1;
          } catch (error) {
            if (signal.aborted) throw error;
            // The turn goes on uncompacted; the server reports it if the context overflows.
            this.emit({ type: 'error', id: randomUUID(), message: compactionError(error) });
          }
        }
        const { text, toolCalls, usage } = await this.streamStep(signal, partial);
        addUsage(usage);

        // Providers may leave call ids empty; the transcript needs unique ids either way.
        const calls = toolCalls.map((call) => {
          const eventId = randomUUID();
          return { eventId, call: { ...call, id: call.id || eventId } };
        });
        this.history.push({
          role: 'assistant',
          content: text,
          ...(calls.length > 0
            ? {
                // Servers parse the arguments of earlier calls, so malformed ones are replaced;
                // the model learns about them from the tool result.
                toolCalls: calls.map(({ call }) => ({
                  ...call,
                  arguments: parseArguments(call.arguments) ? call.arguments : '{}',
                })),
              }
            : {}),
        });
        partial.text = '';
        if (usage.inputTokens !== null && usage.outputTokens !== null) {
          // The reply becomes part of the next prompt, so prompt and reply form the baseline.
          this.baseline = {
            tokens: usage.inputTokens + usage.outputTokens,
            length: this.history.length,
          };
        }
        this.emitContext();
        if (calls.length === 0) break;

        for (const [index, { eventId, call }] of calls.entries()) {
          if (signal.aborted) {
            // Every call needs a result, or the provider rejects the next request.
            for (const rest of calls.slice(index)) {
              this.history.push({
                role: 'tool',
                toolCallId: rest.call.id,
                content: 'Not run: stopped by the user.',
                isError: true,
              });
            }
            break;
          }
          const outcome = await this.runTool(call, eventId, signal);
          this.history.push({
            role: 'tool',
            toolCallId: call.id,
            content: outcome.output,
            ...(outcome.isError ? { isError: true } : {}),
          });
        }
        this.emitContext();
        if (signal.aborted) throw new Error('Stopped by the user.');
        if (step >= MAX_STEPS) {
          this.emit({
            type: 'error',
            id: randomUUID(),
            message: `Stopped after ${MAX_STEPS} model requests in one turn. Send a message to let the model continue.`,
          });
          break;
        }
      }
      finishTurn(false);
    } catch (error) {
      const madeProgress = this.history.length > turnStart + 1;
      if (signal.aborted) {
        // Keep the partial answer so the conversation stays coherent.
        if (partial.text) this.history.push({ role: 'assistant', content: partial.text });
        else if (!madeProgress) this.history.splice(turnStart);
        if (!this.closed) this.emit({ type: 'interrupted', id: randomUUID() });
      } else {
        // Drop a request that failed outright so a retry does not repeat it; work done by tools
        // earlier in the turn stays in the history.
        if (!madeProgress) this.history.splice(turnStart);
        this.emit({
          type: 'error',
          id: randomUUID(),
          message: error instanceof Error ? error.message : String(error),
        });
        finishTurn(true);
      }
    } finally {
      this.controller = null;
      this.denyPending();
      this.setStatus(this.closed ? 'stopped' : 'idle');
    }
  }
}
