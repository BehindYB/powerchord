import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';

interface Settings {
  trustedFolders: string[];
}

const DEFAULTS: Settings = { trustedFolders: [] };

let cache: Settings | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function load(): Promise<Settings> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings>;
    cache = {
      trustedFolders: Array.isArray(parsed.trustedFolders)
        ? parsed.trustedFolders.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    cache = { ...DEFAULTS };
  }
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
