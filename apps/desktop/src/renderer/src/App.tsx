import { useState } from 'react';
import { AgentsView } from './components/AgentsView';
import { Sidebar, type View } from './components/Sidebar';
import { Workspace } from './components/Workspace';

export function App() {
  const [view, setView] = useState<View>('home');

  return (
    <div className="flex h-full">
      <Sidebar view={view} onNavigate={setView} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region h-10 shrink-0" />
        {view === 'agents' ? <AgentsView /> : <Workspace onOpenAgents={() => setView('agents')} />}
      </main>
    </div>
  );
}
