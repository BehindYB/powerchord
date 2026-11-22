import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import type { ProjectSummary } from '../shared/ipc';

/*
 * Projects group chats that work in the same folder. They live in one JSON file in the user
 * data folder; the project folder itself is never written to by this store.
 */

const FORMAT_VERSION = 1;
const MAX_NAME = 120;

interface ProjectsFile {
  version: number;
  projects: ProjectSummary[];
}

function isProject(value: unknown): value is ProjectSummary {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project['id'] === 'string' &&
    typeof project['name'] === 'string' &&
    typeof project['folder'] === 'string' &&
    typeof project['createdAt'] === 'number'
  );
}

/** Folder paths compared the way the file system does: case-insensitively on Windows. */
export function folderKey(folder: string): string {
  const path = resolve(folder);
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

export function cleanProjectName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export class ProjectStore {
  private readonly path = join(app.getPath('userData'), 'projects.json');
  private projects: ProjectSummary[] = [];
  private writes: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ProjectsFile>;
      if (parsed.version === FORMAT_VERSION && Array.isArray(parsed.projects)) {
        this.projects = parsed.projects.filter(isProject);
      }
    } catch {
      // No projects yet, or an unreadable file: start empty rather than failing.
    }
  }

  list(): ProjectSummary[] {
    return [...this.projects];
  }

  get(id: unknown): ProjectSummary | undefined {
    return typeof id === 'string' ? this.projects.find((project) => project.id === id) : undefined;
  }

  findByFolder(folder: string): ProjectSummary | undefined {
    const key = folderKey(folder);
    return this.projects.find((project) => folderKey(project.folder) === key);
  }

  /** The project of a folder, created when there is none yet. */
  async ensure(folder: string, createdAt = Date.now()): Promise<ProjectSummary> {
    const existing = this.findByFolder(folder);
    if (existing) return existing;
    const project: ProjectSummary = {
      id: randomUUID(),
      name: cleanProjectName(basename(resolve(folder))) || folder,
      folder,
      createdAt,
    };
    this.projects.push(project);
    await this.save();
    return project;
  }

  async rename(id: string, name: string): Promise<ProjectSummary> {
    const project = this.get(id);
    const clean = cleanProjectName(name);
    if (!project) throw new Error('Unknown project');
    if (!clean) throw new Error('Enter a name');
    const renamed = { ...project, name: clean };
    this.projects = this.projects.map((entry) => (entry.id === id ? renamed : entry));
    await this.save();
    return renamed;
  }

  async remove(id: string): Promise<void> {
    this.projects = this.projects.filter((project) => project.id !== id);
    await this.save();
  }

  private save(): Promise<void> {
    const file: ProjectsFile = { version: FORMAT_VERSION, projects: this.projects };
    const text = JSON.stringify(file, null, 2);
    // Writes are queued and atomic, so a crash never leaves half a file.
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, this.path);
    });
    // A failed write is reported to its caller without blocking later ones.
    this.writes = write.catch(() => undefined);
    return write;
  }
}
