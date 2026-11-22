import {
  MODEL_CHAT_MODES,
  type ContextUsage,
  type PermissionBehavior,
  type QuestionAnswers,
  type SessionState,
  type UsageLimits,
} from '@powerchord/core/sessions';
import { useEffect, useRef, useState } from 'react';
import {
  CODEX_MODE_OPTIONS,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  API_PROVIDERS,
  type ApiModelInfo,
  type ModelOption,
  type SessionSummary,
} from '../../../shared/ipc';
import { formatUsd, useApiModels, useClaudeModels, useUsage } from '../hooks/useApi';
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

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

/** How full the model's context is, with a button to compact the conversation. */
function ContextPill({
  context,
  canCompact,
  onCompact,
}: {
  context: ContextUsage;
  canCompact: boolean;
  onCompact: () => void;
}) {
  const { usedTokens, windowTokens } = context;
  const share = windowTokens ? Math.min(1, usedTokens / windowTokens) : null;
  const tone =
    share === null || share < 0.6 ? 'text-muted' : share < 0.8 ? 'text-amber-500' : 'text-red-500';
  const title =
    windowTokens === null
      ? 'Tokens the next request will use, approximately. The model server does not report its context window, so the chat cannot compact itself; use Compact when answers get slow or fail.'
      : `Tokens the next request will use, out of the model's ${windowTokens.toLocaleString()}-token context window. The chat compacts itself at 80%.`;
  return (
    <span className="flex items-center gap-1.5">
      <span
        title={title}
        className={`flex items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 text-xs whitespace-nowrap ${tone}`}
      >
        Context {formatTokens(usedTokens)}
        {windowTokens !== null && share !== null && (
          <>
            {' '}
            / {formatTokens(windowTokens)}
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full bg-current"
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </span>
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onCompact}
        disabled={!canCompact}
        title="Replace the conversation with a summary written by the model, to free context"
        className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Compact
      </button>
    </span>
  );
}

/** Models the session can switch to; agents that report their models list them once started. */
function modelOptions(
  summary: SessionSummary,
  state: SessionState | null,
  localModels: string[],
  apiModels: ApiModelInfo[] | null,
  claudeModels: readonly ModelOption[],
): readonly ModelOption[] {
  if (summary.agentId === 'claude-code') {
    if (summary.model === null || claudeModels.some((option) => option.id === summary.model)) {
      return claudeModels;
    }
    return [...claudeModels, { id: summary.model, label: summary.model }];
  }
  if (summary.agentId === 'api-model') {
    const options: ModelOption[] = (apiModels ?? []).map(({ id, label }) => ({ id, label }));
    if (summary.model && !options.some((option) => option.id === summary.model)) {
      options.unshift({ id: summary.model, label: summary.model });
    }
    return options;
  }
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
  if (
    (summary.agentId === 'local-model' || summary.agentId === 'api-model') &&
    summary.cwd !== null &&
    summary.permissionMode
  ) {
    return { value: summary.permissionMode, options: MODEL_CHAT_MODES };
  }
  const value = summary.permissionMode ?? state?.permissionMode ?? null;
  const options = state?.availableModes;
  return summary.agentId === 'gemini-cli' && value && options?.some((mode) => mode.id === value)
    ? { value, options }
    : null;
}

/** Estimated spend of this session and of its provider this month. */
function CostPill({ summary, state }: { summary: SessionSummary; state: SessionState | null }) {
  const usage = useUsage();
  const provider = summary.provider;
  if (!provider) return null;
  const sessionCost = (state?.items ?? []).reduce(
    (total, item) => total + (item.kind === 'turn-end' ? (item.summary.costUsd ?? 0) : 0),
    0,
  );
  const month = usage?.providers[provider]?.costUsd ?? 0;
  const budget = usage?.budgets.monthlyUsd[provider];
  const name = API_PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
  const over = budget !== undefined && month >= budget;
  return (
    <span
      title={`Estimated from list prices. ${name} this month: ${formatUsd(month)}${
        budget !== undefined ? ` of ${formatUsd(budget)}` : ''
      }.`}
      className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${
        over ? 'bg-red-500/15 text-red-500' : 'bg-hover text-muted'
      }`}
    >
      ≈ {formatUsd(sessionCost)} · month {formatUsd(month)}
      {budget !== undefined ? ` / ${formatUsd(budget)}` : ''}
    </span>
  );
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
  const claudeModels = useClaudeModels();
  const isLocal = summary.agentId === 'local-model' || summary.agentId === 'api-model';
  const { models: apiModels } = useApiModels(
    summary.agentId === 'api-model' ? summary.provider : null,
  );
  const endpoint = endpoints?.find((entry) => entry.id === summary.endpointId);
  const agentLabel =
    summary.agentId === 'api-model'
      ? (API_PROVIDERS.find((entry) => entry.id === summary.provider)?.name ?? 'API model')
      : summary.agentId === 'local-model'
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
        className={`relative flex flex-wrap items-center gap-3 border-b border-border ${padding} ${onClosePane ? 'py-3 pr-12' : 'pb-3'}`}
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
          {isLocal && state?.context && (
            <ContextPill
              context={state.context}
              canCompact={!busy && state.items.some((item) => item.kind === 'user')}
              onCompact={() => void run(window.powerchord.compactSession(summary.id))}
            />
          )}
          <CostPill summary={summary} state={state} />
          {state?.usageLimits && !summary.provider && <UsagePill limits={state.usageLimits} />}
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
              className="absolute top-3 right-3 rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover hover:text-text"
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
              showCost={summary.provider !== null}
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
              options={modelOptions(summary, state, localModels, apiModels, claudeModels)}
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
