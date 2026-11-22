import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Project instruction files that coding agents read from a project folder: AGENTS.md, the
 * cross-agent convention (https://agents.md) that Codex reads, CLAUDE.md for Claude Code and
 * GEMINI.md for Gemini CLI. PowerChord reads them for model chats, which have no such file of
 * their own, and writes them only when the user asks.
 */

export const SHARED_INSTRUCTIONS_FILE = 'AGENTS.md';

/** Agent-specific files that can import the shared file, and the agents that read them. */
export const LINKABLE_INSTRUCTION_FILES = {
  'CLAUDE.md': 'Claude Code',
  'GEMINI.md': 'Gemini CLI',
} as const;

export type LinkableInstructionFile = keyof typeof LINKABLE_INSTRUCTION_FILES;

export const INSTRUCTION_FILES = [
  SHARED_INSTRUCTIONS_FILE,
  ...(Object.keys(LINKABLE_INSTRUCTION_FILES) as LinkableInstructionFile[]),
] as const;

/** Longest text taken from one file, so a large file cannot crowd out the conversation. */
const MAX_FILE_CHARS = 20_000;

export interface InstructionFile {
  name: (typeof INSTRUCTION_FILES)[number];
  exists: boolean;
  text: string;
  /** Whether the file imports AGENTS.md with an `@AGENTS.md` line. */
  importsShared: boolean;
}

export function isLinkableInstructionFile(value: unknown): value is LinkableInstructionFile {
  return typeof value === 'string' && value in LINKABLE_INSTRUCTION_FILES;
}

const IMPORT_LINE = /^\s*@(\.\/)?AGENTS\.md\s*$/im;

export function importsSharedInstructions(text: string): boolean {
  return IMPORT_LINE.test(text);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readInstructionFiles(folder: string): Promise<InstructionFile[]> {
  return Promise.all(
    INSTRUCTION_FILES.map(async (name) => {
      const text = await readOptional(join(folder, name));
      return {
        name,
        exists: text !== null,
        text: text ?? '',
        importsShared: text !== null && importsSharedInstructions(text),
      };
    }),
  );
}

/**
 * The instructions as one text for a model's system prompt. Lines that only import AGENTS.md are
 * dropped, since its content is included once on its own.
 */
export function instructionsPrompt(files: readonly InstructionFile[]): string {
  const sections = files.flatMap((file) => {
    const body = file.text
      .split(/\r?\n/)
      .filter((line) => !IMPORT_LINE.test(line))
      .join('\n')
      .trim();
    if (!body) return [];
    const clipped =
      body.length > MAX_FILE_CHARS ? `${body.slice(0, MAX_FILE_CHARS)}\n… (shortened)` : body;
    return [`<${file.name}>\n${clipped}\n</${file.name}>`];
  });
  return sections.length > 0
    ? `Project instructions from the project folder:\n\n${sections.join('\n\n')}`
    : '';
}

export async function writeSharedInstructions(folder: string, text: string): Promise<void> {
  await writeFile(join(folder, SHARED_INSTRUCTIONS_FILE), text, 'utf8');
}

/**
 * Makes an agent-specific file import AGENTS.md, creating the file when it is missing and
 * keeping its existing content.
 */
export async function linkInstructionFile(
  folder: string,
  name: LinkableInstructionFile,
): Promise<void> {
  const path = join(folder, name);
  const existing = (await readOptional(path)) ?? '';
  if (importsSharedInstructions(existing)) return;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const spacing = existing.trim() === '' ? '' : '\n';
  await writeFile(path, `${existing}${separator}${spacing}@${SHARED_INSTRUCTIONS_FILE}\n`, 'utf8');
}
