import { useEffect, useState } from 'react';
import type { InstallOutcome } from '../../../shared/ipc';
import { useAgents } from '../hooks/useAgents';
import { AgentCard } from './AgentCard';

export function AgentsView() {
  const { agents, loading, error, refresh } = useAgents();
  const [output, setOutput] = useState<Record<string, string>>({});

  useEffect(
    () =>
      window.powerchord.onInstallOutput(({ agentId, chunk }) =>
        setOutput((current) => ({ ...current, [agentId]: (current[agentId] ?? '') + chunk })),
      ),
    [],
  );

  const install = async (agentId: string, methodId: string): Promise<InstallOutcome> => {
    setOutput((current) => ({ ...current, [agentId]: '' }));
    const outcome = await window.powerchord.installAgent(agentId, methodId);
    if (outcome.status === 'installed') await refresh();
    return outcome;
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end justify-between pt-4 pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            <p className="mt-1 text-sm text-muted">
              Agents are installed from their vendors&apos; official channels and sign in through
              their own login flows.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50"
          >
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-border bg-elevated p-3 text-sm">
            Could not check agents: {error}
          </p>
        )}

        <div className="flex flex-col gap-4">
          {agents?.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              output={output[agent.id] ?? ''}
              onInstall={(methodId) => install(agent.id, methodId)}
              onSignIn={() => window.powerchord.openAgentSignIn(agent.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
