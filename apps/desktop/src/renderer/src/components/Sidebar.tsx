import type { SessionSummary } from '../../../shared/ipc';
import { useAppInfo } from '../hooks/useAppInfo';

export type View = { kind: 'new' } | { kind: 'agents' } | { kind: 'session'; id: string };

interface SidebarProps {
  view: View;
  sessions: SessionSummary[];
  onNavigate: (view: View) => void;
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
        active ? 'bg-hover font-medium' : 'text-muted hover:bg-hover hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

function StatusDot({ status }: { status: SessionSummary['status'] }) {
  const busy = status === 'running' || status === 'starting';
  return (
    <span
      aria-label={busy ? 'Working' : 'Idle'}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? 'animate-pulse bg-accent' : 'bg-border'}`}
    />
  );
}

export function Sidebar({ view, sessions, onNavigate }: SidebarProps) {
  const appInfo = useAppInfo();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag-region flex h-10 items-center px-4 text-sm font-semibold tracking-tight">
        PowerChord
      </div>

      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => onNavigate({ kind: 'new' })}
          className="w-full rounded-lg bg-accent px-3 py-2 text-left text-sm font-medium text-accent-contrast"
        >
          New session
        </button>
      </div>

      <nav aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto px-3 pt-5">
        <h2 className="px-1 pb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Sessions
        </h2>
        {sessions.length === 0 ? (
          <p className="px-1 text-sm text-muted">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const active = view.kind === 'session' && view.id === session.id;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate({ kind: 'session', id: session.id })}
                    aria-current={active ? 'page' : undefined}
                    title={session.cwd}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                      active ? 'bg-hover' : 'text-muted hover:bg-hover hover:text-text'
                    }`}
                  >
                    <StatusDot status={session.status} />
                    <span className="truncate">{session.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <nav aria-label="App" className="border-t border-border px-3 py-2">
        <NavButton active={view.kind === 'agents'} onClick={() => onNavigate({ kind: 'agents' })}>
          Agents
        </NavButton>
      </nav>

      <footer className="px-4 pb-3 text-xs text-muted">
        {appInfo ? `v${appInfo.version}` : ' '}
      </footer>
    </aside>
  );
}
