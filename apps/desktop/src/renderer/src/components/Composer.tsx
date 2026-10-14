import { useState, type KeyboardEvent, type ReactNode } from 'react';

interface ComposerProps {
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (text: string) => Promise<void> | void;
  onStop?: () => void;
  /** Controls shown in the composer's footer, such as model and mode pickers. */
  children?: ReactNode;
}

export function Composer({
  placeholder,
  disabled,
  busy,
  onSubmit,
  onStop,
  children,
}: ComposerProps) {
  const [text, setText] = useState('');
  const canSend = !disabled && !busy && text.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    const value = text;
    setText('');
    try {
      await onSubmit(value);
    } catch {
      // The caller reports the error; keep the draft so the user can retry.
      setText(value);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-elevated p-3 shadow-sm">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={3}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none select-text placeholder:text-muted disabled:cursor-not-allowed"
      />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {children}
        <div className="ml-auto">
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
