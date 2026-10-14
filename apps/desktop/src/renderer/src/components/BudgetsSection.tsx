import { useState } from 'react';
import { API_PROVIDERS, type ApiProviderId, type Budgets } from '../../../shared/ipc';
import { formatUsd, useUsage } from '../hooks/useApi';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50';
const AMOUNT =
  'w-24 rounded-lg border border-border bg-bg px-2 py-1 text-right text-sm select-text';

function parseAmount(value: string): number | undefined {
  const amount = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export function BudgetsSection() {
  const usage = useUsage();
  // Drafts hold what the user is typing; empty means "no limit".
  const [drafts, setDrafts] = useState<Partial<Record<ApiProviderId | 'confirm', string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  if (!usage) return null;

  const draftFor = (key: ApiProviderId | 'confirm', saved: number | undefined) =>
    drafts[key] ?? (saved === undefined ? '' : String(saved));

  const save = () => {
    const monthlyUsd: Budgets['monthlyUsd'] = {};
    for (const provider of API_PROVIDERS) {
      const amount = parseAmount(draftFor(provider.id, usage.budgets.monthlyUsd[provider.id]));
      if (amount !== undefined) monthlyUsd[provider.id] = amount;
    }
    const confirmAboveUsd =
      parseAmount(draftFor('confirm', usage.budgets.confirmAboveUsd)) ??
      usage.budgets.confirmAboveUsd;
    void window.powerchord.setBudgets({ monthlyUsd, confirmAboveUsd }).then(
      () => {
        setDrafts({});
        setMessage('Budgets saved.');
      },
      (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  return (
    <>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Spending and budgets</h2>
      <p className="mb-2 text-sm text-muted">
        Estimated pay-as-you-go spending in {usage.month}, from list prices checked on{' '}
        {usage.pricesReviewed}. Providers bill by their own records, and free tiers, credits and
        caching lower the actual charge. PowerChord asks before sending past a monthly budget or a
        message estimated above your limit.
      </p>
      <div className="rounded-2xl border border-border bg-elevated text-sm">
        {API_PROVIDERS.map((provider) => {
          const spent = usage.providers[provider.id];
          return (
            <div
              key={provider.id}
              className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2"
            >
              <span className="min-w-0 flex-1">
                {provider.name}
                <span className="block text-xs text-muted">
                  {formatUsd(spent?.costUsd ?? 0)} this month · {spent?.requests ?? 0} requests
                </span>
              </span>
              <label className="flex items-center gap-2 text-xs text-muted">
                Monthly budget $
                <input
                  inputMode="decimal"
                  value={draftFor(provider.id, usage.budgets.monthlyUsd[provider.id])}
                  onChange={(event) => setDrafts({ ...drafts, [provider.id]: event.target.value })}
                  placeholder="None"
                  className={AMOUNT}
                />
              </label>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <span className="min-w-0 flex-1">Ask before a message estimated above</span>
          <label className="flex items-center gap-2 text-xs text-muted">
            $
            <input
              inputMode="decimal"
              value={draftFor('confirm', usage.budgets.confirmAboveUsd)}
              onChange={(event) => setDrafts({ ...drafts, confirm: event.target.value })}
              className={AMOUNT}
            />
          </label>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" className={BUTTON} onClick={save}>
          Save budgets
        </button>
        {message && <span className="text-sm text-muted">{message}</span>}
      </div>
    </>
  );
}
