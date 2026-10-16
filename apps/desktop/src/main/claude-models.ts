import {
  buildChildEnv,
  detectAgent,
  getAgent,
  listClaudeCodeModels,
  resolveSearchPath,
} from '@powerchord/core';
import { app, ipcMain } from 'electron';
import { IpcChannel, type ModelOption } from '../shared/ipc';

/** Claude Code's model list changes only with its releases. */
const CACHE_MS = 30 * 60 * 1000;

let cached: { at: number; models: ModelOption[] } | null = null;
let pending: Promise<ModelOption[]> | null = null;

async function queryClaudeModels(): Promise<ModelOption[]> {
  const searchPath = await resolveSearchPath();
  const status = await detectAgent(getAgent('claude-code'), { searchPath });
  if (!status.path) throw new Error('Claude Code is not installed.');
  const { defaultLabel, models } = await listClaudeCodeModels({
    executable: status.path,
    // A neutral folder, so no project settings or MCP servers are loaded for the query.
    cwd: app.getPath('userData'),
    env: buildChildEnv(searchPath),
  });
  return [
    { id: null, label: defaultLabel ? `Default (${defaultLabel})` : 'Default' },
    ...models.map(({ id, label }) => ({ id, label })),
  ];
}

export function listClaudeModels(): Promise<ModelOption[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.models);
  pending ??= queryClaudeModels()
    .then((models) => {
      cached = { at: Date.now(), models };
      return models;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function registerClaudeModelHandlers(): void {
  ipcMain.handle(IpcChannel.ListClaudeModels, () => listClaudeModels());
}
