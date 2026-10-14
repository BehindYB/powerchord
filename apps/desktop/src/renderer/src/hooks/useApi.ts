import { useEffect, useState } from 'react';
import type { ApiKeyInfo, ApiModelInfo, ApiProviderId, UsageOverview } from '../../../shared/ipc';

/** Which providers have a stored key; null while loading. */
export function useApiKeys(): ApiKeyInfo[] | null {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.powerchord.listApiKeys().then((value) => {
      if (!cancelled) setKeys(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return keys;
}

/** Chat models of a provider, listed with the user's key. */
export function useApiModels(provider: ApiProviderId | null): {
  models: ApiModelInfo[] | null;
  error: string | null;
} {
  const [result, setResult] = useState<{
    provider: ApiProviderId;
    models: ApiModelInfo[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    window.powerchord.listApiModels(provider).then(
      (models) => {
        if (!cancelled) setResult({ provider, models, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setResult({
            provider,
            models: null,
            error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [provider]);

  return result && result.provider === provider
    ? { models: result.models, error: result.error }
    : { models: null, error: null };
}

/** This month's estimated pay-as-you-go spending and the user's budgets, kept current. */
export function useUsage(): UsageOverview | null {
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.powerchord.onUsageChanged(setUsage);
    void window.powerchord.getUsage().then((value) => {
      if (!cancelled) setUsage(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return usage;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}
