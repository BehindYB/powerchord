import { randomUUID } from 'node:crypto';
import {
  streamChat,
  type ChatMessage,
  type ChatUsage,
  type ModelEndpoint,
} from '../../models/openai-compatible.ts';
import type { SessionEvent, SessionStatus, TranscriptItem } from '../types.ts';

export interface ModelChatSessionOptions {
  endpoint: ModelEndpoint;
  model: string;
  systemPrompt?: string;
  onEvent: (event: SessionEvent) => void;
  /** Earlier conversation, for example restored from a saved transcript. */
  history?: ChatMessage[];
  /** Identifier of a restored conversation. */
  agentSessionId?: string;
}

/**
 * Rebuilds the chat history from a transcript. Messages without an answer are left out, matching
 * what a live session keeps after a failed or interrupted request.
 */
export function chatHistoryFromTranscript(items: readonly TranscriptItem[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  let question: string | null = null;
  let answer = '';
  const flush = () => {
    if (question !== null && answer) {
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    }
    question = null;
    answer = '';
  };
  for (const item of items) {
    if (item.kind === 'user') {
      flush();
      question = item.text;
    } else if (item.kind === 'text' && question !== null) {
      answer += item.text;
    }
  }
  flush();
  return history;
}

/** A chat session with a model served by an OpenAI-compatible endpoint. */
export class ModelChatSession {
  readonly agentSessionId: string;
  private readonly options: ModelChatSessionOptions;
  private readonly history: ChatMessage[] = [];
  private model: string;
  private status: SessionStatus = 'idle';
  private controller: AbortController | null = null;
  private closed = false;

  constructor(options: ModelChatSessionOptions) {
    this.options = options;
    this.agentSessionId = options.agentSessionId ?? randomUUID();
    this.model = options.model;
    if (options.systemPrompt) this.history.push({ role: 'system', content: options.systemPrompt });
    if (options.history) this.history.push(...options.history);
    // Deferred so the owner can finish registering the session before the first event.
    queueMicrotask(() =>
      this.emit({
        type: 'session-info',
        agentSessionId: this.agentSessionId,
        model: this.model,
        permissionMode: null,
      }),
    );
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
  }

  setModel(model: string | null): void {
    if (!model) throw new Error('A model is required');
    this.model = model;
    this.emit({
      type: 'session-info',
      agentSessionId: this.agentSessionId,
      model,
      permissionMode: null,
    });
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private async runTurn(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('running');

    const messageId = randomUUID();
    const textId = `${messageId}:text`;
    const reasoningId = `${messageId}:reasoning`;
    let reasoningOpen = false;
    let textOpen = false;
    let answer = '';
    let usage: ChatUsage = { inputTokens: null, outputTokens: null };
    const started = Date.now();

    const closeReasoning = () => {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      this.emit({ type: 'block-end', id: reasoningId });
    };

    try {
      const stream = streamChat(
        this.options.endpoint,
        { model: this.model, messages: [...this.history] },
        controller.signal,
      );
      for await (const chunk of stream) {
        if (chunk.type === 'usage') {
          usage = chunk.usage;
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
          answer += chunk.text;
          this.emit({ type: 'block-delta', id: textId, text: chunk.text });
        }
      }
      closeReasoning();
      if (textOpen) this.emit({ type: 'block-end', id: textId });
      this.history.push({ role: 'assistant', content: answer });
      this.emit({
        type: 'turn-complete',
        id: randomUUID(),
        summary: {
          isError: false,
          durationMs: Date.now() - started,
          costUsd: null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // Keep the partial answer so the conversation stays coherent.
        if (answer) this.history.push({ role: 'assistant', content: answer });
        else this.history.pop();
        if (!this.closed) this.emit({ type: 'interrupted', id: randomUUID() });
      } else {
        // Drop the failed request so a retry does not repeat it in the history.
        this.history.pop();
        this.emit({
          type: 'error',
          id: randomUUID(),
          message: error instanceof Error ? error.message : String(error),
        });
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
      this.controller = null;
      this.setStatus(this.closed ? 'stopped' : 'idle');
    }
  }
}
