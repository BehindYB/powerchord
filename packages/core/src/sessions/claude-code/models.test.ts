import { describe, expect, it } from 'vitest';
import { parseClaudeCodeModels } from './models.ts';

/** Shaped like the `models` field of Claude Code's initialize response. */
const REPORTED = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'Best for everyday, complex tasks',
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  { value: 'claude-opus-4-8', displayName: 'Duplicate' },
  { value: 42 },
];

describe('parseClaudeCodeModels', () => {
  it('lists aliases and versions, and names the default model', () => {
    expect(parseClaudeCodeModels(REPORTED)).toEqual({
      defaultLabel: 'Opus 5.5',
      models: [
        { id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
        { id: 'haiku', label: 'Haiku 5.5' },
        { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      ],
    });
  });

  it('rejects a response without models', () => {
    expect(() => parseClaudeCodeModels(undefined)).toThrow(/did not report/);
  });
});
