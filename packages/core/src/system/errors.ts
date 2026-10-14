/**
 * APIs and agents often report errors as JSON, sometimes nested inside other JSON strings.
 * Returns the innermost human-readable message.
 */
export function readableErrorMessage(message: string): string {
  let current = message;
  for (let depth = 0; depth < 5; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return current;
    }
    const value = parsed as { error?: { message?: unknown } | string; message?: unknown } | null;
    const inner =
      typeof value?.error === 'object' && value.error !== null
        ? value.error.message
        : (value?.error ?? value?.message);
    if (typeof inner !== 'string') return current;
    current = inner;
  }
  return current;
}
