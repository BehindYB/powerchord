import { useState } from 'react';
import { AgentsView } from './components/AgentsView';
import { ModelsView } from './components/ModelsView';
import { NewSessionView } from './components/NewSessionView';
import { SessionView } from './components/SessionView';
import { Sidebar, type View } from './components/Sidebar';
import { useSessionList } from './hooks/useSessions';

export function App() {
  const [view, setView] = useState<View>({ kind: 'new' });
  const sessions = useSessionList();
  const activeSession =
    view.kind === 'session' ? sessions.find((session) => session.id === view.id) : undefined;

  let content;
  if (view.kind === 'agents') {
    content = <AgentsView />;
  } else if (view.kind === 'models') {
    content = <ModelsView />;
  } else if (activeSession) {
    // Keyed by id so per-session view state resets when switching sessions.
    content = (
      <SessionView
        key={activeSession.id}
        summary={activeSession}
        onClosed={() => setView({ kind: 'new' })}
      />
    );
  } else {
    content = (
      <NewSessionView
        onCreated={(id) => setView({ kind: 'session', id })}
        onOpenAgents={() => setView({ kind: 'agents' })}
        onOpenModels={() => setView({ kind: 'models' })}
      />
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar view={view} sessions={sessions} onNavigate={setView} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region h-10 shrink-0" />
        {content}
      </main>
    </div>
  );
}
