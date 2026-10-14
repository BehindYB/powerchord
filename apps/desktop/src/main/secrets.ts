import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/*
 * API keys the user enters in PowerChord, encrypted with the operating system's secure storage
 * (DPAPI on Windows, Keychain on macOS, the Secret Service on Linux). Keys never reach the
 * renderer; only whether a key is set and its last characters do.
 */

export type SecretId = `api:${string}` | `endpoint:${string}`;

let cache: Record<string, string> | null = null;

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

function assertSecureStorage(): void {
  const available =
    safeStorage.isEncryptionAvailable() &&
    // On Linux without a keyring, Electron falls back to a fixed key that protects nothing.
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  if (!available) {
    throw new Error(
      'Secure storage is not available on this system, so PowerChord cannot store API keys.',
    );
  }
}

async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(await readFile(secretsPath(), 'utf8'));
    cache =
      typeof parsed === 'object' && parsed !== null
        ? Object.fromEntries(
            Object.entries(parsed).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function save(secrets: Record<string, string>): Promise<void> {
  cache = secrets;
  const path = secretsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(secrets, null, 2), 'utf8');
  await rename(temporary, path);
}

export async function getSecret(id: SecretId): Promise<string | null> {
  const encrypted = (await load())[id];
  if (!encrypted) return null;
  assertSecureStorage();
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    // Encrypted by another user account or machine; the user has to enter the key again.
    return null;
  }
}

export async function setSecret(id: SecretId, value: string): Promise<void> {
  assertSecureStorage();
  const encrypted = safeStorage.encryptString(value).toString('base64');
  await save({ ...(await load()), [id]: encrypted });
}

export async function deleteSecret(id: SecretId): Promise<void> {
  const secrets = { ...(await load()) };
  delete secrets[id];
  await save(secrets);
}

/** Last characters of a stored key, so the user can tell keys apart. */
export async function secretHint(id: SecretId): Promise<string | null> {
  const value = await getSecret(id);
  return value ? `…${value.slice(-4)}` : null;
}
