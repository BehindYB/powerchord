import { useEffect, useState } from 'react';
import { API_PROVIDERS, type ApiKeyInfo, type ApiProviderId } from '../../../shared/ipc';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50';

function errorText(cause: unknown): string {
  // Strip Electron's "Error invoking remote method" prefix.
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function ProviderRow({
  provider,
  info,
  onChanged,
}: {
  provider: (typeof API_PROVIDERS)[number];
  info: ApiKeyInfo | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await window.powerchord.setApiKey(provider.id, key);
      setKey('');
      setEditing(false);
      onChanged();
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{provider.name}</p>
          <p className="text-xs text-muted">Used for {provider.usedFor}.</p>
        </div>
        {info?.configured && <span className="font-mono text-xs text-muted">{info.hint}</span>}
        {!editing && (
          <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
            {info?.configured ? 'Replace' : 'Add key'}
          </button>
        )}
        {info?.configured && !editing && (
          <button
            type="button"
            className="text-xs text-muted hover:text-text"
            onClick={() =>
              void window.powerchord
                .deleteApiKey(provider.id)
                .then(onChanged, (cause: unknown) => setMessage(errorText(cause)))
            }
          >
            Remove
          </button>
        )}
      </div>
      {editing && (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Paste your API key"
            aria-label={`${provider.name} key`}
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm select-text"
          />
          <button type="submit" className={BUTTON} disabled={busy || key.trim().length === 0}>
            {busy ? 'Checking…' : 'Save'}
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              setEditing(false);
              setKey('');
              setMessage(null);
            }}
          >
            Cancel
          </button>
          <a
            href={provider.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="self-center text-xs text-accent hover:underline"
          >
            Get a key
          </a>
        </form>
      )}
      {message && <p className="mt-2 text-sm text-red-500">{message}</p>}
    </div>
  );
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const refresh = () => void window.powerchord.listApiKeys().then(setKeys);

  useEffect(() => {
    let cancelled = false;
    void window.powerchord.listApiKeys().then((value) => {
      if (!cancelled) setKeys(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const byProvider = (id: ApiProviderId) => keys?.find((entry) => entry.provider === id);

  return (
    <>
      <h2 className="mt-8 mb-2 text-sm font-semibold">API keys</h2>
      <p className="mb-2 text-sm text-muted">
        Keys for pay-as-you-go APIs, billed by each provider to your account. PowerChord checks a
        key with the provider before saving it, stores it encrypted by your operating system and
        sends it only to that provider or to the agent that uses it.
      </p>
      <div className="rounded-2xl border border-border bg-elevated text-sm">
        {API_PROVIDERS.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            info={byProvider(provider.id)}
            onChanged={refresh}
          />
        ))}
      </div>
    </>
  );
}
