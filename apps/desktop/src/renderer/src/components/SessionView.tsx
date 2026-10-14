import type { PermissionBehavior, PermissionMode, UsageLimits } from '@powerchord/core/sessions';
import { useEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, PERMISSION_MODES, type SessionSummary } from '../../../shared/ipc';
import { useModelEndpoints } from '../hooks/useModelEndpoints';
import { useSessionState } from '../hooks/useSessions';
import { Composer, Picker } from './Composer';
import { TranscriptItemView } from './TranscriptItemView';

function UsagePill({ limits }: { limits: UsageLimits }) {
  const format = (label: string, window: UsageLimits['fiveHour']) =>
    window ? `${label} ${Math.round(window.utilization * 100)}%` : null;
  const text = [format('5h', limits.fiveHour), format('7d', limits.sevenDay)]
    .filter(Boolean)
    .join(' · ');
  if (!text) return null;
  const resets = limits.fiveHour
    ? `5-hour window resets at ${new Date(limits.fiveHour.resetsAt * 1000).toLocaleTimeString()}`
    : undefined;
  return (
    <span title={resets} className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">
      Plan usage {text}
    </span>
  );
}

export function SessionView({
  summary,
  onClosed,
}: {
  summary: SessionSummary;
  onClosed: () => void;
}) {
  const state = useSessionState(summary.id);
  const { endpoints } = useModelEndpoints();
  const isClaude = summary.agentId === 'claude-code';
  const endpoint = endpoints?.find((entry) => entry.id === summary.endpointId);
  const agentLabel = isClaude ? 'Claude Code' : (endpoint?.name ?? 'Local model');
  const localModels = endpoint?.models.length
    ? endpoint.models
    : summary.model
      ? [summary.model]
      : [];
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const busy = state?.status === 'running' || state?.status === 'starting';

  useEffect(() => {
    const element = scroller.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  }, [state?.items]);

  const run = (action: Promise<unknown>) =>
    action.then(
      () => setError(null),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );

  const respond = (requestId: string, behavior: PermissionBehavior, scope: 'once' | 'session') =>
    void run(window.powerchord.respondToPermission(summary.id, requestId, behavior, scope));

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{summary.title}</h1>
          <p className="truncate text-xs text-muted" title={summary.cwd ?? undefined}>
            {[agentLabel, state?.model ?? summary.model ?? 'starting', summary.cwd]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state?.usageLimits && <UsagePill limits={state.usageLimits} />}
          {summary.cwd !== null && (
            <>
              <button
                type="button"
                onClick={() => void run(window.powerchord.openSessionIn(summary.id, 'explorer'))}
                className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-hover"
              >
                Open folder
              </button>
              <button
                type="button"
                onClick={() => void run(window.powerchord.openSessionIn(summary.id, 'antigravity'))}
                className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-hover"
              >
                Open in Antigravity
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void run(window.powerchord.closeSession(summary.id).then(onClosed))}
            className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-hover"
          >
            Close
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {state?.items.map((item) => (
            <TranscriptItemView key={item.id} item={item} onRespond={respond} />
          ))}
          {state?.status === 'starting' && (
            <p className="text-xs text-muted">Starting {agentLabel}…</p>
          )}
        </div>
      </div>

      <div className="px-6 pb-6">
        <div className="mx-auto max-w-3xl">
          {error && <p className="mb-2 text-sm text-red-500">{error}</p>}
          <Composer
            placeholder={isClaude ? 'Reply to Claude…' : 'Message the model…'}
            busy={busy}
            onSubmit={(text) => run(window.powerchord.sendMessage(summary.id, text))}
            onStop={() => void run(window.powerchord.interruptSession(summary.id))}
          >
            <Picker
              label="Model"
              value={summary.model}
              options={
                isClaude ? CLAUDE_MODELS : localModels.map((name) => ({ id: name, label: name }))
              }
              onChange={(model) =>
                void run(window.powerchord.updateSessionSettings(summary.id, { model }))
              }
            />
            {summary.permissionMode !== null && (
              <Picker<PermissionMode>
                label="Mode"
                value={summary.permissionMode}
                options={PERMISSION_MODES}
                onChange={(permissionMode) =>
                  void run(window.powerchord.updateSessionSettings(summary.id, { permissionMode }))
                }
              />
            )}
          </Composer>
        </div>
      </div>
    </section>
  );
}
