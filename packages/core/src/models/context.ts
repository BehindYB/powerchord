import type { ModelEndpoint } from './openai-compatible.ts';

/*
 * Context window sizes, read from the server or provider that runs the model. Every lookup is
 * best effort: a null result means the size is unknown, and callers show usage without a limit.
 */

const LOOKUP_TIMEOUT_MS = 4000;

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    const response = await fetch(url, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Reads `--ctx-size N` or `-c N` from the arguments a llama.cpp router reports for a model. */
export function contextSizeFromArgs(args: unknown): number | null {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '--ctx-size' || args[index] === '-c') {
      const size = Number(args[index + 1]);
      if (isPositive(size)) return size;
    }
  }
  return null;
}

/**
 * Context size a self-hosted server runs a model with. Understands llama.cpp (router and single
 * model), Ollama and LM Studio; other servers report nothing.
 */
export async function fetchServerContextWindow(
  endpoint: ModelEndpoint,
  model: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  const headers: Record<string, string> = endpoint.apiKey
    ? { Authorization: `Bearer ${endpoint.apiKey}` }
    : {};
  const name = encodeURIComponent(model);

  // llama.cpp router: each model lists the arguments its instance runs with.
  const listed = (await getJson(`${base}/models`, headers, signal)) as { data?: unknown } | null;
  if (Array.isArray(listed?.data)) {
    const entry = listed.data.find((item) => (item as { id?: unknown } | null)?.id === model) as
      { status?: { args?: unknown } } | undefined;
    const fromArgs = contextSizeFromArgs(entry?.status?.args);
    if (fromArgs) return fromArgs;
  }

  // llama.cpp: the loaded context size, per model in router mode.
  const props = (await getJson(`${root}/props?model=${name}`, headers, signal)) as {
    default_generation_settings?: { n_ctx?: unknown };
  } | null;
  if (isPositive(props?.default_generation_settings?.n_ctx)) {
    return props.default_generation_settings.n_ctx;
  }

  // Ollama: running models report the context they were loaded with.
  const running = (await getJson(`${root}/api/ps`, headers, signal)) as { models?: unknown } | null;
  if (Array.isArray(running?.models)) {
    const entry = running.models.find((item) => {
      const value = item as { name?: unknown; model?: unknown } | null;
      return value?.name === model || value?.model === model;
    }) as { context_length?: unknown } | undefined;
    if (isPositive(entry?.context_length)) return entry.context_length;
  }

  // LM Studio's own REST API.
  const studio = (await getJson(`${root}/api/v0/models/${name}`, headers, signal)) as {
    loaded_context_length?: unknown;
    max_context_length?: unknown;
  } | null;
  if (isPositive(studio?.loaded_context_length)) return studio.loaded_context_length;
  if (isPositive(studio?.max_context_length)) return studio.max_context_length;
  return null;
}

/** Input context window of an Anthropic model, from the Models API (`max_input_tokens`). */
export async function fetchAnthropicContextWindow(
  endpoint: ModelEndpoint,
  model: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const body = (await getJson(
    `${endpoint.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`,
    {
      'anthropic-version': '2023-06-01',
      ...(endpoint.apiKey ? { 'x-api-key': endpoint.apiKey } : {}),
    },
    signal,
  )) as { max_input_tokens?: unknown } | null;
  return isPositive(body?.max_input_tokens) ? body.max_input_tokens : null;
}

export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Input token limit of a Gemini model, from the Gemini API's models.get (`inputTokenLimit`). */
export async function fetchGeminiContextWindow(
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  baseUrl = GEMINI_MODELS_URL,
): Promise<number | null> {
  const id = model.replace(/^models\//, '');
  const body = (await getJson(
    `${baseUrl}/${encodeURIComponent(id)}`,
    { 'x-goog-api-key': apiKey },
    signal,
  )) as { inputTokenLimit?: unknown } | null;
  return isPositive(body?.inputTokenLimit) ? body.inputTokenLimit : null;
}
