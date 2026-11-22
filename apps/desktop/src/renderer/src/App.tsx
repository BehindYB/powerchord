import { useEffect, useRef, useState } from 'react';
import { AgentsView } from './components/AgentsView';
import { HubView } from './components/HubView';
import { ModelsView } from './components/ModelsView';
import { NewSessionView } from './components/NewSessionView';
import { ProjectView } from './components/ProjectView';
import { SessionView } from './components/SessionView';
import { SettingsView } from './components/SettingsView';
import { Sidebar, type View } from './components/Sidebar';
import { useProjects } from './hooks/useProjects';
import { useSessionList } from './hooks/useSessions';

/** Sessions that can be shown side by side. */
const MAX_PANES = 3;

export function App() {
  const [view, setView] = useState<View>({ kind: 'new' });
  const [panes, setPanes] = useState<string[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const sessions = useSessionList();
  const projects = useProjects();
  const viewedProject =
    view.kind === 'project' ? projects.find((project) => project.id === view.projectId) : undefined;

  // Deleted sessions drop out of the layout.
  const openPanes = panes.filter((id) => sessions.some((session) => session.id === id));
  const focused = Math.min(focusedPane, Math.max(openPanes.length - 1, 0));

  const openSession = (id: string, split: boolean) => {
    const existing = openPanes.indexOf(id);
    setView({ kind: 'session' });
    if (existing >= 0) {
      setFocusedPane(existing);
      setPanes(openPanes);
    } else if (openPanes.length === 0) {
      setPanes([id]);
      setFocusedPane(0);
    } else if (split && openPanes.length < MAX_PANES) {
      setPanes([...openPanes, id]);
      setFocusedPane(openPanes.length);
    } else {
      setPanes(openPanes.map((pane, index) => (index === focused ? id : pane)));
    }
  };

  const closePane = (index: number) => {
    const next = openPanes.filter((_, position) => position !== index);
    setPanes(next);
    setFocusedPane(Math.max(0, Math.min(focused, next.length - 1)));
    if (next.length === 0) setView({ kind: 'new' });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') setView({ kind: 'new' });
      else if (key === 'k') searchInput.current?.focus();
      else if (key === ',') setView({ kind: 'settings' });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  let content;
  if (view.kind === 'agents') {
    content = <AgentsView />;
  } else if (view.kind === 'models') {
    content = <ModelsView />;
  } else if (view.kind === 'hub') {
    content = <HubView />;
  } else if (view.kind === 'settings') {
    content = <SettingsView />;
  } else if (viewedProject) {
    content = (
      <ProjectView
        key={viewedProject.id}
        project={viewedProject}
        sessions={sessions}
        onNewChat={() => setView({ kind: 'new', projectId: viewedProject.id })}
        onOpenSession={(id) => openSession(id, false)}
        onRemoved={() => setView({ kind: 'new' })}
      />
    );
  } else if (view.kind === 'session' && openPanes.length > 0) {
    const split = openPanes.length > 1;
    content = (
      <div className="flex min-h-0 flex-1 divide-x divide-border">
        {openPanes.map((id, index) => {
          const summary = sessions.find((session) => session.id === id)!;
          return (
            // Keyed by id so per-session view state resets when a pane shows another session.
            <SessionView
              key={id}
              summary={summary}
              focused={split ? index === focused : null}
              onFocus={() => setFocusedPane(index)}
              onClosePane={split ? () => closePane(index) : null}
              onDeleted={() => closePane(index)}
            />
          );
        })}
      </div>
    );
  } else {
    content = (
      <NewSessionView
        // Keyed by project so switching projects starts a fresh form.
        key={view.kind === 'new' ? (view.projectId ?? 'none') : 'none'}
        projects={projects}
        projectId={view.kind === 'new' ? view.projectId : undefined}
        onCreated={(id) => openSession(id, false)}
        onOpenAgents={() => setView({ kind: 'agents' })}
        onOpenModels={() => setView({ kind: 'models' })}
        onOpenSettings={() => setView({ kind: 'settings' })}
      />
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        view={view}
        sessions={sessions}
        projects={projects}
        openSessions={view.kind === 'session' ? openPanes : []}
        canSplit={openPanes.length > 0 && openPanes.length < MAX_PANES}
        searchInput={searchInput}
        onNavigate={setView}
        onOpenSession={openSession}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region h-10 shrink-0" />
        {content}
      </main>
    </div>
  );
}
