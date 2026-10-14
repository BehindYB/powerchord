import {
  readServerSentEvents,
  responseError,
  type ChatMessage,
  type ChatStreamChunk,
  type ModelEndpoint,
} from './openai-compatible.ts';

/*
 * Client for Anthropic's Messages API (https://platform.claude.com/docs/en/api/messages),
 * used with the user's own API key.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
/** Fits every current model's output limit. */
const DEFAULT_MAX_TOKENS = 8192;

function headers(endpoint: ModelEndpoint): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(endpoint.apiKey ? { 'x-api-key': endpoint.apiKey } : {}),
  };
}

function url(endpoint: ModelEndpoint, path: string): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}${path}`;
}

export async function listAnthropicModels(
  endpoint: ModelEndpoint,
  signal?: AbortSignal,
): Promise<{ id: string; label: string }[]> {
  const response = await fetch(url(endpoint, '/models?limit=100'), {
    headers: headers(endpoint),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as { data?: { id?: unknown; display_name?: unknown }[] };
  return (body.data ?? []).flatMap((model) =>
    typeof model.id === 'string'
      ? [
          {
            id: model.id,
            label: typeof model.display_name === 'string' ? model.display_name : model.id,
          },
        ]
      : [],
  );
}

/** Streams a reply, yielding the same chunks as the OpenAI-compatible client. */
export async function* streamAnthropicChat(
  endpoint: ModelEndpoint,
  request: { model: string; messages: ChatMessage[]; maxTokens?: number },
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamChunk> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const response = await fetch(url(endpoint, '/messages'), {
    method: 'POST',
    headers: headers(endpoint),
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content })),
      stream: true,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) throw await responseError(response);

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for await (const data of readServerSentEvents(response.body)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event['type']) {
      case 'message_start': {
        const usage = (event['message'] as { usage?: Record<string, unknown> } | undefined)?.usage;
        // Cached prompt tokens are billed too, at their own rates; they count as input here.
        inputTokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
          .map((key) => usage?.[key])
          .reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
        break;
      }
      case 'content_block_delta': {
        const delta = event['delta'] as { type?: string; text?: string; thinking?: string };
        if (delta.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
        if (delta.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', text: delta.thinking };
        }
        break;
      }
      case 'message_delta': {
        const usage = event['usage'] as { output_tokens?: unknown } | undefined;
        if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
        break;
      }
      case 'error': {
        const error = event['error'] as { message?: string } | undefined;
        throw new Error(error?.message ?? 'The API reported an error.');
      }
    }
  }
  yield { type: 'usage', usage: { inputTokens, outputTokens } };
}
