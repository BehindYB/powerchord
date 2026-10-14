import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PRICES_REVIEWED } from '@powerchord/core';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  IpcChannel,
  type ApiProviderId,
  type ProviderUsage,
  type UsageOverview,
} from '../shared/ipc';
import { getBudgets, parseBudgets, setBudgets } from './settings';

/*
 * Estimated pay-as-you-go spending per provider and calendar month, kept on this computer.
 * Providers bill by their own records; this ledger only drives budgets and warnings.
 */

type Ledger = Record<string, Partial<Record<ApiProviderId, ProviderUsage>>>;

let cache: Ledger | null = null;
let writes: Promise<void> = Promise.resolve();

function ledgerPath(): string {
  return join(app.getPath('userData'), 'usage.json');
}

export function currentMonth(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function load(): Promise<Ledger> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerPath(), 'utf8'));
    cache = typeof parsed === 'object' && parsed !== null ? (parsed as Ledger) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(ledger: Ledger): Promise<void> {
  writes = writes
    .then(async () => {
      const path = ledgerPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(ledger, null, 2), 'utf8');
      await rename(`${path}.tmp`, path);
    })
    .catch(() => {
      // The next recorded turn writes the ledger again.
    });
  return writes;
}

export async function usageOverview(): Promise<UsageOverview> {
  const month = currentMonth();
  return {
    month,
    providers: { ...(await load())[month] },
    budgets: await getBudgets(),
    pricesReviewed: PRICES_REVIEWED,
  };
}

export async function monthSpend(provider: ApiProviderId): Promise<number> {
  return (await load())[currentMonth()]?.[provider]?.costUsd ?? 0;
}

async function broadcast(): Promise<void> {
  const overview = await usageOverview();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IpcChannel.UsageChanged, overview);
    }
  }
}

/** Adds one turn's usage to the current month. */
export async function recordUsage(
  provider: ApiProviderId,
  turn: { costUsd: number | null; inputTokens: number | null; outputTokens: number | null },
): Promise<void> {
  const ledger = await load();
  const month = currentMonth();
  const previous = ledger[month]?.[provider] ?? {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  };
  ledger[month] = {
    ...ledger[month],
    [provider]: {
      costUsd: previous.costUsd + (turn.costUsd ?? 0),
      inputTokens: previous.inputTokens + (turn.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (turn.outputTokens ?? 0),
      requests: previous.requests + 1,
    },
  };
  await persist(ledger);
  await broadcast();
}

export function registerUsageHandlers(): void {
  ipcMain.handle(IpcChannel.GetUsage, () => usageOverview());
  ipcMain.handle(IpcChannel.SetBudgets, async (_event, budgets: unknown) => {
    // Unknown providers and invalid amounts are dropped.
    await setBudgets(parseBudgets(budgets));
    await broadcast();
  });
}
