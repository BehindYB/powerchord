import { useState, type KeyboardEvent, type ReactNode } from 'react';

/** A slash command offered while the user types `/`. */
export interface ComposerCommand {
  /** Including the slash, for example `/compact`. */
  name: string;
  description: string;
}

interface ComposerProps {
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (text: string) => Promise<void> | void;
  onStop?: () => void;
  /** Slash commands suggested as the user types them; submitting one goes to `onSubmit`. */
  commands?: readonly ComposerCommand[];
  /** Shown next to the send button, such as the context meter. */
  status?: ReactNode;
  /** Controls shown in the composer's footer, such as model and mode pickers. */
  children?: ReactNode;
  /** Text to put in the composer, such as a rewound message; a new `key` replaces the draft. */
  draft?: { text: string; key: number } | null;
}

export function Composer({
  placeholder,
  disabled,
  busy,
  onSubmit,
  onStop,
  commands = [],
  status,
  children,
  draft,
}: ComposerProps) {
  const [text, setText] = useState('');
  // A new draft replaces the text while rendering, as React recommends for props-driven resets.
  const [draftKey, setDraftKey] = useState<number | null>(null);
  if (draft && draft.key !== draftKey) {
    setDraftKey(draft.key);
    setText(draft.text);
  }
  const [highlighted, setHighlighted] = useState(0);
  const canSend = !disabled && !busy && text.trim().length > 0;
  const suggestions = /^\/\S*$/.test(text)
    ? commands.filter((command) => command.name.startsWith(text))
    : [];
  const selected = suggestions[Math.min(highlighted, suggestions.length - 1)];

  const submit = async (value = text) => {
    if (disabled || busy || value.trim().length === 0) return;
    setText('');
    try {
      await onSubmit(value);
    } catch {
      // The caller reports the error; keep the draft so the user can retry.
      setText(value);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlighted((highlighted + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Tab' && selected) {
        event.preventDefault();
        setText(selected.name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setText('');
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit(selected ? selected.name : text);
    }
  };

  return (
    <div className="relative rounded-2xl border border-border bg-elevated p-3 shadow-sm">
      {suggestions.length > 0 && (
        <ul className="absolute right-3 bottom-full left-3 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-elevated py-1 text-sm shadow-lg">
          {suggestions.map((command) => (
            <li key={command.name}>
              <button
                type="button"
                onMouseDown={(event) => {
                  // Keeps the focus in the text area.
                  event.preventDefault();
                  void submit(command.name);
                }}
                onMouseEnter={() => setHighlighted(suggestions.indexOf(command))}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left ${
                  command === selected ? 'bg-hover' : ''
                }`}
              >
                <span className="font-mono">{command.name}</span>
                <span className="text-xs text-muted">{command.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setHighlighted(0);
        }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={3}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none select-text placeholder:text-muted disabled:cursor-not-allowed"
      />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {children}
        <div className="ml-auto flex items-center gap-1">
          {status}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Picker<T extends string | null>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  const encode = (id: T) => id ?? '';
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span>{label}</span>
      <select
        value={encode(value)}
        onChange={(event) => {
          const option = options.find((candidate) => encode(candidate.id) === event.target.value);
          if (option) onChange(option.id);
        }}
        className="rounded-md border border-border bg-bg px-1.5 py-1 text-xs text-text"
      >
        {options.map((option) => (
          <option key={encode(option.id)} value={encode(option.id)} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
