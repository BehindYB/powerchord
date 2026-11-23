import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { ProjectSummary, SessionSummary } from '../../../shared/ipc';
import { useAppInfo } from '../hooks/useAppInfo';

export type View =
  | { kind: 'new'; projectId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'agents' }
  | { kind: 'models' }
  | { kind: 'hub' }
  | { kind: 'settings' }
  | { kind: 'session' };

/** Chats listed under a project before "Show all" links to the project page. */
const CHATS_PER_PROJECT = 5;
const EXPANDED_KEY = 'powerchord.expandedProjects';
const SHOW_ARCHIVED_KEY = 'powerchord.showArchived';

interface SidebarProps {
  view: View;
  sessions: SessionSummary[];
  projects: ProjectSummary[];
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

function SectionHeading({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="group/heading mt-3 mb-1 flex items-center justify-between px-2 first:mt-0">
      <span className="text-xs font-medium tracking-wide text-muted uppercase">{children}</span>
      {action}
    </div>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        d={
          open
            ? 'M1.5 4.5v8h11l2-5.5h-11l-2 5.5M1.5 4.5V3h4l1.5 1.5h5V7'
            : 'M1.5 3h4l1.5 1.5h7.5v8h-13z'
        }
      />
    </svg>
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

/** Which projects are expanded, remembered on this device. */
function useExpandedProjects(): [Set<string>, (id: string, expanded: boolean) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const set = (id: string, value: boolean) => {
    const next = new Set(expanded);
    if (value) next.add(id);
    else next.delete(id);
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      // Not remembering the layout is harmless.
    }
  };
  return [expanded, set];
}

export function Sidebar({
  view,
  sessions,
  projects,
  openSessions,
  canSplit,
  searchInput,
  onNavigate,
  onOpenSession,
}: SidebarProps) {
  const appInfo = useAppInfo();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useExpandedProjects();
  const [showArchived, setShowArchived] = useState(() => {
    try {
      return localStorage.getItem(SHOW_ARCHIVED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const matches = useSessionSearch(query, sessions);
  const searching = matches !== null;
  // Searches include archived chats; otherwise they are listed in their own section.
  const visible = matches
    ? sessions.filter((session) => matches.has(session.id))
    : sessions.filter((session) => !session.archived);
  const archived = sessions.filter((session) => session.archived);
  // Sub-chats are listed under the chat that delegated them, unless that chat is gone.
  const isNestedSubChat = (session: SessionSummary) =>
    !searching &&
    session.parentSessionId !== null &&
    sessions.some((parent) => parent.id === session.parentSessionId);
  const subChatsOf = (parentId: string) =>
    visible
      .filter((session) => session.parentSessionId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  const toggleArchived = () => {
    setShowArchived(!showArchived);
    try {
      localStorage.setItem(SHOW_ARCHIVED_KEY, String(!showArchived));
    } catch {
      // Not remembering the layout is harmless.
    }
  };

  const chatsOf = (projectId: string) =>
    visible.filter((session) => session.projectId === projectId && !isNestedSubChat(session));
  const looseChats = visible.filter(
    (session) =>
      !isNestedSubChat(session) &&
      (session.projectId === null || !projects.some((project) => project.id === session.projectId)),
  );
  // Most recently used projects first; a project's activity is its latest chat.
  const lastActive = (project: ProjectSummary) =>
    Math.max(
      project.createdAt,
      ...sessions
        .filter((session) => session.projectId === project.id)
        .map((session) => session.lastActiveAt),
    );
  const shownProjects = [...projects]
    .filter((project) => !searching || chatsOf(project.id).length > 0)
    .sort((a, b) => lastActive(b) - lastActive(a));

  const showSessionMenu = (session: SessionSummary) =>
    void window.powerchord
      .showSessionMenu(session.id, { canSplit: canSplit && !openSessions.includes(session.id) })
      .then((result) => {
        if (result === 'open-side-by-side') onOpenSession(session.id, true);
      });

  const showProjectMenu = (project: ProjectSummary) =>
    void window.powerchord.showProjectMenu(project.id).then((result) => {
      if (result === 'new-chat') onNavigate({ kind: 'new', projectId: project.id });
      else if (
        result === 'removed' &&
        (view.kind === 'project' || view.kind === 'new') &&
        view.projectId === project.id
      ) {
        onNavigate({ kind: 'new' });
      }
    });

  const sessionRow = (session: SessionSummary, nested: boolean, depth = 0): ReactNode => {
    const active = openSessions.includes(session.id);
    const subChats = searching ? [] : subChatsOf(session.id);
    const indent = depth > 0 ? (nested ? 'pl-11' : 'pl-6') : nested ? 'pl-7' : 'pl-2';
    return (
      <li key={session.id}>
        <div className="group relative">
          <button
            type="button"
            onClick={(event) => onOpenSession(session.id, event.ctrlKey || event.metaKey)}
            onContextMenu={(event) => {
              event.preventDefault();
              showSessionMenu(session);
            }}
            aria-current={active ? 'page' : undefined}
            title={[session.title, session.model].filter(Boolean).join('\n')}
            className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-8 text-left text-sm ${indent} ${
              active ? 'bg-hover' : 'text-muted hover:bg-hover hover:text-text'
            }`}
          >
            {depth > 0 && (
              <span aria-label="Sub-chat" className="-mr-1 text-xs text-muted">
                ↳
              </span>
            )}
            <StatusDot status={session.status} />
            <span className="truncate">{session.title}</span>
            {searching && session.archived && (
              <span className="shrink-0 text-xs text-muted">Archived</span>
            )}
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
        </div>
        {subChats.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {subChats.map((child) => sessionRow(child, nested, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const createProject = () =>
    void window.powerchord.createProject().then((project) => {
      if (project) {
        setExpanded(project.id, true);
        onNavigate({ kind: 'project', projectId: project.id });
      }
    });

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag-region flex h-10 items-center px-4 text-sm font-semibold tracking-tight">
        PowerChord
      </div>

      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => onNavigate({ kind: 'new' })}
          title="New chat (Ctrl+N)"
          className="w-full rounded-lg bg-accent px-3 py-2 text-left text-sm font-medium text-accent-contrast"
        >
          New chat
        </button>
      </div>

      <nav aria-label="Projects and chats" className="flex min-h-0 flex-1 flex-col px-3 pt-4">
        <input
          ref={searchInput}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
          placeholder="Search chats (Ctrl+K)"
          aria-label="Search chats"
          className="mb-3 w-full rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm select-text"
        />
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <SectionHeading
            action={
              <button
                type="button"
                onClick={createProject}
                aria-label="New project"
                title="New project from a folder"
                className="rounded px-1.5 text-sm leading-none text-muted hover:bg-hover hover:text-text"
              >
                +
              </button>
            }
          >
            Projects
          </SectionHeading>
          {shownProjects.length === 0 ? (
            <p className="px-2 pb-1 text-xs text-muted">
              {searching ? 'No matching chats in projects.' : 'Create one from a folder with +.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {shownProjects.map((project) => {
                const chats = chatsOf(project.id);
                const isOpen =
                  searching ||
                  expanded.has(project.id) ||
                  visible.some(
                    (chat) => chat.projectId === project.id && openSessions.includes(chat.id),
                  );
                const current =
                  (view.kind === 'project' || view.kind === 'new') && view.projectId === project.id;
                const shown = searching ? chats : chats.slice(0, CHATS_PER_PROJECT);
                return (
                  <li key={project.id}>
                    <div className="group relative flex items-center">
                      <button
                        type="button"
                        onClick={() => setExpanded(project.id, !isOpen)}
                        aria-label={isOpen ? `Collapse ${project.name}` : `Expand ${project.name}`}
                        aria-expanded={isOpen}
                        className="absolute left-0 z-10 flex h-full w-7 items-center justify-center text-muted hover:text-text"
                      >
                        <FolderIcon open={isOpen} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          // Opening a project shows its chats; clicking it again folds them.
                          setExpanded(project.id, !(current && isOpen));
                          onNavigate({ kind: 'project', projectId: project.id });
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          showProjectMenu(project);
                        }}
                        aria-current={current ? 'page' : undefined}
                        title={project.folder}
                        className={`flex w-full items-center rounded-lg py-1.5 pr-8 pl-7 text-left text-sm ${
                          current ? 'bg-hover font-medium' : 'hover:bg-hover'
                        }`}
                      >
                        <span className="truncate">{project.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onNavigate({ kind: 'new', projectId: project.id })}
                        aria-label={`New chat in ${project.name}`}
                        title="New chat in this project"
                        className="absolute top-1/2 right-1 hidden -translate-y-1/2 rounded px-1.5 text-sm leading-none text-muted group-hover:block hover:bg-border hover:text-text"
                      >
                        +
                      </button>
                    </div>
                    {isOpen && (
                      <ul className="flex flex-col gap-0.5">
                        {shown.map((session) => sessionRow(session, true))}
                        {chats.length === 0 && (
                          <li className="py-1 pl-7 text-xs text-muted">No chats yet.</li>
                        )}
                        {shown.length < chats.length && (
                          <li>
                            <button
                              type="button"
                              onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
                              className="py-1 pl-7 text-xs text-muted hover:text-text"
                            >
                              Show all {chats.length} chats
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <SectionHeading>Chats</SectionHeading>
          {looseChats.length === 0 ? (
            <p className="px-2 text-xs text-muted">
              {searching ? 'No matching chats.' : 'Chats without a folder appear here.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {looseChats.map((session) => sessionRow(session, false))}
            </ul>
          )}

          {!searching && archived.length > 0 && (
            <>
              <button
                type="button"
                onClick={toggleArchived}
                aria-expanded={showArchived}
                className="mt-3 mb-1 flex w-full items-center gap-1 px-2 text-xs font-medium tracking-wide text-muted uppercase hover:text-text"
              >
                <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span>
                Archived ({archived.length})
              </button>
              {showArchived && (
                <ul className="flex flex-col gap-0.5">
                  {archived.map((session) => sessionRow(session, false))}
                </ul>
              )}
            </>
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
