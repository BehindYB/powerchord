import { useState } from 'react';
import type { AgentInfo, InstallOutcome } from '../../../shared/ipc';

interface AgentCardProps {
  agent: AgentInfo;
  output: string;
  onInstall: (methodId: string) => Promise<InstallOutcome>;
  onSignIn: () => Promise<void>;
}

function Badge({ tone, children }: { tone: 'positive' | 'neutral'; children: string }) {
  const toneClass = tone === 'positive' ? 'bg-accent/15 text-accent' : 'bg-hover text-muted';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}`}>{children}</span>
  );
}

function authLabel(agent: AgentInfo): { tone: 'positive' | 'neutral'; text: string } | null {
  if (!agent.installed || agent.auth === null) return null;
  switch (agent.auth.state) {
    case 'signed-in':
      return {
        tone: 'positive',
        text: agent.auth.detail ? `Signed in · ${agent.auth.detail}` : 'Signed in',
      };
    case 'signed-out':
      return { tone: 'neutral', text: 'Signed out' };
    default:
      return { tone: 'neutral', text: 'Sign-in status unknown' };
  }
}

export function AgentCard({ agent, output, onInstall, onSignIn }: AgentCardProps) {
  const usableMethods = agent.installMethods.filter(
    (method) => method.missingRequirements.length === 0,
  );
  const [methodId, setMethodId] = useState(usableMethods[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = agent.installMethods.find((method) => method.id === methodId);
  const auth = authLabel(agent);

  const install = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await onInstall(methodId);
    setBusy(false);
    if (outcome.status === 'failed') setMessage(outcome.message);
    if (outcome.status === 'cancelled') setMessage('Installation cancelled.');
  };

  const signIn = async () => {
    setMessage(null);
    try {
      await onSignIn();
      setMessage('A terminal window opened with the sign-in flow. Refresh when you are done.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <article className="rounded-2xl border border-border bg-elevated p-5">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{agent.displayName}</h2>
        <span className="text-sm text-muted">{agent.vendor}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {agent.installed ? (
            <Badge tone="positive">
              {agent.version ? `Installed · ${agent.version}` : 'Installed'}
            </Badge>
          ) : (
            <Badge tone="neutral">Not installed</Badge>
          )}
          {auth && <Badge tone={auth.tone}>{auth.text}</Badge>}
        </div>
      </header>

      {agent.integration === 'launch-only' && (
        <p className="mt-3 text-sm text-muted">
          Used through its own interface. PowerChord can install and open it, but does not control
          it, as required by the vendor&apos;s terms.
        </p>
      )}

      {agent.installed && agent.path && (
        <p className="mt-3 truncate font-mono text-xs text-muted" title={agent.path}>
          {agent.path}
        </p>
      )}

      {!agent.installed && (
        <div className="mt-4">
          {agent.installMethods.length > 1 && (
            <label className="mb-2 flex items-center gap-2 text-sm">
              <span className="text-muted">Method</span>
              <select
                value={methodId}
                onChange={(event) => setMethodId(event.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1 text-sm"
              >
                {agent.installMethods.map((method) => (
                  <option
                    key={method.id}
                    value={method.id}
                    disabled={method.missingRequirements.length > 0}
                  >
                    {method.label}
                    {method.missingRequirements.length > 0
                      ? ` (requires ${method.missingRequirements.join(', ')})`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected && (
            <pre className="overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs select-text">
              {selected.display}
            </pre>
          )}
        </div>
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-2">
        {!agent.installed && (
          <button
            type="button"
            onClick={() => void install()}
            disabled={busy || !selected || selected.missingRequirements.length > 0}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
        {agent.installed && (
          <button
            type="button"
            onClick={() => void signIn()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover"
          >
            {agent.integration === 'launch-only' ? 'Open' : 'Sign in'}
          </button>
        )}
        <a
          href={agent.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="px-2 py-1.5 text-sm text-muted hover:text-text"
        >
          Documentation ↗
        </a>
      </footer>

      {message && <p className="mt-3 text-sm text-muted">{message}</p>}

      {output && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">
          {output}
        </pre>
      )}
    </article>
  );
}
