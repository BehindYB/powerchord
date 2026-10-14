import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState } from '@powerchord/core';
import { app } from 'electron';
import type { SessionSummary } from '../shared/ipc';

/*
 * Session history on disk: one JSON file per session in the user data folder. The agents keep
 * their own conversation records as well; these files hold what PowerChord shows and the ids it
 * needs to resume a conversation.
 */

const FORMAT_VERSION = 1;
const SAVE_DELAY_MS = 1000;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

export interface StoredSession {
  summary: SessionSummary;
  state: SessionState;
}

interface SessionFile extends StoredSession {
  version: number;
}

function isStoredSession(value: unknown): value is SessionFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<SessionFile>;
  return (
    file.version === FORMAT_VERSION &&
    typeof file.summary?.id === 'string' &&
    ID_PATTERN.test(file.summary.id) &&
    Array.isArray(file.state?.items)
  );
}

export class SessionStore {
  private readonly directory = join(app.getPath('userData'), 'sessions');
  private readonly pending = new Map<string, () => StoredSession>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private writes: Promise<void> = Promise.resolve();

  async loadAll(): Promise<StoredSession[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const sessions: StoredSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        if (isStoredSession(parsed))
          sessions.push({ summary: parsed.summary, state: parsed.state });
      } catch {
        // A damaged file is skipped rather than blocking the other sessions.
      }
    }
    return sessions;
  }

  /** Schedules a save; `read` is called when the write happens, so it captures the latest state. */
  save(id: string, read: () => StoredSession): void {
    if (!ID_PATTERN.test(id)) return;
    this.pending.set(id, read);
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => this.writeNow(id), SAVE_DELAY_MS),
    );
  }

  async delete(id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    this.cancel(id);
    await this.enqueue(() => rm(this.path(id), { force: true }));
  }

  /** Writes every scheduled save immediately. */
  async flush(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.writeNow(id);
    await this.writes;
  }

  private path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
  }

  private writeNow(id: string): void {
    const read = this.pending.get(id);
    this.cancel(id);
    if (!read) return;
    const file: SessionFile = { version: FORMAT_VERSION, ...read() };
    void this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      // Write to a temporary file first so a crash cannot leave a truncated session file.
      const temporary = `${this.path(id)}.tmp`;
      await writeFile(temporary, JSON.stringify(file), 'utf8');
      await rename(temporary, this.path(id));
    });
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(write).catch(() => {
      // A failed write is retried with the next change to the session.
    });
    return this.writes;
  }
}
