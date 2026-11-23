import { useState } from 'react';
import { SESSION_AGENT_NAMES, type ProjectSummary, type SessionSummary } from '../../../shared/ipc';
import { ProjectMemory } from './ProjectMemory';

function formatWhen(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString();
}

/** A project's page: its folder, its chats and a way to start another. */
export function ProjectView({
  project,
  sessions,
  onNewChat,
  onOpenSession,
  onRemoved,
}: {
  project: ProjectSummary;
  sessions: SessionSummary[];
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const chats = sessions
    .filter((session) => session.projectId === project.id)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const run = (action: Promise<unknown>) =>
    action.then(
      () => setError(null),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );

  const saveName = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== project.name) {
      void run(window.powerchord.renameProject(project.id, name));
    } else {
      setName(project.name);
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start gap-3 border-b border-border pb-4">
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveName();
                  if (event.key === 'Escape') {
                    setName(project.name);
                    setEditing(false);
                  }
                }}
                aria-label="Project name"
                className="w-full rounded-lg border border-border bg-elevated px-2 py-1 text-2xl font-semibold select-text"
              />
            ) : (
              <h1
                className="cursor-text truncate text-2xl font-semibold tracking-tight"
                title="Click to rename"
                onClick={() => {
                  setName(project.name);
                  setEditing(true);
                }}
              >
                {project.name}
              </h1>
            )}
            <p className="mt-1 truncate text-xs text-muted select-text" title={project.folder}>
              {project.folder}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void run(window.powerchord.openProjectFolder(project.id))}
              className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
            >
              Open folder
            </button>
            <button
              type="button"
              onClick={() =>
                void run(
                  window.powerchord.removeProject(project.id).then((removed) => {
                    if (removed) onRemoved();
                  }),
                )
              }
              className="rounded-lg border border-border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-hover"
            >
              Remove project
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-sm font-medium">Chats</h2>
          <button
            type="button"
            onClick={onNewChat}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast"
          >
            New chat
          </button>
        </div>
        {chats.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No chats yet. Start one with any agent or model; it works in this project&apos;s folder.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(chat.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{chat.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {[
                        SESSION_AGENT_NAMES[chat.agentId],
                        chat.model,
                        chat.archived ? 'Archived' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {chat.status === 'running' ? 'Working…' : formatWhen(chat.lastActiveAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <ProjectMemory project={project} />
      </div>
    </section>
  );
}
