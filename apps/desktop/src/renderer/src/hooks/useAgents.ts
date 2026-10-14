import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo } from '../../../shared/ipc';

export interface AgentsState {
  agents: AgentInfo[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

type Result = { agents: AgentInfo[] } | { error: string };

async function fetchAgents(): Promise<Result> {
  try {
    return { agents: await window.powerchord.listAgents() };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function useAgents(): AgentsState {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((result: Result) => {
    if ('agents' in result) {
      setAgents(result.agents);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    apply(await fetchAgents());
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  return { agents, loading, error, refresh };
}
