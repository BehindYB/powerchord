import { useAppInfo } from '../hooks/useAppInfo';

export function Sidebar() {
  const appInfo = useAppInfo();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag-region flex h-10 items-center px-4 text-sm font-semibold tracking-tight">
        PowerChord
      </div>

      <div className="px-3 pt-2">
        <button
          type="button"
          disabled
          title="Connect an agent to start a session"
          className="w-full rounded-lg bg-accent px-3 py-2 text-left text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          New session
        </button>
      </div>

      <nav aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto px-3 pt-5">
        <h2 className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Sessions
        </h2>
        <p className="px-1 text-sm text-muted">No sessions yet.</p>
      </nav>

      <footer className="border-t border-border px-4 py-3 text-xs text-muted">
        {appInfo ? `v${appInfo.version}` : ' '}
      </footer>
    </aside>
  );
}
