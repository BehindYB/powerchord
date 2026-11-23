import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/*
 * File checkpoints for model chats. Before a tool changes a file, the file's content (or its
 * absence) is saved once per turn, so a rewind can put files back as they were before that turn.
 * Like Claude Code's checkpoints, only changes made by the file tools are tracked, not changes
 * made by commands.
 */

interface ManifestEntry {
  path: string;
  /** Name of the saved copy; null when the file did not exist before the turn. */
  copy: string | null;
}

const MANIFEST = 'manifest.json';
const TURN_ID = /^[A-Za-z0-9-]{1,100}$/;

function turnDirectory(root: string, turnId: string): string {
  if (!TURN_ID.test(turnId)) throw new Error('Invalid turn id');
  return join(root, turnId);
}

export class FileCheckpointStore {
  private readonly root: string;
  /** Serializes writes per turn so concurrent tool calls do not lose manifest entries. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  /** Saves `path` as it is now, unless this turn already saved it. */
  record(turnId: string, path: string): Promise<void> {
    const task = this.queue.then(async () => {
      const directory = turnDirectory(this.root, turnId);
      const manifest = await this.manifest(turnId);
      if (manifest.some((entry) => entry.path === path)) return;
      const content = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      await mkdir(directory, { recursive: true });
      let copy: string | null = null;
      if (content !== null) {
        copy = String(manifest.length);
        await writeFile(join(directory, copy), content);
      }
      manifest.push({ path, copy });
      await writeFile(join(directory, MANIFEST), JSON.stringify(manifest));
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Files changed during these turns. */
  async changedFiles(turnIds: readonly string[]): Promise<string[]> {
    const paths = new Set<string>();
    for (const turnId of turnIds) {
      for (const entry of await this.manifest(turnId)) paths.add(entry.path);
    }
    return [...paths];
  }

  /**
   * Puts the files changed during these turns back as they were before the first of them.
   * `turnIds` are in conversation order. Returns the restored paths.
   */
  async restore(turnIds: readonly string[]): Promise<string[]> {
    // The earliest saved copy of each file is its state before the rewound turns.
    const earliest = new Map<string, { turnId: string; copy: string | null }>();
    for (const turnId of turnIds) {
      for (const entry of await this.manifest(turnId)) {
        if (!earliest.has(entry.path)) earliest.set(entry.path, { turnId, copy: entry.copy });
      }
    }
    for (const [path, { turnId, copy }] of earliest) {
      if (copy === null) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else {
        const content = await readFile(join(turnDirectory(this.root, turnId), copy));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
    }
    return [...earliest.keys()];
  }

  /** Deletes the checkpoints of these turns. */
  async discard(turnIds: readonly string[]): Promise<void> {
    for (const turnId of turnIds) {
      await rm(turnDirectory(this.root, turnId), { recursive: true, force: true });
    }
  }

  /** Deletes every checkpoint of the session. */
  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private async manifest(turnId: string): Promise<ManifestEntry[]> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(turnDirectory(this.root, turnId), MANIFEST), 'utf8'),
      );
      return Array.isArray(value) ? (value as ManifestEntry[]) : [];
    } catch {
      return [];
    }
  }
}
