import {
  readServerSentEvents,
  responseError,
  type ChatMessage,
  type ChatRequest,
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

type ContentBlock = Record<string, unknown>;

function parseToolInput(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text || '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Converts messages to the Messages API format: tool results travel in user messages, and
 * consecutive messages of the same role are merged because the API expects them to alternate.
 */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
): { role: 'user' | 'assistant'; content: ContentBlock[] }[] {
  const result: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    let role: 'user' | 'assistant';
    let content: ContentBlock[];
    if (message.role === 'tool') {
      role = 'user';
      content = [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        },
      ];
    } else {
      role = message.role;
      content = message.content ? [{ type: 'text', text: message.content }] : [];
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parseToolInput(call.arguments),
          });
        }
      }
    }
    if (content.length === 0) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

/** Streams a reply, yielding the same chunks as the OpenAI-compatible client. */
export async function* streamAnthropicChat(
  endpoint: ModelEndpoint,
  request: ChatRequest,
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
      messages: toAnthropicMessages(request.messages),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      stream: true,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) throw await responseError(response);

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  /** Tool calls being streamed, by content block index. */
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
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
      case 'content_block_start': {
        const block = event['content_block'] as { type?: string; id?: unknown; name?: unknown };
        if (block.type === 'tool_use' && typeof event['index'] === 'number') {
          toolCalls.set(event['index'], {
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            arguments: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event['delta'] as {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
        if (delta.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
        if (delta.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', text: delta.thinking };
        }
        if (delta.type === 'input_json_delta' && typeof event['index'] === 'number') {
          const call = toolCalls.get(event['index']);
          if (call) call.arguments += delta.partial_json ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const index = event['index'];
        const call = typeof index === 'number' ? toolCalls.get(index) : undefined;
        if (call) {
          toolCalls.delete(index as number);
          // Tools without parameters stream no input at all.
          yield { type: 'tool-call', call: { ...call, arguments: call.arguments || '{}' } };
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
