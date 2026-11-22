import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  htmlToText,
  needsApproval,
  resolveInWorkspace,
  truncateOutput,
  WORKSPACE_TOOLS,
  type ToolContext,
} from './tools.ts';

let folder = '';
let context: ToolContext;

function run(name: string, input: Record<string, unknown>): Promise<string> {
  const tool = WORKSPACE_TOOLS.find((entry) => entry.definition.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool.run(input, context);
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'powerchord-tools-'));
  context = { cwd: folder, env: process.env, signal: new AbortController().signal };
  await mkdir(join(folder, 'src'));
  await mkdir(join(folder, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(folder, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = a + b;\n');
  await writeFile(join(folder, 'node_modules', 'dep', 'index.js'), 'const a = 1;\n');
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('workspace tools', () => {
  it('refuse paths outside the project folder', async () => {
    await expect(resolveInWorkspace(folder, '../elsewhere.txt')).rejects.toThrow(/outside/);
    await expect(resolveInWorkspace(folder, tmpdir())).rejects.toThrow(/outside/);
    await expect(run('read_file', { path: '../../secret' })).rejects.toThrow(/outside/);
    expect(await resolveInWorkspace(folder, 'src/new/file.ts')).toBe(
      join(folder, 'src', 'new', 'file.ts'),
    );
  });

  it('list files, skipping dependency folders when recursive', async () => {
    expect(await run('list_files', {})).toBe('node_modules/\nsrc/');
    expect(await run('list_files', { recursive: true })).toBe('node_modules/\nsrc/\nsrc/app.ts');
  });

  it('read files with line numbers and offsets', async () => {
    expect(await run('read_file', { path: 'src/app.ts', offset: 2, limit: 1 })).toBe(
      '2  const b = 2;\n\n(lines 2-2 of 3; use offset to read more)',
    );
  });

  it('search files with regular expressions', async () => {
    expect(await run('search_files', { pattern: 'const [ab] =' })).toBe(
      'src/app.ts:1: const a = 1;\nsrc/app.ts:2: const b = 2;',
    );
    await expect(run('search_files', { pattern: '(' })).rejects.toThrow(/not a valid/);
  });

  it('write and edit files', async () => {
    expect(await run('write_file', { path: 'docs/notes.md', content: 'one\ntwo\n' })).toBe(
      'Created docs/notes.md (3 lines).',
    );
    await run('edit_file', {
      path: 'src/app.ts',
      old_text: 'const b = 2;',
      new_text: 'let b = 3;',
    });
    expect(await readFile(join(folder, 'src', 'app.ts'), 'utf8')).toContain('let b = 3;');

    await expect(
      run('edit_file', { path: 'src/app.ts', old_text: 'const', new_text: 'let' }),
    ).rejects.toThrow(/appears 2 times/);
    await expect(
      run('edit_file', { path: 'src/app.ts', old_text: 'missing', new_text: 'x' }),
    ).rejects.toThrow(/not found/);
    await run('edit_file', {
      path: 'src/app.ts',
      old_text: 'const',
      new_text: 'let',
      replace_all: true,
    });
    expect(await readFile(join(folder, 'src', 'app.ts'), 'utf8')).not.toContain('const');
  });

  it('edit files saved with Windows line endings', async () => {
    await writeFile(join(folder, 'win.txt'), 'first\r\nsecond\r\nthird\r\n');
    await run('edit_file', { path: 'win.txt', old_text: 'first\nsecond', new_text: 'one\ntwo' });
    expect(await readFile(join(folder, 'win.txt'), 'utf8')).toBe('one\r\ntwo\r\nthird\r\n');
  });

  it('run commands in the project folder', async () => {
    const output = await run('run_command', { command: 'echo hello' });
    expect(output).toMatch(/^hello/);
    expect(output).toMatch(/Exit code 0\.$/);
  }, 20_000);

  it('reduce web pages to text', () => {
    expect(
      htmlToText(
        '<html><head><style>p{}</style><script>x()</script></head><body><h1>Title</h1>' +
          '<p>One &amp; two&#33;</p><ul><li>a</li><li>b</li></ul></body></html>',
      ),
    ).toBe('Title\nOne & two!\n\n- a\n- b');
  });

  it('shorten long output keeping both ends', () => {
    const text = `${'a'.repeat(50)}${'b'.repeat(50)}`;
    const short = truncateOutput(text, 20);
    expect(short.startsWith('a'.repeat(14))).toBe(true);
    expect(short.endsWith('b'.repeat(6))).toBe(true);
    expect(short).toContain('80 characters omitted');
  });
});

describe('needsApproval', () => {
  it('follows the session mode', () => {
    expect(needsApproval('read', 'ask')).toBe(false);
    expect(needsApproval('edit', 'ask')).toBe(true);
    expect(needsApproval('edit', 'auto-edit')).toBe(false);
    expect(needsApproval('command', 'auto-edit')).toBe(true);
    expect(needsApproval('network', 'auto-edit')).toBe(true);
    expect(needsApproval('command', 'full-access')).toBe(false);
    expect(needsApproval('network', 'full-access')).toBe(false);
  });
});
