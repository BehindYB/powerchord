import { useEffect, useState, type RefObject } from 'react';
import type { SessionSummary } from '../../../shared/ipc';
import { useAppInfo } from '../hooks/useAppInfo';

export type View =
  | { kind: 'new' }
  | { kind: 'agents' }
  | { kind: 'models' }
  | { kind: 'hub' }
  | { kind: 'settings' }
  | { kind: 'session' };

interface SidebarProps {
  view: View;
  sessions: SessionSummary[];
  /** Sessions currently shown, in pane order. */
  openSessions: string[];
  /** Whether another session can be opened next to the current ones. */
  canSplit: boolean;
  searchInput: RefObject<HTMLInputElement | null>;
  onNavigate: (view: View) => void;
  onOpenSession: (id: string, split: boolean) => void;
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

/** Ids of sessions matching the search; null while no search is active. */
function useSessionSearch(query: string, sessions: SessionSummary[]): Set<string> | null {
  const [result, setResult] = useState<{ query: string; ids: Set<string> } | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.powerchord.searchSessions(trimmed).then((ids) => {
        if (!cancelled) setResult({ query: trimmed, ids: new Set(ids) });
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Sessions are a dependency so results follow new messages.
  }, [trimmed, sessions]);

  if (!trimmed) return null;
  return result?.query === trimmed ? result.ids : new Set();
}

export function Sidebar({
  view,
  sessions,
  openSessions,
  canSplit,
  searchInput,
  onNavigate,
  onOpenSession,
}: SidebarProps) {
  const appInfo = useAppInfo();
  const [query, setQuery] = useState('');
  const matches = useSessionSearch(query, sessions);
  const visible = matches ? sessions.filter((session) => matches.has(session.id)) : sessions;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag-region flex h-10 items-center px-4 text-sm font-semibold tracking-tight">
        PowerChord
      </div>

      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => onNavigate({ kind: 'new' })}
          title="New session (Ctrl+N)"
          className="w-full rounded-lg bg-accent px-3 py-2 text-left text-sm font-medium text-accent-contrast"
        >
          New session
        </button>
      </div>

      <nav aria-label="Sessions" className="flex min-h-0 flex-1 flex-col px-3 pt-4">
        <input
          ref={searchInput}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
          placeholder="Search sessions (Ctrl+K)"
          aria-label="Search sessions"
          className="mb-3 w-full rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm select-text"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-1 text-sm text-muted">
              {matches ? 'No matching sessions.' : 'No sessions yet.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((session) => {
                const active = openSessions.includes(session.id);
                return (
                  <li key={session.id} className="group relative">
                    <button
                      type="button"
                      onClick={(event) => onOpenSession(session.id, event.ctrlKey || event.metaKey)}
                      aria-current={active ? 'page' : undefined}
                      title={[session.title, session.cwd ?? session.model]
                        .filter(Boolean)
                        .join('\n')}
                      className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-left text-sm ${
                        active ? 'bg-hover' : 'text-muted hover:bg-hover hover:text-text'
                      }`}
                    >
                      <StatusDot status={session.status} />
                      <span className="truncate">{session.title}</span>
                    </button>
                    {canSplit && !active && (
                      <button
                        type="button"
                        onClick={() => onOpenSession(session.id, true)}
                        aria-label={`Open ${session.title} side by side`}
                        title="Open side by side (Ctrl+click)"
                        className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded px-1.5 text-xs text-muted group-hover:block hover:bg-border hover:text-text"
                      >
                        ⊞
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>

      <nav aria-label="App" className="border-t border-border px-3 py-2">
        <NavButton active={view.kind === 'agents'} onClick={() => onNavigate({ kind: 'agents' })}>
          Agents
        </NavButton>
        <NavButton active={view.kind === 'models'} onClick={() => onNavigate({ kind: 'models' })}>
          Models
        </NavButton>
        <NavButton active={view.kind === 'hub'} onClick={() => onNavigate({ kind: 'hub' })}>
          Hub
        </NavButton>
        <NavButton
          active={view.kind === 'settings'}
          onClick={() => onNavigate({ kind: 'settings' })}
        >
          Settings
        </NavButton>
      </nav>

      <footer className="px-4 pb-3 text-xs text-muted">
        {appInfo ? `v${appInfo.version}` : ' '}
      </footer>
    </aside>
  );
}
