import type { ContextUsage } from '@powerchord/core/sessions';
import { useEffect, useRef, useState } from 'react';

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

/** A ring that fills with the share of the context in use. */
function Ring({ share }: { share: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
      />
    </svg>
  );
}

/**
 * Context meter for the composer: a ring with the share in use and, on click, the details and a
 * button to compact the conversation.
 */
export function ContextGauge({
  context,
  autoCompactAt,
  canCompact,
  onCompact,
}: {
  context: ContextUsage;
  /** Share of the window at which the agent compacts by itself, when it does. */
  autoCompactAt: number | null;
  canCompact: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const { usedTokens, windowTokens } = context;
  const share = windowTokens ? Math.min(1, usedTokens / windowTokens) : null;
  const percent = share === null ? null : Math.round(share * 100);
  const tone =
    share === null || share < 0.6
      ? 'text-muted'
      : share < (autoCompactAt ?? 0.8)
        ? 'text-amber-500'
        : 'text-red-500';
  const untilCompact =
    share !== null && autoCompactAt !== null
      ? Math.max(0, Math.round((autoCompactAt - share) * 100))
      : null;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Context usage"
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-hover ${tone}`}
      >
        {share !== null && <Ring share={share} />}
        <span>{percent !== null ? `${percent}%` : `${formatTokens(usedTokens)} tokens`}</span>
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-72 rounded-xl border border-border bg-elevated p-3 text-xs shadow-lg">
          <p className="font-medium text-text">Context</p>
          <p className="mt-1 text-muted">
            {usedTokens.toLocaleString()}
            {windowTokens !== null ? ` of ${windowTokens.toLocaleString()} tokens` : ' tokens'}
            {percent !== null ? ` (${percent}%)` : ''}
          </p>
          {share !== null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
              <div
                className={`h-full rounded-full bg-current ${tone}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          <p className="mt-2 text-muted">
            {windowTokens === null
              ? 'The size of the context window is not reported, so the chat cannot compact by itself.'
              : untilCompact !== null
                ? untilCompact > 0
                  ? `${untilCompact}% left until the conversation is compacted automatically.`
                  : 'The conversation is compacted automatically before the next request.'
                : 'The agent compacts the conversation by itself when it needs to.'}
          </p>
          <button
            type="button"
            disabled={!canCompact}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
            className="mt-3 w-full rounded-lg border border-border px-3 py-1.5 text-text hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Compact now
          </button>
          <p className="mt-2 text-muted">
            Replaces the conversation with a summary, so the chat can go on. Same as typing{' '}
            <code className="rounded bg-bg px-1">/compact</code>.
          </p>
        </div>
      )}
    </div>
  );
}
