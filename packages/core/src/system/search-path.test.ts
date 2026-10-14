import { describe, expect, it } from 'vitest';
import {
  expandWindowsVariables,
  getEnv,
  mergeDirectories,
  parseRegistryPath,
} from './search-path.ts';

describe('parseRegistryPath', () => {
  it('reads REG_EXPAND_SZ values', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\agy\\bin;C:\\Tools',
      '',
    ].join('\r\n');
    expect(parseRegistryPath(output)).toBe('%LOCALAPPDATA%\\agy\\bin;C:\\Tools');
  });

  it('returns null when the value is missing', () => {
    expect(
      parseRegistryPath('ERROR: The system was unable to find the specified registry key'),
    ).toBeNull();
  });
});

describe('Windows environment helpers', () => {
  const env = { LocalAppData: 'C:\\Users\\me\\AppData\\Local' };

  it('looks up variables case-insensitively', () => {
    expect(getEnv(env, 'LOCALAPPDATA', 'win32')).toBe('C:\\Users\\me\\AppData\\Local');
  });

  it('expands known variables and keeps unknown ones', () => {
    expect(expandWindowsVariables('%LOCALAPPDATA%\\agy;%MISSING%\\x', env)).toBe(
      'C:\\Users\\me\\AppData\\Local\\agy;%MISSING%\\x',
    );
  });
});

describe('mergeDirectories', () => {
  it('drops duplicates case-insensitively on Windows', () => {
    expect(mergeDirectories([['C:\\A', 'c:\\a\\'], ['C:\\B']], 'win32')).toEqual([
      'C:\\A',
      'C:\\B',
    ]);
  });

  it('keeps case-distinct directories on Linux', () => {
    expect(mergeDirectories([['/a', '/A'], ['/a/']], 'linux')).toEqual(['/a', '/A']);
  });
});
