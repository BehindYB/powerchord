import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Private project memory: notes the user, and agents with the user's approval, keep about a
 * project. It is stored in PowerChord's data folder, one Markdown file per project, and never in
 * the project folder, so it stays on this computer and out of the repository.
 */

/** Longest memory kept per project; older text is kept, new notes are refused past it. */
export const MAX_MEMORY_CHARS = 50_000;
const MAX_NOTE_CHARS = 2_000;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

export function memoryPrompt(memory: string): string {
  const text = memory.trim();
  return text
    ? 'Project memory: notes the user keeps about this project in PowerChord. Use them as ' +
        `background; the user's current messages take precedence.\n\n<memory>\n${text}\n</memory>`
    : '';
}

export class ProjectMemoryStore {
  private readonly directory: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  private path(projectId: string): string {
    if (!ID_PATTERN.test(projectId)) throw new Error('Invalid project');
    return join(this.directory, `${projectId}.md`);
  }

  async read(projectId: string): Promise<string> {
    try {
      return await readFile(this.path(projectId), 'utf8');
    } catch {
      return '';
    }
  }

  async write(projectId: string, text: string): Promise<void> {
    if (text.length > MAX_MEMORY_CHARS) {
      throw new Error(`The memory is limited to ${MAX_MEMORY_CHARS.toLocaleString()} characters.`);
    }
    const path = this.path(projectId);
    // Queued and atomic, so concurrent saves never interleave or leave half a file.
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${path}.tmp`, text, 'utf8');
      await rename(`${path}.tmp`, path);
    });
    // A failed write is reported to its caller without blocking later ones.
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** Adds a dated note to the end of the memory. */
  async append(projectId: string, note: string, author: string, now = new Date()): Promise<void> {
    const clean = note.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('The note is empty.');
    if (clean.length > MAX_NOTE_CHARS) {
      throw new Error(`Notes are limited to ${MAX_NOTE_CHARS} characters.`);
    }
    const current = await this.read(projectId);
    const line = `- ${clean} (${author}, ${now.toISOString().slice(0, 10)})`;
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await this.write(projectId, `${current}${separator}${line}\n`);
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.path(projectId), { force: true });
  }
}
