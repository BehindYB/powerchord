export function Workspace() {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="drag-region h-10 shrink-0" />

      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
        <h1 className="text-3xl font-semibold tracking-tight">What are we working on?</h1>
        <p className="mt-3 max-w-md text-center text-sm text-muted">
          Run Claude Code, Codex, Gemini CLI and local models side by side. Agent setup is coming
          next.
        </p>

        <div className="mt-8 w-full max-w-2xl rounded-2xl border border-border bg-elevated p-3 shadow-sm">
          <textarea
            disabled
            rows={3}
            placeholder="No agent connected yet"
            className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed"
          />
        </div>
      </section>
    </main>
  );
}
