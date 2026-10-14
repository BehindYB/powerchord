import {
  discoverServers,
  listModels,
  type ModelEndpoint,
  localInterfaceAddresses,
  normalizeBaseUrl,
  planDiscovery,
  readNeighborAddresses,
} from '@powerchord/core';
import { ipcMain, type WebContents } from 'electron';
import {
  IpcChannel,
  type DiscoveryProgress,
  type DiscoveryResult,
  type ModelEndpointInfo,
} from '../shared/ipc';
import { deleteSecret, getSecret, setSecret } from './secrets';
import {
  addModelEndpoint,
  getModelEndpoints,
  removeModelEndpoint,
  type StoredModelEndpoint,
} from './settings';

const PROBE_TIMEOUT_MS = 4000;

let discoveryRunning = false;

/** Address and, for servers that require one, the key the user stored for them. */
export async function endpointConnection(endpoint: StoredModelEndpoint): Promise<ModelEndpoint> {
  const apiKey = await getSecret(`endpoint:${endpoint.id}`).catch(() => null);
  return apiKey ? { baseUrl: endpoint.baseUrl, apiKey } : { baseUrl: endpoint.baseUrl };
}

async function describeEndpoint(endpoint: StoredModelEndpoint): Promise<ModelEndpointInfo> {
  try {
    const models = await listModels(
      await endpointConnection(endpoint),
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    );
    return { ...endpoint, online: true, models, error: null };
  } catch (error) {
    return {
      ...endpoint,
      online: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listEndpointInfos(): Promise<ModelEndpointInfo[]> {
  return Promise.all((await getModelEndpoints()).map(describeEndpoint));
}

export async function findEndpoint(id: string): Promise<StoredModelEndpoint | undefined> {
  return (await getModelEndpoints()).find((endpoint) => endpoint.id === id);
}

async function addEndpoint(
  input: string,
  name: string | undefined,
  apiKey: string | undefined,
): Promise<ModelEndpointInfo> {
  const baseUrl = normalizeBaseUrl(input);
  // Only endpoints that answer like a model server are saved.
  const models = await listModels(
    apiKey ? { baseUrl, apiKey } : { baseUrl },
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
  );
  const stored = await addModelEndpoint(baseUrl, name?.trim() || new URL(baseUrl).host);
  if (apiKey) await setSecret(`endpoint:${stored.id}`, apiKey);
  return { ...stored, online: true, models, error: null };
}

async function discover(sender: WebContents): Promise<DiscoveryResult> {
  if (discoveryRunning) throw new Error('A network scan is already running.');
  discoveryRunning = true;
  try {
    const known = await getModelEndpoints();
    const plan = planDiscovery({
      interfaces: localInterfaceAddresses(),
      neighbors: await readNeighborAddresses(),
      previousHosts: known.map((endpoint) => new URL(endpoint.baseUrl).hostname),
    });
    const servers = await discoverServers({
      hosts: plan.hosts,
      onProgress: (done, total) => {
        if (sender.isDestroyed()) return;
        const progress: DiscoveryProgress = { done, total };
        sender.send(IpcChannel.DiscoveryProgress, progress);
      },
    });
    const knownUrls = new Set(known.map((endpoint) => endpoint.baseUrl));
    return {
      networks: plan.networks,
      hostsScanned: plan.hosts.length,
      servers: servers.map((server) => ({
        baseUrl: server.baseUrl,
        name: `${server.serverHint} on ${server.host}`,
        models: server.models,
        alreadyAdded: knownUrls.has(server.baseUrl),
      })),
    };
  } finally {
    discoveryRunning = false;
  }
}

export function registerModelHandlers(): void {
  ipcMain.handle(IpcChannel.ListModelEndpoints, () => listEndpointInfos());
  ipcMain.handle(
    IpcChannel.AddModelEndpoint,
    (_event, baseUrl: unknown, name: unknown, apiKey: unknown) => {
      if (typeof baseUrl !== 'string') throw new Error('Invalid address');
      if (apiKey !== undefined && apiKey !== '' && typeof apiKey !== 'string') {
        throw new Error('Invalid key');
      }
      return addEndpoint(
        baseUrl,
        typeof name === 'string' ? name : undefined,
        typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined,
      );
    },
  );
  ipcMain.handle(IpcChannel.RemoveModelEndpoint, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid endpoint');
    await removeModelEndpoint(id);
    await deleteSecret(`endpoint:${id}`);
  });
  ipcMain.handle(IpcChannel.DiscoverModelServers, (event) => discover(event.sender));
}
