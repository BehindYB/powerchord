import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  instructionsPrompt,
  linkInstructionFile,
  readInstructionFiles,
  writeSharedInstructions,
} from './instructions.ts';
import { memoryPrompt, ProjectMemoryStore } from './project-memory.ts';

const PROJECT = '6f1c1c2e-8d0b-4a57-9a43-0f2b7c1d9e10';
let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'powerchord-memory-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('project instructions', () => {
  it('read the instruction files and include shared content once', async () => {
    await writeSharedInstructions(folder, 'Run npm test before committing.\n');
    await writeFile(join(folder, 'CLAUDE.md'), '@AGENTS.md\n\nUse British spelling.\n');
    const files = await readInstructionFiles(folder);
    expect(files.map((file) => [file.name, file.exists, file.importsShared])).toEqual([
      ['AGENTS.md', true, false],
      ['CLAUDE.md', true, true],
      ['GEMINI.md', false, false],
    ]);
    const prompt = instructionsPrompt(files);
    expect(prompt).toContain('<AGENTS.md>\nRun npm test before committing.\n</AGENTS.md>');
    expect(prompt).toContain('<CLAUDE.md>\nUse British spelling.\n</CLAUDE.md>');
    expect(prompt).not.toContain('@AGENTS.md');
    expect(prompt).not.toContain('GEMINI.md');
  });

  it('give no prompt for a folder without instructions', async () => {
    expect(instructionsPrompt(await readInstructionFiles(folder))).toBe('');
  });

  it('link agent files to AGENTS.md without losing their content', async () => {
    await writeFile(join(folder, 'CLAUDE.md'), '# Notes\nKeep it short.');
    await linkInstructionFile(folder, 'CLAUDE.md');
    await linkInstructionFile(folder, 'CLAUDE.md');
    await linkInstructionFile(folder, 'GEMINI.md');
    expect(await readFile(join(folder, 'CLAUDE.md'), 'utf8')).toBe(
      '# Notes\nKeep it short.\n\n@AGENTS.md\n',
    );
    expect(await readFile(join(folder, 'GEMINI.md'), 'utf8')).toBe('@AGENTS.md\n');
  });
});

describe('ProjectMemoryStore', () => {
  it('stores, appends dated notes and removes memory', async () => {
    const store = new ProjectMemoryStore(join(folder, 'memory'));
    expect(await store.read(PROJECT)).toBe('');
    await store.write(PROJECT, '- Uses pnpm');
    await store.append(PROJECT, '  Deploys  on Fridays ', 'Claude Code', new Date('2026-11-23'));
    expect(await store.read(PROJECT)).toBe(
      '- Uses pnpm\n- Deploys on Fridays (Claude Code, 2026-11-23)\n',
    );
    await expect(store.append(PROJECT, '   ', 'x')).rejects.toThrow(/empty/);
    await expect(store.read('../escape')).resolves.toBe('');
    await expect(store.write('../escape', 'x')).rejects.toThrow(/Invalid project/);
    await store.remove(PROJECT);
    expect(await store.read(PROJECT)).toBe('');
  });

  it('frames memory for prompts', () => {
    expect(memoryPrompt('  ')).toBe('');
    expect(memoryPrompt('- Uses pnpm')).toContain('<memory>\n- Uses pnpm\n</memory>');
  });
});
