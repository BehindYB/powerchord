import { ipcMain } from 'electron';
import { API_PROVIDERS, IpcChannel, type ApiKeyInfo, type ApiProviderId } from '../shared/ipc';
import { deleteSecret, getSecret, secretHint, setSecret, type SecretId } from './secrets';

/** Requests that check a key against the provider without using paid capacity. */
const KEY_CHECKS: Record<ApiProviderId, (key: string) => Request> = {
  gemini: (key) =>
    new Request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key },
    }),
  openai: (key) =>
    new Request('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    }),
  anthropic: (key) =>
    new Request('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }),
};

function secretId(provider: ApiProviderId): SecretId {
  return `api:${provider}`;
}

function isProvider(value: unknown): value is ApiProviderId {
  return API_PROVIDERS.some((provider) => provider.id === value);
}

export function getApiKey(provider: ApiProviderId): Promise<string | null> {
  return getSecret(secretId(provider));
}

async function listApiKeys(): Promise<ApiKeyInfo[]> {
  return Promise.all(
    API_PROVIDERS.map(async (provider) => {
      const hint = await secretHint(secretId(provider.id)).catch(() => null);
      return { provider: provider.id, configured: hint !== null, hint };
    }),
  );
}

async function checkKey(provider: ApiProviderId, key: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(KEY_CHECKS[provider](key), { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(
      `Could not reach the provider to check the key: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    throw new Error('The provider rejected this key.');
  }
  if (!response.ok)
    throw new Error(`The provider answered ${response.status} when checking the key.`);
}

export function registerApiKeyHandlers(): void {
  ipcMain.handle(IpcChannel.ListApiKeys, () => listApiKeys());
  ipcMain.handle(IpcChannel.SetApiKey, async (_event, provider: unknown, key: unknown) => {
    if (!isProvider(provider)) throw new Error('Unknown provider');
    if (typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key.trim())) {
      throw new Error('This does not look like an API key.');
    }
    await checkKey(provider, key.trim());
    await setSecret(secretId(provider), key.trim());
  });
  ipcMain.handle(IpcChannel.DeleteApiKey, async (_event, provider: unknown) => {
    if (!isProvider(provider)) throw new Error('Unknown provider');
    await deleteSecret(secretId(provider));
  });
}
