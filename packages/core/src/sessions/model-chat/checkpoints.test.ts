import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from './checkpoints.ts';

let folder = '';
let store: FileCheckpointStore;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'powerchord-checkpoints-'));
  store = new FileCheckpointStore(join(folder, 'checkpoints'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('FileCheckpointStore', () => {
  it('restores files as they were before the first rewound turn', async () => {
    const a = join(folder, 'a.txt');
    const b = join(folder, 'sub', 'b.txt');
    await writeFile(a, 'one');

    // Turn 1 changes a.txt; turn 2 changes it again and creates b.txt.
    await store.record('turn-1', a);
    await writeFile(a, 'two');
    await store.record('turn-2', a);
    await store.record('turn-2', b);
    await store.record('turn-2', a);
    await writeFile(a, 'three');
    await store.record('turn-2', b);

    expect(await store.changedFiles(['turn-2'])).toEqual([a, b]);
    expect(await store.restore(['turn-2'])).toEqual([a, b]);
    expect(await readFile(a, 'utf8')).toBe('two');
    await expect(readFile(b, 'utf8')).rejects.toThrow();

    await writeFile(a, 'four');
    await store.restore(['turn-1', 'turn-2']);
    expect(await readFile(a, 'utf8')).toBe('one');

    await store.discard(['turn-1', 'turn-2']);
    expect(await store.changedFiles(['turn-1', 'turn-2'])).toEqual([]);
  });

  it('rejects turn ids that could leave its folder', async () => {
    await expect(store.record('../x', join(folder, 'a.txt'))).rejects.toThrow('Invalid turn id');
  });
});
