import { useEffect, useState } from 'react';
import type { Preferences, ThemePreference } from '../../../shared/ipc';
import { useAppInfo } from '../hooks/useAppInfo';
import { ApiKeysSection } from './ApiKeysSection';
import { BudgetsSection } from './BudgetsSection';
import { Picker } from './Composer';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50';

const THEMES: readonly { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const SHORTCUTS: readonly [string, string][] = [
  ['Ctrl+N', 'New session'],
  ['Ctrl+K', 'Search sessions'],
  ['Ctrl+,', 'Settings'],
  ['Ctrl+click a session', 'Open it side by side'],
  ['Enter / Shift+Enter', 'Send message / new line'],
];

export function SettingsView() {
  const appInfo = useAppInfo();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => window.powerchord.getPreferences().then(setPreferences);
  useEffect(() => {
    let cancelled = false;
    void window.powerchord.getPreferences().then((value) => {
      if (!cancelled) setPreferences(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = (action: Promise<unknown>, done?: string) =>
    void action.then(
      () => {
        setMessage(done ?? null);
        return refresh();
      },
      (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)),
    );

  if (!preferences) {
    return <section className="flex-1 px-8 pt-4 text-sm text-muted">Loading…</section>;
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
      <div className="mx-auto max-w-3xl">
        <div className="pt-4 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>

        <h2 className="mb-2 text-sm font-semibold">Appearance</h2>
        <Picker<ThemePreference>
          label="Theme"
          value={preferences.theme}
          options={THEMES}
          onChange={(theme) => run(window.powerchord.setTheme(theme))}
        />

        <ApiKeysSection />
        <BudgetsSection />

        <h2 className="mt-8 mb-2 text-sm font-semibold">Trusted folders</h2>
        <p className="mb-2 text-sm text-muted">
          Agents start in these folders without asking again and load their configuration, such as
          hooks and MCP servers.
        </p>
        <div className="rounded-2xl border border-border bg-elevated text-sm">
          {preferences.trustedFolders.length === 0 && (
            <p className="px-4 py-3 text-muted">No trusted folders.</p>
          )}
          {preferences.trustedFolders.map((folder) => (
            <div
              key={folder}
              className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>
                {folder}
              </span>
              <button
                type="button"
                className="text-xs text-muted hover:text-text"
                onClick={() => run(window.powerchord.removeTrustedFolder(folder))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Hub access</h2>
        <p className="mb-2 text-sm text-muted">
          Agents you added the hub to authenticate with a token stored in their configuration.
          Replace it if it may have been exposed.
        </p>
        <button
          type="button"
          className={BUTTON}
          onClick={() =>
            void window.powerchord.regenerateHubToken().then(
              (replaced) =>
                setMessage(
                  replaced
                    ? 'Token replaced. Add the hub to your agents again from the Hub.'
                    : null,
                ),
              (cause: unknown) =>
                setMessage(cause instanceof Error ? cause.message : String(cause)),
            )
          }
        >
          Replace hub token
        </button>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Data</h2>
        <p className="mb-2 text-sm text-muted">
          Settings, session history and hub content are stored on this computer in{' '}
          <span className="font-mono text-xs select-text">{preferences.dataFolder}</span>.
        </p>
        <button
          type="button"
          className={BUTTON}
          onClick={() => run(window.powerchord.openDataFolder())}
        >
          Open data folder
        </button>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="contents">
              <dt className="font-mono text-xs leading-5 text-muted">{keys}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-8 mb-2 text-sm font-semibold">About</h2>
        <p className="text-sm text-muted">
          PowerChord {appInfo ? `v${appInfo.version}` : ''}, MIT license.{' '}
          <a
            href="https://github.com/BehindYB/powerchord"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Source code
          </a>
          . Not affiliated with Anthropic, OpenAI or Google.
        </p>

        {message && <p className="mt-6 text-sm">{message}</p>}
      </div>
    </section>
  );
}
