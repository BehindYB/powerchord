import { useCallback, useEffect, useState } from 'react';
import type { ModelEndpointInfo } from '../../../shared/ipc';

export interface ModelEndpointsState {
  endpoints: ModelEndpointInfo[] | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useModelEndpoints(): ModelEndpointsState {
  const [endpoints, setEndpoints] = useState<ModelEndpointInfo[] | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEndpoints(await window.powerchord.listModelEndpoints());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.powerchord
      .listModelEndpoints()
      .then((result) => {
        if (!cancelled) setEndpoints(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { endpoints, loading, refresh };
}
