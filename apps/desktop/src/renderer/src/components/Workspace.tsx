interface WorkspaceProps {
  onOpenAgents: () => void;
}

export function Workspace({ onOpenAgents }: WorkspaceProps) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
      <h1 className="text-3xl font-semibold tracking-tight">What are we working on?</h1>
      <p className="mt-3 max-w-md text-center text-sm text-muted">
        Run Claude Code, Codex, Gemini CLI and local models side by side. Sessions are coming next;
        start by setting up your{' '}
        <button type="button" onClick={onOpenAgents} className="text-accent hover:underline">
          agents
        </button>
        .
      </p>

      <div className="mt-8 w-full max-w-2xl rounded-2xl border border-border bg-elevated p-3 shadow-sm">
        <textarea
          disabled
          rows={3}
          placeholder="Sessions are not available yet"
          className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>
    </section>
  );
}
