import type { PermissionBehavior, TranscriptItem } from '@powerchord/core/sessions';
import { useState } from 'react';
import { Markdown } from './Markdown';

const OUTPUT_PREVIEW_CHARS = 4000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** One-line description of a tool call, based on the most telling input field. */
export function describeToolInput(name: string, input: unknown): string {
  const fields = asRecord(input);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  };
  const summary =
    pick(
      'command',
      'file_path',
      'notebook_path',
      'path',
      'pattern',
      'url',
      'query',
      'description',
    ) ?? (Object.keys(fields).length > 0 ? JSON.stringify(fields) : '');
  return name === 'ExitPlanMode' ? 'Proposed plan' : summary;
}

function ToolCallView({ item }: { item: Extract<TranscriptItem, { kind: 'tool-call' }> }) {
  const [open, setOpen] = useState(false);
  const statusClass =
    item.status === 'running'
      ? 'bg-accent animate-pulse'
      : item.status === 'error'
        ? 'bg-red-500'
        : 'bg-emerald-500';
  const output = item.output ?? '';

  return (
    <div className="rounded-lg border border-border bg-elevated text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusClass}`} />
        <span className="font-medium">{item.name}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted">
          {describeToolInput(item.name, item.input)}
        </span>
        <span className="ml-auto text-xs text-muted">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap select-text">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {output && (
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-bg p-2 font-mono text-xs whitespace-pre-wrap select-text">
              {output.length > OUTPUT_PREVIEW_CHARS
                ? `${output.slice(0, OUTPUT_PREVIEW_CHARS)}\n… (${output.length - OUTPUT_PREVIEW_CHARS} more characters)`
                : output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionView({
  item,
  onRespond,
}: {
  item: Extract<TranscriptItem, { kind: 'permission' }>;
  onRespond: (behavior: PermissionBehavior, scope: 'once' | 'session') => void;
}) {
  const input = asRecord(item.input);
  const plan =
    item.toolName === 'ExitPlanMode' && typeof input['plan'] === 'string' ? input['plan'] : null;

  return (
    <div
      className={`rounded-xl border p-4 text-sm ${
        item.status === 'pending' ? 'border-accent bg-accent/5' : 'border-border bg-elevated'
      }`}
    >
      <p className="font-medium">
        {plan ? 'Claude proposes this plan' : `Claude wants to use ${item.toolName}`}
      </p>
      {plan ? (
        <div className="mt-2">
          <Markdown text={plan} />
        </div>
      ) : (
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-bg p-2 font-mono text-xs whitespace-pre-wrap select-text">
          {describeToolInput(item.toolName, item.input) || JSON.stringify(item.input, null, 2)}
        </pre>
      )}
      {item.status === 'pending' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onRespond('allow', 'once')}
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-contrast"
          >
            {plan ? 'Approve plan' : 'Allow'}
          </button>
          {!plan && (
            <button
              type="button"
              onClick={() => onRespond('allow', 'session')}
              className="rounded-lg border border-border px-3 py-1.5 hover:bg-hover"
            >
              Allow {item.toolName} for this session
            </button>
          )}
          <button
            type="button"
            onClick={() => onRespond('deny', 'once')}
            className="rounded-lg border border-border px-3 py-1.5 hover:bg-hover"
          >
            Deny
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">{item.status === 'allow' ? 'Allowed' : 'Denied'}</p>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)} min`;
}

export function TranscriptItemView({
  item,
  onRespond,
}: {
  item: TranscriptItem;
  onRespond: (requestId: string, behavior: PermissionBehavior, scope: 'once' | 'session') => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-hover px-4 py-2 text-sm whitespace-pre-wrap select-text">
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="text-sm">
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer select-none">
            {item.streaming ? 'Thinking…' : 'Thought'}
          </summary>
          <div className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap select-text">
            {item.text}
          </div>
        </details>
      );
    case 'tool-call':
      return <ToolCallView item={item} />;
    case 'permission':
      return (
        <PermissionView
          item={item}
          onRespond={(behavior, scope) => onRespond(item.id, behavior, scope)}
        />
      );
    case 'turn-end': {
      const parts = [
        item.summary.durationMs !== null ? formatDuration(item.summary.durationMs) : null,
        item.summary.outputTokens !== null
          ? `${item.summary.outputTokens.toLocaleString()} output tokens`
          : null,
      ].filter(Boolean);
      return parts.length > 0 ? <p className="text-xs text-muted">{parts.join(' · ')}</p> : null;
    }
    case 'interrupted':
      return <p className="text-xs text-muted">Interrupted</p>;
    case 'error':
      return (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm whitespace-pre-wrap select-text">
          {item.message}
        </div>
      );
  }
}
