/*
 * Minimal client for OpenAI-compatible inference servers (Ollama, LM Studio, llama.cpp server,
 * vLLM, Jan and others), used for local and self-hosted models.
 */

export interface ModelEndpoint {
  /** Base URL including the API prefix, for example `http://10.0.0.5:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ChatStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: ChatUsage };

function headers(endpoint: ModelEndpoint): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) result['Authorization'] = `Bearer ${endpoint.apiKey}`;
  return result;
}

function url(endpoint: ModelEndpoint, path: string): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Normalizes user input such as `10.0.0.5:11434` into a base URL ending in `/v1`. */
export function normalizeBaseUrl(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const parsed = new URL(value);
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

/** Lists model ids. Throws if the server does not answer like an OpenAI-compatible API. */
export async function listModels(endpoint: ModelEndpoint, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(url(endpoint, '/models'), {
    headers: headers(endpoint),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new Error(`The server answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('The server did not return a model list');
  return body.data
    .map((model) =>
      typeof model === 'object' && model !== null ? (model as { id?: unknown }).id : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
    .sort((a, b) => a.localeCompare(b));
}

/** Splits a server-sent events stream into the `data:` payloads of its events. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const rawEvent = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) yield rest.slice(5).trim();
}

function parseChunk(data: string): ChatStreamChunk[] {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return [];
  }
  if (typeof payload !== 'object' || payload === null) return [];
  const { choices, usage } = payload as { choices?: unknown; usage?: unknown };
  const chunks: ChatStreamChunk[] = [];

  if (Array.isArray(choices)) {
    const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta ?? {};
    // Servers name reasoning output differently: `reasoning_content` (llama.cpp, vLLM, LM Studio)
    // or `reasoning` (Ollama).
    const reasoning = delta['reasoning_content'] ?? delta['reasoning'];
    if (typeof reasoning === 'string' && reasoning)
      chunks.push({ type: 'reasoning', text: reasoning });
    if (typeof delta['content'] === 'string' && delta['content']) {
      chunks.push({ type: 'text', text: delta['content'] });
    }
  }
  if (typeof usage === 'object' && usage !== null) {
    const { prompt_tokens, completion_tokens } = usage as Record<string, unknown>;
    chunks.push({
      type: 'usage',
      usage: {
        inputTokens: typeof prompt_tokens === 'number' ? prompt_tokens : null,
        outputTokens: typeof completion_tokens === 'number' ? completion_tokens : null,
      },
    });
  }
  return chunks;
}

/** Streams a chat completion. */
export async function* streamChat(
  endpoint: ModelEndpoint,
  request: { model: string; messages: ChatMessage[]; maxTokens?: number },
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamChunk> {
  const response = await fetch(url(endpoint, '/chat/completions'), {
    method: 'POST',
    headers: headers(endpoint),
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `The server answered ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    );
  }
  for await (const data of readServerSentEvents(response.body)) {
    if (data === '[DONE]') return;
    yield* parseChunk(data);
  }
}

/** Runs a chat completion to the end and returns the answer text. */
export async function completeChat(
  endpoint: ModelEndpoint,
  request: { model: string; messages: ChatMessage[]; maxTokens?: number },
  signal?: AbortSignal,
): Promise<{ text: string; usage: ChatUsage }> {
  let text = '';
  let usage: ChatUsage = { inputTokens: null, outputTokens: null };
  // Streaming keeps long generations alive through proxies and lets callers cancel promptly.
  for await (const chunk of streamChat(endpoint, request, signal)) {
    if (chunk.type === 'text') text += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { text, usage };
}
