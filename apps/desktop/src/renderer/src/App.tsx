import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';

export function App() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <Workspace />
    </div>
  );
}
