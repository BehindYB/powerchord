import type {
  PermissionBehavior,
  QuestionAnswers,
  SessionState,
  UsageLimits,
} from '@powerchord/core/sessions';
import { useEffect, useRef, useState } from 'react';
import {
  CLAUDE_MODELS,
  CODEX_MODE_OPTIONS,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  type ModelOption,
  type SessionSummary,
} from '../../../shared/ipc';
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
    <span
      title={resets}
      className="rounded-full bg-hover px-2 py-0.5 text-xs whitespace-nowrap text-muted"
    >
      Plan usage {text}
    </span>
  );
}

/** Models the session can switch to; agents that report their models list them once started. */
function modelOptions(
  summary: SessionSummary,
  state: SessionState | null,
  localModels: string[],
): readonly ModelOption[] {
  if (summary.agentId === 'claude-code') return CLAUDE_MODELS;
  if (summary.agentId === 'local-model')
    return localModels.map((name) => ({ id: name, label: name }));
  const reported = state?.availableModels ?? [];
  const options: ModelOption[] = [{ id: null, label: 'Default' }, ...reported];
  if (summary.model && !reported.some((option) => option.id === summary.model)) {
    options.push({ id: summary.model, label: summary.model });
  }
  return options;
}

function modeOptions(
  summary: SessionSummary,
  state: SessionState | null,
): { value: string; options: readonly { id: string; label: string }[] } | null {
  if (summary.agentId === 'claude-code' && summary.permissionMode) {
    return { value: summary.permissionMode, options: PERMISSION_MODES };
  }
  if (summary.agentId === 'codex' && summary.permissionMode) {
    return { value: summary.permissionMode, options: CODEX_MODE_OPTIONS };
  }
  const value = summary.permissionMode ?? state?.permissionMode ?? null;
  const options = state?.availableModes;
  return summary.agentId === 'gemini-cli' && value && options?.some((mode) => mode.id === value)
    ? { value, options }
    : null;
}

export function SessionView({
  summary,
  focused,
  onFocus,
  onClosePane,
  onDeleted,
}: {
  summary: SessionSummary;
  /** Whether this pane receives sidebar navigation; only shown when several panes are open. */
  focused: boolean | null;
  onFocus: () => void;
  /** Present when the session is shown next to others. */
  onClosePane: (() => void) | null;
  onDeleted: () => void;
}) {
  const state = useSessionState(summary.id);
  const { endpoints } = useModelEndpoints();
  const isLocal = summary.agentId === 'local-model';
  const endpoint = endpoints?.find((entry) => entry.id === summary.endpointId);
  const agentLabel = isLocal
    ? (endpoint?.name ?? 'Local model')
    : SESSION_AGENT_NAMES[summary.agentId];
  const mode = modeOptions(summary, state);
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

  // Layout changes, such as opening a pane next to this one, keep a pinned transcript at the end.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const run = (action: Promise<unknown>) =>
    action.then(
      () => setError(null),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );

  const respond = (requestId: string, behavior: PermissionBehavior, scope: 'once' | 'session') =>
    void run(window.powerchord.respondToPermission(summary.id, requestId, behavior, scope));
  const answer = (requestId: string, answers: QuestionAnswers) =>
    void run(window.powerchord.answerQuestion(summary.id, requestId, answers));
  const padding = onClosePane ? 'px-4' : 'px-6';

  return (
    <section
      onMouseDown={onFocus}
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${
        focused === null ? '' : `border-t-2 ${focused ? 'border-accent' : 'border-transparent'}`
      }`}
    >
      <div
        className={`flex flex-wrap items-center gap-3 border-b border-border ${padding} ${onClosePane ? 'py-3' : 'pb-3'}`}
      >
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{summary.title}</h1>
          <p className="truncate text-xs text-muted" title={summary.cwd ?? undefined}>
            {[agentLabel, state?.model ?? summary.model ?? 'starting', summary.cwd]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {state?.usageLimits && <UsagePill limits={state.usageLimits} />}
          {summary.cwd !== null && (
            <>
              <button
                type="button"
                onClick={() => void run(window.powerchord.openSessionIn(summary.id, 'explorer'))}
                className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
              >
                Open folder
              </button>
              <button
                type="button"
                onClick={() => void run(window.powerchord.openSessionIn(summary.id, 'antigravity'))}
                className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
              >
                Open in Antigravity
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() =>
              void run(
                window.powerchord.deleteSession(summary.id).then((deleted) => {
                  if (deleted) onDeleted();
                }),
              )
            }
            className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
          >
            Delete
          </button>
          {onClosePane && (
            <button
              type="button"
              onClick={onClosePane}
              aria-label="Close pane"
              title="Close pane"
              className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover hover:text-text"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className={`min-h-0 flex-1 overflow-y-auto ${padding} py-6`}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {state?.items.map((item) => (
            <TranscriptItemView
              key={item.id}
              item={item}
              agentName={agentLabel}
              onRespond={respond}
              onAnswer={answer}
            />
          ))}
          {state?.status === 'starting' && (
            <p className="text-xs text-muted">Starting {agentLabel}…</p>
          )}
        </div>
      </div>

      <div className={`${padding} pb-6`}>
        <div className="mx-auto max-w-3xl">
          {error && <p className="mb-2 text-sm text-red-500">{error}</p>}
          <Composer
            placeholder={isLocal ? 'Message the model…' : `Reply to ${agentLabel}…`}
            busy={busy}
            onSubmit={(text) => run(window.powerchord.sendMessage(summary.id, text))}
            onStop={() => void run(window.powerchord.interruptSession(summary.id))}
          >
            <Picker
              label="Model"
              value={summary.model}
              options={modelOptions(summary, state, localModels)}
              onChange={(model) =>
                void run(window.powerchord.updateSessionSettings(summary.id, { model }))
              }
            />
            {mode && (
              <Picker<string>
                label="Mode"
                value={mode.value}
                options={mode.options}
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
