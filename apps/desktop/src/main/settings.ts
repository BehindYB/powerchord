import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';

export interface StoredModelEndpoint {
  id: string;
  name: string;
  baseUrl: string;
}

export interface HubSettings {
  /** Preferred loopback port of the MCP hub, kept stable so registered agents keep working. */
  port: number;
  /** Bearer token for agents the user registered the hub in. */
  token: string;
  /** Model used by `ask_local_model` when an agent does not name one. */
  defaultModel: { endpointId: string; model: string } | null;
}

interface Settings {
  trustedFolders: string[];
  modelEndpoints: StoredModelEndpoint[];
  hub: HubSettings;
}

const DEFAULT_HUB_PORT = 47381;

function parseHub(value: unknown): HubSettings {
  const hub = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const port =
    typeof hub['port'] === 'number' && Number.isInteger(hub['port'])
      ? hub['port']
      : DEFAULT_HUB_PORT;
  const token =
    typeof hub['token'] === 'string' && /^[0-9a-f]{64}$/.test(hub['token'])
      ? hub['token']
      : randomBytes(32).toString('hex');
  const preferred = hub['defaultModel'] as Record<string, unknown> | null | undefined;
  const defaultModel =
    preferred &&
    typeof preferred['endpointId'] === 'string' &&
    typeof preferred['model'] === 'string'
      ? { endpointId: preferred['endpointId'], model: preferred['model'] }
      : null;
  return { port, token, defaultModel };
}

let cache: Settings | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function isStoredEndpoint(value: unknown): value is StoredModelEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['name'] === 'string' &&
    typeof entry['baseUrl'] === 'string'
  );
}

async function load(): Promise<Settings> {
  if (cache) return cache;
  let parsed: Partial<Record<keyof Settings, unknown>> = {};
  try {
    parsed = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof parsed;
  } catch {
    // Missing or unreadable settings start from defaults.
  }
  cache = {
    trustedFolders: Array.isArray(parsed.trustedFolders)
      ? parsed.trustedFolders.filter((entry): entry is string => typeof entry === 'string')
      : [],
    modelEndpoints: Array.isArray(parsed.modelEndpoints)
      ? parsed.modelEndpoints.filter(isStoredEndpoint)
      : [],
    hub: parseHub(parsed.hub),
  };
  return cache;
}

async function save(settings: Settings): Promise<void> {
  cache = settings;
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  // Write to a temporary file first so a crash cannot leave a truncated settings file.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8');
  await rename(temporary, path);
}

function normalizeFolder(folder: string): string {
  const absolute = resolve(folder);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export async function isFolderTrusted(folder: string): Promise<boolean> {
  const settings = await load();
  return settings.trustedFolders.includes(normalizeFolder(folder));
}

export async function trustFolder(folder: string): Promise<void> {
  const settings = await load();
  const normalized = normalizeFolder(folder);
  if (settings.trustedFolders.includes(normalized)) return;
  await save({ ...settings, trustedFolders: [...settings.trustedFolders, normalized] });
}

export async function getModelEndpoints(): Promise<StoredModelEndpoint[]> {
  return (await load()).modelEndpoints;
}

/** Adds an endpoint, or returns the existing one with the same base URL. */
export async function addModelEndpoint(
  baseUrl: string,
  name: string,
): Promise<StoredModelEndpoint> {
  const settings = await load();
  const existing = settings.modelEndpoints.find((entry) => entry.baseUrl === baseUrl);
  if (existing) return existing;
  const endpoint = { id: randomUUID(), name, baseUrl };
  await save({ ...settings, modelEndpoints: [...settings.modelEndpoints, endpoint] });
  return endpoint;
}

export async function removeModelEndpoint(id: string): Promise<void> {
  const settings = await load();
  await save({
    ...settings,
    modelEndpoints: settings.modelEndpoints.filter((entry) => entry.id !== id),
  });
}

/** Hub settings; a token is generated and saved on first use. */
export async function getHubSettings(): Promise<HubSettings> {
  const settings = await load();
  await save(settings);
  return settings.hub;
}

export async function setHubDefaultModel(defaultModel: HubSettings['defaultModel']): Promise<void> {
  const settings = await load();
  await save({ ...settings, hub: { ...settings.hub, defaultModel } });
}
