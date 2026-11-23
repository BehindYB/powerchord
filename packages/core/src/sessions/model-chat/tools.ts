import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from '../../models/openai-compatible.ts';
import { stopProcessTree } from '../../system/process.ts';
import type { ModelChatMode } from '../types.ts';

/*
 * Tools that let a model chat work in the user's project folder: read, search and change files,
 * run commands and fetch web pages. File tools never reach outside the folder; whether a call
 * needs the user's approval depends on its access level and the session's mode.
 */

/** What a tool can affect, which decides when it needs approval. */
export type ToolAccess = 'read' | 'edit' | 'command' | 'network';

export interface ToolContext {
  /** Project folder; file paths are resolved inside it. */
  cwd: string;
  /** Environment for commands. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Called with a file's absolute path before a tool changes it, to save a checkpoint. */
  beforeChange?: (path: string) => Promise<void>;
}

export interface WorkspaceTool {
  definition: ToolDefinition;
  access: ToolAccess;
  run(input: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/** Longest tool output passed back to the model, so local models with small contexts cope. */
export const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_READ_LINES = 400;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
/** Files larger than this are skipped by searches and refused by reads. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_COMMAND_SECONDS = 120;
const MAX_COMMAND_SECONDS = 600;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
/** Folders that are rarely useful to list or search and can be very large. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'out']);

/** Shortens long output, keeping its beginning and end. */
export function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n… (${text.length - limit} characters omitted) …\n\n${text.slice(-tail)}`;
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`"${key}" is required.`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function isInside(folder: string, target: string): boolean {
  const path = relative(folder, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** The nearest existing ancestor of a path, with symbolic links resolved. */
async function realAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolves a path given by the model inside the project folder. Paths that leave the folder,
 * directly or through a symbolic link, are refused.
 */
export async function resolveInWorkspace(cwd: string, path: string | undefined): Promise<string> {
  const target = resolve(cwd, path ?? '.');
  const root = await realpath(cwd);
  if (!isInside(resolve(cwd), target) || !isInside(root, await realAncestor(target))) {
    throw new Error(
      `${path} is outside the project folder, which is the only place tools can use.`,
    );
  }
  return target;
}

function displayPath(cwd: string, target: string): string {
  return relative(cwd, target).split(sep).join('/') || '.';
}

async function listFiles(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const root = await resolveInWorkspace(context.cwd, optionalString(input, 'path'));
  const recursive = input['recursive'] === true;
  const lines: string[] = [];
  let truncated = false;

  const visit = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const path = join(folder, entry.name);
      const isFolder = entry.isDirectory();
      lines.push(`${displayPath(context.cwd, path)}${isFolder ? '/' : ''}`);
      if (isFolder && recursive && !SKIPPED_FOLDERS.has(entry.name)) await visit(path);
    }
  };
  await visit(root);
  if (lines.length === 0) return 'The folder is empty.';
  if (truncated) lines.push(`… (stopped after ${MAX_LIST_ENTRIES} entries)`);
  return lines.join('\n');
}

async function readTextFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error('The file is too large to read.');
  const buffer = await readFile(path);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error('The file looks binary.');
  return buffer.toString('utf8');
}

async function readFileTool(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const path = await resolveInWorkspace(context.cwd, stringInput(input, 'path'));
  const lines = (await readTextFile(path)).split(/\r?\n/);
  // A final line break does not start another line.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const offset = Math.max(1, Math.floor(optionalNumber(input, 'offset') ?? 1));
  const limit = Math.max(1, Math.floor(optionalNumber(input, 'limit') ?? DEFAULT_READ_LINES));
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  if (selected.length === 0) return `The file has ${lines.length} lines.`;
  const width = String(offset + selected.length - 1).length;
  const numbered = selected
    .map((line, index) => `${String(offset + index).padStart(width)}  ${line}`)
    .join('\n');
  const end = offset + selected.length - 1;
  const note =
    end < lines.length
      ? `\n\n(lines ${offset}-${end} of ${lines.length}; use offset to read more)`
      : '';
  return truncateOutput(numbered) + note;
}

async function searchFiles(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const pattern = stringInput(input, 'pattern');
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, input['ignore_case'] === true ? 'i' : '');
  } catch {
    throw new Error(`"${pattern}" is not a valid regular expression.`);
  }
  const root = await resolveInWorkspace(context.cwd, optionalString(input, 'path'));
  const matches: string[] = [];

  const visit = async (path: string): Promise<void> => {
    if (matches.length >= MAX_SEARCH_MATCHES || context.signal.aborted) return;
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory() && SKIPPED_FOLDERS.has(entry.name)) continue;
        await visit(join(path, entry.name));
      }
      return;
    }
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) return;
    const text = await readTextFile(path).catch(() => null);
    if (text === null) return;
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!expression.test(line)) continue;
      matches.push(`${displayPath(context.cwd, path)}:${index + 1}: ${line.trim().slice(0, 300)}`);
      if (matches.length >= MAX_SEARCH_MATCHES) return;
    }
  };
  await visit(root);
  if (matches.length === 0) return 'No matches.';
  const note = matches.length >= MAX_SEARCH_MATCHES ? `\n… (stopped at ${MAX_SEARCH_MATCHES})` : '';
  return truncateOutput(matches.join('\n')) + note;
}

async function writeFileTool(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const path = await resolveInWorkspace(context.cwd, stringInput(input, 'path'));
  const content = typeof input['content'] === 'string' ? input['content'] : '';
  const existed = await stat(path).then(
    () => true,
    () => false,
  );
  await context.beforeChange?.(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return `${existed ? 'Replaced' : 'Created'} ${displayPath(context.cwd, path)} (${content.split('\n').length} lines).`;
}

async function editFile(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const path = await resolveInWorkspace(context.cwd, stringInput(input, 'path'));
  const oldText = stringInput(input, 'old_text');
  const newText = typeof input['new_text'] === 'string' ? input['new_text'] : '';
  const original = await readTextFile(path);
  // Models usually write "\n"; match files saved with Windows line endings too.
  const crlf = !original.includes(oldText) && original.includes('\r\n');
  const search = crlf ? oldText.replace(/\r?\n/g, '\r\n') : oldText;
  const replacement = crlf ? newText.replace(/\r?\n/g, '\r\n') : newText;
  const count = original.split(search).length - 1;
  if (count === 0) {
    throw new Error('old_text was not found. Read the file again and copy the text exactly.');
  }
  const replaceAll = input['replace_all'] === true;
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_text appears ${count} times. Include more surrounding lines, or set replace_all.`,
    );
  }
  const updated = replaceAll
    ? original.split(search).join(replacement)
    : original.replace(search, () => replacement);
  await context.beforeChange?.(path);
  await writeFile(path, updated, 'utf8');
  return `Edited ${displayPath(context.cwd, path)} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''}).`;
}

/** The shell commands run in: PowerShell on Windows, the user's shell elsewhere. */
export function commandShell(): {
  name: string;
  file: string;
  args: (command: string) => string[];
} {
  if (process.platform === 'win32') {
    return {
      name: 'PowerShell',
      file: 'powershell.exe',
      // UTF-8 output keeps non-ASCII text readable for the model.
      args: (command) => [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
      ],
    };
  }
  const file = process.env['SHELL'] || '/bin/sh';
  return { name: file, file, args: (command) => ['-c', command] };
}

function runCommand(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const command = stringInput(input, 'command');
  const seconds = Math.min(
    MAX_COMMAND_SECONDS,
    Math.max(1, optionalNumber(input, 'timeout_seconds') ?? DEFAULT_COMMAND_SECONDS),
  );
  const shell = commandShell();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd: context.cwd,
      env: context.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Commands that wait for input get end-of-file instead of hanging.
    child.stdin.end();
    let output = '';
    let ended: 'timeout' | 'stopped' | null = null;
    const append = (chunk: Buffer) => {
      // Bounded so a noisy command cannot exhaust memory; truncation keeps head and tail.
      output = truncateOutput(output + chunk.toString('utf8'), MAX_OUTPUT_CHARS * 4);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = (reason: 'timeout' | 'stopped') => {
      ended ??= reason;
      stopProcessTree(child);
    };
    const timer = setTimeout(() => stop('timeout'), seconds * 1000);
    const onAbort = () => stop('stopped');
    context.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      const status =
        ended === 'timeout'
          ? `Stopped after ${seconds} seconds.`
          : ended === 'stopped'
            ? 'Stopped by the user.'
            : `Exit code ${code ?? 'unknown'}.`;
      const text = truncateOutput(output.trim());
      if (ended === 'stopped') reject(new Error(status));
      else resolvePromise(text ? `${text}\n\n${status}` : `(no output)\n\n${status}`);
    });
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Reduces an HTML page to readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchUrl(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const address = stringInput(input, 'url');
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(`${address} is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be fetched.');
  }
  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'PowerChord', Accept: 'text/html,text/plain,application/json,*/*' },
    redirect: 'follow',
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!/text|json|xml|javascript/i.test(type) && type !== '') {
    await response.body?.cancel();
    return `${response.status} ${response.statusText}: the page is not text (${type}).`;
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_FETCH_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const text = /html/i.test(type) ? htmlToText(body) : body;
  const header = `${response.status} ${response.statusText} ${response.url}`;
  return `${header}\n\n${truncateOutput(text)}`;
}

/** The tools offered to model chats that have a project folder. */
export const WORKSPACE_TOOLS: readonly WorkspaceTool[] = [
  {
    access: 'read',
    definition: {
      name: 'list_files',
      description:
        'List the files and folders in a folder of the project. Folders end with "/". ' +
        'With recursive, also lists subfolders (skipping .git, node_modules and build output).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the project root; default "."' },
          recursive: { type: 'boolean', description: 'Include subfolders' },
        },
      },
    },
    run: listFiles,
  },
  {
    access: 'read',
    definition: {
      name: 'read_file',
      description: `Read a text file of the project, with line numbers. Reads ${DEFAULT_READ_LINES} lines unless a limit is given.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          offset: { type: 'number', description: 'First line to read, starting at 1' },
          limit: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
    },
    run: readFileTool,
  },
  {
    access: 'read',
    definition: {
      name: 'search_files',
      description:
        'Search the text files of the project for lines matching a regular expression ' +
        '(JavaScript syntax). Returns path:line: text for each match.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression' },
          path: { type: 'string', description: 'File or folder to search; default the project' },
          ignore_case: { type: 'boolean', description: 'Match regardless of case' },
        },
        required: ['pattern'],
      },
    },
    run: searchFiles,
  },
  {
    access: 'edit',
    definition: {
      name: 'write_file',
      description:
        'Create a file, or replace the whole content of an existing one. Creates missing ' +
        'folders. Prefer edit_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          content: { type: 'string', description: 'The complete new content' },
        },
        required: ['path', 'content'],
      },
    },
    run: writeFileTool,
  },
  {
    access: 'edit',
    definition: {
      name: 'edit_file',
      description:
        'Replace an exact piece of text in a file. old_text must match the file exactly, ' +
        'including indentation, and appear once unless replace_all is set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          old_text: { type: 'string', description: 'Exact text to replace' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    run: editFile,
  },
  {
    access: 'command',
    definition: {
      name: 'run_command',
      description:
        `Run a shell command in the project folder (${commandShell().name}) and return its ` +
        `output and exit code. Commands cannot read input. Default timeout ${DEFAULT_COMMAND_SECONDS} seconds.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run' },
          timeout_seconds: {
            type: 'number',
            description: `Timeout, at most ${MAX_COMMAND_SECONDS} seconds`,
          },
        },
        required: ['command'],
      },
    },
    run: runCommand,
  },
  {
    access: 'network',
    definition: {
      name: 'fetch_url',
      description:
        'Download a web page or file over http(s) and return it as text. HTML pages are ' +
        'reduced to their readable text.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http or https address' } },
        required: ['url'],
      },
    },
    run: fetchUrl,
  },
];

/** Whether a tool call with this access level must be approved by the user first. */
export function needsApproval(access: ToolAccess, mode: ModelChatMode): boolean {
  if (access === 'read' || mode === 'full-access') return false;
  return access === 'edit' ? mode === 'ask' : true;
}
