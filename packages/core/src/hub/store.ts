import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  TASK_STATUSES,
  type HubNote,
  type HubSnapshot,
  type HubTask,
  type TaskStatus,
} from './types.ts';

export { TASK_STATUSES, type HubNote, type HubSnapshot, type HubTask, type TaskStatus };

/*
 * Shared context that agents and the user exchange through PowerChord: tasks and notes,
 * persisted as one local JSON file.
 */

const MAX_TITLE = 200;
const MAX_TEXT = 100_000;

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function isTask(value: unknown): value is HubTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task['id'] === 'string' &&
    typeof task['title'] === 'string' &&
    TASK_STATUSES.includes(task['status'] as TaskStatus)
  );
}

function isNote(value: unknown): value is HubNote {
  if (typeof value !== 'object' || value === null) return false;
  const note = value as Record<string, unknown>;
  return typeof note['id'] === 'string' && typeof note['title'] === 'string';
}

export class HubStore {
  private readonly path: string;
  private data: HubSnapshot | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: HubSnapshot) => void>();

  constructor(path: string) {
    this.path = path;
  }

  onChange(listener: (snapshot: HubSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(): Promise<HubSnapshot> {
    const data = await this.load();
    return { tasks: [...data.tasks], notes: [...data.notes] };
  }

  async addTask(input: { title: string; description?: string }, author: string): Promise<HubTask> {
    const title = clip(input.title.trim(), MAX_TITLE);
    if (!title) throw new Error('A task needs a title');
    const now = Date.now();
    const task: HubTask = {
      id: randomUUID().slice(0, 8),
      title,
      description: clip(input.description?.trim() ?? '', MAX_TEXT),
      status: 'open',
      summary: null,
      createdBy: author,
      updatedBy: author,
      createdAt: now,
      updatedAt: now,
    };
    await this.mutate((data) => ({ ...data, tasks: [...data.tasks, task] }));
    return task;
  }

  async updateTask(
    id: string,
    changes: { title?: string; description?: string; status?: TaskStatus; summary?: string | null },
    author: string,
  ): Promise<HubTask> {
    let updated: HubTask | undefined;
    await this.mutate((data) => ({
      ...data,
      tasks: data.tasks.map((task) => {
        if (task.id !== id) return task;
        if (changes.status !== undefined && !TASK_STATUSES.includes(changes.status)) {
          throw new Error(`Unknown status: ${changes.status}`);
        }
        updated = {
          ...task,
          ...(changes.title !== undefined
            ? { title: clip(changes.title.trim(), MAX_TITLE) || task.title }
            : {}),
          ...(changes.description !== undefined
            ? { description: clip(changes.description, MAX_TEXT) }
            : {}),
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          ...(changes.summary !== undefined
            ? { summary: changes.summary === null ? null : clip(changes.summary, MAX_TEXT) }
            : {}),
          updatedBy: author,
          updatedAt: Date.now(),
        };
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No task with id ${id}`);
    return updated;
  }

  async deleteTask(id: string): Promise<void> {
    await this.mutate((data) => ({ ...data, tasks: data.tasks.filter((task) => task.id !== id) }));
  }

  /** Creates a note, or replaces the note with the given id. */
  async saveNote(
    input: { id?: string; title: string; content: string },
    author: string,
  ): Promise<HubNote> {
    const title = clip(input.title.trim(), MAX_TITLE);
    if (!title) throw new Error('A note needs a title');
    const note: HubNote = {
      id: input.id ?? randomUUID().slice(0, 8),
      title,
      content: clip(input.content, MAX_TEXT),
      updatedBy: author,
      updatedAt: Date.now(),
    };
    await this.mutate((data) => {
      if (input.id !== undefined && !data.notes.some((existing) => existing.id === input.id)) {
        throw new Error(`No note with id ${input.id}`);
      }
      const others = data.notes.filter((existing) => existing.id !== note.id);
      return { ...data, notes: [...others, note] };
    });
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    await this.mutate((data) => ({ ...data, notes: data.notes.filter((note) => note.id !== id) }));
  }

  private async load(): Promise<HubSnapshot> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<HubSnapshot>;
      this.data = {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [],
      };
    } catch {
      this.data = { tasks: [], notes: [] };
    }
    return this.data;
  }

  /** Applies a change and persists it. Writes are serialized so concurrent changes are kept. */
  private mutate(change: (data: HubSnapshot) => HubSnapshot): Promise<void> {
    const run = async () => {
      const next = change(await this.load());
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, this.path);
      this.data = next;
      for (const listener of this.listeners)
        listener({ tasks: [...next.tasks], notes: [...next.notes] });
    };
    const result = this.writes.then(run);
    this.writes = result.catch(() => undefined);
    return result;
  }
}
