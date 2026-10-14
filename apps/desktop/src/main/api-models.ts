import {
  ANTHROPIC_BASE_URL,
  findPrice,
  listAnthropicModels,
  listModels,
  type ModelEndpoint,
} from '@powerchord/core';
import { ipcMain } from 'electron';
import { API_PROVIDERS, IpcChannel, type ApiModelInfo, type ApiProviderId } from '../shared/ipc';
import { getApiKey } from './api-keys';

/** Where each provider's chat API lives and which protocol it speaks. */
export const PROVIDER_APIS: Record<
  ApiProviderId,
  { baseUrl: string; protocol: 'openai-compatible' | 'anthropic' }
> = {
  // https://ai.google.dev/gemini-api/docs/openai
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-compatible',
  },
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai-compatible' },
  anthropic: { baseUrl: ANTHROPIC_BASE_URL, protocol: 'anthropic' },
};

const CACHE_MS = 10 * 60_000;
const cache = new Map<ApiProviderId, { at: number; key: string; models: ApiModelInfo[] }>();

/** Models the providers list that cannot hold a text chat. */
const NON_CHAT_MODEL =
  /(embedding|tts|transcribe|audio|realtime|image|dall-e|whisper|moderation|search|live|robotics|veo|lyria|imagen|aqa|computer-use|codex)/i;

function isChatModel(provider: ApiProviderId, id: string): boolean {
  if (NON_CHAT_MODEL.test(id)) return false;
  if (provider === 'openai') return /^(gpt-|o\d|chatgpt-)/.test(id);
  if (provider === 'gemini') return id.startsWith('gemini-');
  return true;
}

export function providerName(provider: ApiProviderId): string {
  return API_PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
}

export async function providerConnection(provider: ApiProviderId): Promise<ModelEndpoint> {
  const apiKey = await getApiKey(provider);
  if (!apiKey) {
    throw new Error(`Add a key for the ${providerName(provider)} in Settings, under API keys.`);
  }
  return { baseUrl: PROVIDER_APIS[provider].baseUrl, apiKey };
}

async function listApiModels(provider: ApiProviderId): Promise<ApiModelInfo[]> {
  const connection = await providerConnection(provider);
  const cached = cache.get(provider);
  if (cached && cached.key === connection.apiKey && Date.now() - cached.at < CACHE_MS) {
    return cached.models;
  }
  const signal = AbortSignal.timeout(15_000);
  const listed =
    PROVIDER_APIS[provider].protocol === 'anthropic'
      ? await listAnthropicModels(connection, signal)
      : (await listModels(connection, signal)).map((id) => {
          // Gemini names models as resources, for example "models/gemini-2.5-pro".
          const bare = id.replace(/^models\//, '');
          return { id: bare, label: bare };
        });
  const models = listed
    .filter((model) => isChatModel(provider, model.id))
    .map((model) => {
      const price = findPrice(provider, model.id);
      return { ...model, price: price ? { input: price.input, output: price.output } : null };
    });
  cache.set(provider, { at: Date.now(), key: connection.apiKey ?? '', models });
  return models;
}

export function registerApiModelHandlers(): void {
  ipcMain.handle(IpcChannel.ListApiModels, (_event, provider: unknown) => {
    if (!API_PROVIDERS.some((entry) => entry.id === provider)) throw new Error('Unknown provider');
    return listApiModels(provider as ApiProviderId);
  });
}
