import { useEffect, useState } from 'react';
import type { DiscoveryProgress, DiscoveryResult } from '../../../shared/ipc';
import { useModelEndpoints } from '../hooks/useModelEndpoints';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50';

export function ModelsView() {
  const { endpoints, loading, refresh } = useModelEndpoints();
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [scan, setScan] = useState<DiscoveryResult | null>(null);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => window.powerchord.onDiscoveryProgress(setProgress), []);

  const add = async (baseUrl: string, name?: string) => {
    setAdding(true);
    setMessage(null);
    try {
      await window.powerchord.addModelEndpoint(baseUrl, name);
      setAddress('');
      await refresh();
      setScan(
        (current) =>
          current && {
            ...current,
            servers: current.servers.map((server) =>
              server.baseUrl === baseUrl ? { ...server, alreadyAdded: true } : server,
            ),
          },
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setMessage(null);
    setProgress(null);
    try {
      setScan(await window.powerchord.discoverModelServers());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
      <div className="mx-auto max-w-3xl">
        <div className="pt-4 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="mt-1 text-sm text-muted">
            Local and self-hosted servers with an OpenAI-compatible API, such as Ollama, LM Studio,
            llama.cpp or vLLM. The server must accept connections from this computer.
          </p>
        </div>

        <h2 className="mb-2 text-sm font-semibold">Saved servers</h2>
        <div className="flex flex-col gap-3">
          {endpoints?.length === 0 && <p className="text-sm text-muted">No servers yet.</p>}
          {endpoints?.map((endpoint) => (
            <article key={endpoint.id} className="rounded-2xl border border-border bg-elevated p-4">
              <header className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${endpoint.online ? 'bg-emerald-500' : 'bg-red-500'}`}
                />
                <h3 className="font-medium">{endpoint.name}</h3>
                <span className="truncate font-mono text-xs text-muted">{endpoint.baseUrl}</span>
                <button
                  type="button"
                  onClick={() =>
                    void window.powerchord.removeModelEndpoint(endpoint.id).then(refresh)
                  }
                  className="ml-auto text-xs text-muted hover:text-text"
                >
                  Remove
                </button>
              </header>
              <p className="mt-2 text-sm text-muted">
                {endpoint.online
                  ? `${endpoint.models.length} model${endpoint.models.length === 1 ? '' : 's'}: ${endpoint.models.join(', ')}`
                  : `Offline: ${endpoint.error ?? 'not reachable'}`}
              </p>
            </article>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className={`${BUTTON} mt-3`}
        >
          {loading ? 'Checking…' : 'Check again'}
        </button>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Add a server</h2>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) void add(address);
          }}
        >
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="10.0.0.5:11434 or http://host:1234/v1"
            className="min-w-0 flex-1 rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm select-text"
          />
          <button type="submit" disabled={adding || !address.trim()} className={BUTTON}>
            Add
          </button>
        </form>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Find servers on your networks</h2>
        <p className="text-sm text-muted">
          Checks the usual ports of local inference servers on this computer&apos;s private
          networks, including VPNs. Small networks are scanned completely; large ones only at their
          most likely addresses. Run it only on networks you are allowed to scan.
        </p>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={scanning}
          className={`${BUTTON} mt-3`}
        >
          {scanning
            ? progress
              ? `Scanning… ${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`
              : 'Scanning…'
            : 'Scan networks'}
        </button>

        {scan && (
          <div className="mt-4 text-sm">
            <p className="text-muted">
              Checked {scan.hostsScanned} addresses on{' '}
              {scan.networks.length === 0
                ? 'this computer only'
                : scan.networks
                    .map(
                      (network) =>
                        `${network.cidr} (${network.interfaceName}, ${network.mode === 'full' ? 'all' : 'likely'})`,
                    )
                    .join(', ')}
              .
            </p>
            {scan.servers.length === 0 ? (
              <p className="mt-2">No servers found.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {scan.servers.map((server) => (
                  <li
                    key={server.baseUrl}
                    className="flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{server.name}</p>
                      <p className="truncate text-xs text-muted">
                        {server.baseUrl} · {server.models.join(', ') || 'no models'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={server.alreadyAdded || adding}
                      onClick={() => void add(server.baseUrl, server.name)}
                      className={`${BUTTON} ml-auto shrink-0`}
                    >
                      {server.alreadyAdded ? 'Added' : 'Add'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {message && <p className="mt-4 text-sm text-red-500">{message}</p>}
      </div>
    </section>
  );
}
