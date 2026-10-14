import {
  parseAgentQuestions,
  QUESTION_TOOL_NAME,
  type PermissionBehavior,
  type QuestionAnswers,
  type TranscriptItem,
} from '@powerchord/core/sessions';
import { useState } from 'react';
import { Markdown } from './Markdown';

const OUTPUT_PREVIEW_CHARS = 4000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Display name of a tool; MCP tools are named `mcp__<server>__<tool>`. */
export function toolDisplayName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return name;
  const [, server, tool] = match;
  return server === 'powerchord' ? `Hub · ${tool}` : `${server} · ${tool}`;
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
      'prompt',
      'title',
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
        <span className="font-medium">{toolDisplayName(item.name)}</span>
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
  agentName,
  onRespond,
}: {
  item: Extract<TranscriptItem, { kind: 'permission' }>;
  agentName: string;
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
        {plan
          ? `${agentName} proposes this plan`
          : // ACP agents name the action itself, for example "Write a.txt".
            item.toolName.includes(' ')
            ? `${agentName} asks for permission: ${item.toolName}`
            : `${agentName} wants to use ${toolDisplayName(item.toolName)}`}
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
              Allow {toolDisplayName(item.toolName)} for this session
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

/** Multiple-choice questions from Claude Code's AskUserQuestion tool. */
function QuestionView({
  item,
  agentName,
  onAnswer,
  onSkip,
}: {
  item: Extract<TranscriptItem, { kind: 'permission' }>;
  agentName: string;
  onAnswer: (answers: QuestionAnswers) => void;
  onSkip: () => void;
}) {
  const questions = parseAgentQuestions(item.input);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const pending = item.status === 'pending';

  const answerFor = (question: string): string => {
    const custom = other[question]?.trim();
    return [...(selected[question] ?? []), ...(custom ? [custom] : [])].join(', ');
  };
  const complete = questions.every((entry) => answerFor(entry.question).length > 0);

  const toggle = (question: string, label: string, multiSelect: boolean) => {
    const current = selected[question] ?? [];
    const next = multiSelect
      ? current.includes(label)
        ? current.filter((entry) => entry !== label)
        : [...current, label]
      : [label];
    setSelected({ ...selected, [question]: next });
    if (!multiSelect) setOther({ ...other, [question]: '' });
  };

  return (
    <div
      className={`rounded-xl border p-4 text-sm ${
        pending ? 'border-accent bg-accent/5' : 'border-border bg-elevated'
      }`}
    >
      <p className="font-medium">
        {agentName} has {questions.length > 1 ? 'questions' : 'a question'}
      </p>
      <div className="mt-3 flex flex-col gap-4">
        {questions.map((entry) => (
          <fieldset key={entry.question} disabled={!pending}>
            <legend className="mb-2">
              {entry.header && (
                <span className="mr-2 rounded bg-hover px-1.5 py-0.5 text-xs text-muted">
                  {entry.header}
                </span>
              )}
              {entry.question}
            </legend>
            {pending ? (
              <div className="flex flex-col gap-1.5">
                {entry.options.map((option) => {
                  const checked = (selected[entry.question] ?? []).includes(option.label);
                  return (
                    <label
                      key={option.label}
                      className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 ${
                        checked ? 'border-accent' : 'border-border hover:bg-hover'
                      }`}
                    >
                      <input
                        type={entry.multiSelect ? 'checkbox' : 'radio'}
                        name={`${item.id}:${entry.question}`}
                        checked={checked}
                        onChange={() => toggle(entry.question, option.label, entry.multiSelect)}
                        className="mt-0.5 accent-[var(--pc-accent)]"
                      />
                      <span>
                        <span className="font-medium">{option.label}</span>
                        {option.description && (
                          <span className="block text-xs text-muted">{option.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
                <input
                  value={other[entry.question] ?? ''}
                  onChange={(event) => {
                    setOther({ ...other, [entry.question]: event.target.value });
                    if (!entry.multiSelect && event.target.value) {
                      setSelected({ ...selected, [entry.question]: [] });
                    }
                  }}
                  placeholder="Other answer"
                  className="rounded-lg border border-border bg-elevated px-3 py-1.5 select-text"
                />
              </div>
            ) : (
              <p className="text-muted">
                {item.answers?.[entry.question] ?? (item.status === 'deny' ? 'Skipped' : '')}
              </p>
            )}
          </fieldset>
        ))}
      </div>
      {pending && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={!complete}
            onClick={() =>
              onAnswer(
                Object.fromEntries(
                  questions.map((entry) => [entry.question, answerFor(entry.question)]),
                ),
              )
            }
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-contrast disabled:opacity-50"
          >
            Answer
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="rounded-lg border border-border px-3 py-1.5 hover:bg-hover"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function formatCost(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)} min`;
}

export function TranscriptItemView({
  item,
  agentName,
  showCost,
  onRespond,
  onAnswer,
}: {
  item: TranscriptItem;
  agentName: string;
  /** Whether turns are billed per use; plan sessions report costs that are not charged. */
  showCost: boolean;
  onRespond: (requestId: string, behavior: PermissionBehavior, scope: 'once' | 'session') => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
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
      // Questions appear as their own card.
      return item.name === QUESTION_TOOL_NAME ? null : <ToolCallView item={item} />;
    case 'permission':
      if (item.toolName === QUESTION_TOOL_NAME) {
        return (
          <QuestionView
            item={item}
            agentName={agentName}
            onAnswer={(answers) => onAnswer(item.id, answers)}
            onSkip={() => onRespond(item.id, 'deny', 'once')}
          />
        );
      }
      return (
        <PermissionView
          item={item}
          agentName={agentName}
          onRespond={(behavior, scope) => onRespond(item.id, behavior, scope)}
        />
      );
    case 'turn-end': {
      const parts = [
        item.summary.durationMs !== null ? formatDuration(item.summary.durationMs) : null,
        item.summary.outputTokens !== null
          ? `${item.summary.outputTokens.toLocaleString()} output tokens`
          : null,
        showCost && item.summary.costUsd !== null && item.summary.costUsd > 0
          ? `≈ ${formatCost(item.summary.costUsd)}`
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
