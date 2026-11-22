import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../../shared/ipc';

export function useProjects(): ProjectSummary[] {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.powerchord.onProjectsChanged(setProjects);
    void window.powerchord.listProjects().then((list) => {
      if (!cancelled) setProjects(list);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return projects;
}
