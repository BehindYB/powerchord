import { useEffect, useState } from 'react';
import type {
  HubNote,
  HubRegistrationTarget,
  HubState,
  HubTask,
  TaskStatus,
} from '../../../shared/ipc';
import { useModelEndpoints } from '../hooks/useModelEndpoints';
import { Picker } from './Composer';
import { Markdown } from './Markdown';

const BUTTON =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50';
const INPUT = 'w-full rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm select-text';

const STATUS_OPTIONS: readonly { id: TaskStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useHub(): [HubState | null, (state: HubState) => void] {
  const [state, setState] = useState<HubState | null>(null);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.powerchord.onHubChanged((snapshot) =>
      setState((current) => current && { ...current, ...snapshot }),
    );
    void window.powerchord.getHub().then((hub) => {
      if (!cancelled) setState(hub);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return [state, setState];
}

function TaskCard({ task, onError }: { task: HubTask; onError: (message: string) => void }) {
  const update = (changes: Parameters<typeof window.powerchord.updateHubTask>[1]) =>
    window.powerchord.updateHubTask(task.id, changes).catch((cause) => onError(errorText(cause)));
  return (
    <article className="rounded-xl border border-border bg-elevated p-4 text-sm">
      <header className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted">{task.id}</span>
        <h3 className="font-medium">{task.title}</h3>
        <div className="ml-auto flex items-center gap-2">
          <Picker<TaskStatus>
            label=""
            value={task.status}
            options={STATUS_OPTIONS}
            onChange={(status) => void update({ status })}
          />
          <button
            type="button"
            onClick={() =>
              void window.powerchord
                .deleteHubTask(task.id)
                .catch((cause) => onError(errorText(cause)))
            }
            className="text-xs text-muted hover:text-text"
          >
            Delete
          </button>
        </div>
      </header>
      {task.description && (
        <p className="mt-2 whitespace-pre-wrap text-muted select-text">{task.description}</p>
      )}
      {task.summary && (
        <div className="mt-3 rounded-lg bg-bg p-3">
          <Markdown text={task.summary} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">
        {task.createdBy === task.updatedBy
          ? `By ${task.createdBy}`
          : `Created by ${task.createdBy} · updated by ${task.updatedBy}`}{' '}
        · {new Date(task.updatedAt).toLocaleString()}
      </p>
    </article>
  );
}

function NoteCard({ note, onError }: { note: HubNote; onError: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  return (
    <article className="rounded-xl border border-border bg-elevated p-4 text-sm">
      <header className="flex items-center gap-2">
        <h3 className="font-medium">{note.title}</h3>
        <span className="text-xs text-muted">
          {note.updatedBy} · {new Date(note.updatedAt).toLocaleString()}
        </span>
        <div className="ml-auto flex gap-3 text-xs">
          <button
            type="button"
            onClick={() => {
              setDraft(note.content);
              setEditing(!editing);
            }}
            className="text-muted hover:text-text"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={() =>
              void window.powerchord
                .deleteHubNote(note.id)
                .catch((cause) => onError(errorText(cause)))
            }
            className="text-muted hover:text-text"
          >
            Delete
          </button>
        </div>
      </header>
      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={8}
            className={INPUT}
          />
          <button
            type="button"
            className={`${BUTTON} mt-2`}
            onClick={() =>
              void window.powerchord
                .saveHubNote({ id: note.id, title: note.title, content: draft })
                .then(
                  () => setEditing(false),
                  (cause) => onError(errorText(cause)),
                )
            }
          >
            Save
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <Markdown text={note.content} />
        </div>
      )}
    </article>
  );
}

export function HubView() {
  const [hub, setHub] = useHub();
  const { endpoints } = useModelEndpoints();
  const [message, setMessage] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');

  if (!hub) return <section className="flex-1 px-8 pt-4 text-sm text-muted">Loading…</section>;

  const register = async (target: HubRegistrationTarget) => {
    setMessage(null);
    const outcome = await window.powerchord.registerHub(target);
    if (outcome.status === 'registered') setMessage('Added. Restart the agent to load the hub.');
    if (outcome.status === 'failed') setMessage(outcome.message);
  };

  const modelOptions = [
    { id: '', label: 'Automatic' },
    ...(endpoints ?? []).flatMap((endpoint) =>
      endpoint.models.map((model) => ({
        id: `${endpoint.id}|${model}`,
        label: `${model} · ${endpoint.name}`,
      })),
    ),
  ];
  const defaultModelId = hub.defaultModel
    ? `${hub.defaultModel.endpointId}|${hub.defaultModel.model}`
    : '';

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
      <div className="mx-auto max-w-3xl">
        <div className="pt-4 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Hub</h1>
          <p className="mt-1 text-sm text-muted">
            Tasks and notes shared between you and your agents, plus access to your local models.
            Agents reach the hub through PowerChord&apos;s local MCP server while PowerChord is
            running.
          </p>
        </div>

        <h2 className="mb-2 text-sm font-semibold">Connect agents</h2>
        <div className="rounded-2xl border border-border bg-elevated p-4 text-sm">
          <p>
            Claude Code sessions started in PowerChord use the hub automatically. To use it from
            agents you run on their own, add it to them:
          </p>
          <p className="mt-2 font-mono text-xs text-muted">{hub.connection.url}</p>
          {!hub.connection.usedPreferredPort && (
            <p className="mt-2 text-red-500">
              Port {hub.connection.preferredPort} was busy, so the hub runs on port{' '}
              {hub.connection.port}. Agents added earlier cannot reach it until PowerChord restarts
              on its usual port.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON}
              onClick={() => void register('antigravity-cli')}
            >
              Add to Antigravity
            </button>
            <button type="button" className={BUTTON} onClick={() => void register('claude-code')}>
              Add to Claude Code
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() =>
                void window.powerchord
                  .copyHubConfig()
                  .then(() => setMessage('Configuration copied.'))
              }
            >
              Copy configuration
            </button>
          </div>
        </div>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Local model for delegated prompts</h2>
        <p className="mb-2 text-sm text-muted">
          Used by the <code>ask_local_model</code> tool when an agent does not choose a model.
        </p>
        <Picker
          label="Model"
          value={defaultModelId}
          options={modelOptions}
          onChange={(value) => {
            const [endpointId, ...rest] = value.split('|');
            const model = value ? { endpointId: endpointId!, model: rest.join('|') } : null;
            void window.powerchord
              .setHubDefaultModel(model)
              .then(() => setHub({ ...hub, defaultModel: model }));
          }}
        />

        <h2 className="mt-8 mb-2 text-sm font-semibold">Tasks</h2>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void window.powerchord
              .addHubTask({ title: taskTitle, description: taskDescription })
              .then(
                () => {
                  setTaskTitle('');
                  setTaskDescription('');
                },
                (cause) => setMessage(errorText(cause)),
              );
          }}
        >
          <input
            value={taskTitle}
            onChange={(event) => setTaskTitle(event.target.value)}
            placeholder="New task"
            className={INPUT}
          />
          {taskTitle && (
            <textarea
              value={taskDescription}
              onChange={(event) => setTaskDescription(event.target.value)}
              placeholder="Details for whoever picks it up (optional)"
              rows={3}
              className={INPUT}
            />
          )}
          {taskTitle && (
            <button type="submit" className={`${BUTTON} self-start`}>
              Add task
            </button>
          )}
        </form>
        <div className="mt-3 flex flex-col gap-3">
          {hub.tasks.length === 0 && <p className="text-sm text-muted">No tasks yet.</p>}
          {[...hub.tasks].reverse().map((task) => (
            <TaskCard key={task.id} task={task} onError={setMessage} />
          ))}
        </div>

        <h2 className="mt-8 mb-2 text-sm font-semibold">Notes</h2>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void window.powerchord.saveHubNote({ title: noteTitle, content: noteContent }).then(
              () => {
                setNoteTitle('');
                setNoteContent('');
              },
              (cause) => setMessage(errorText(cause)),
            );
          }}
        >
          <input
            value={noteTitle}
            onChange={(event) => setNoteTitle(event.target.value)}
            placeholder="New note"
            className={INPUT}
          />
          {noteTitle && (
            <textarea
              value={noteContent}
              onChange={(event) => setNoteContent(event.target.value)}
              placeholder="Markdown"
              rows={5}
              className={INPUT}
            />
          )}
          {noteTitle && (
            <button type="submit" className={`${BUTTON} self-start`}>
              Add note
            </button>
          )}
        </form>
        <div className="mt-3 flex flex-col gap-3">
          {hub.notes.length === 0 && <p className="text-sm text-muted">No notes yet.</p>}
          {[...hub.notes]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((note) => (
              <NoteCard key={note.id} note={note} onError={setMessage} />
            ))}
        </div>

        {message && <p className="mt-6 text-sm">{message}</p>}
      </div>
    </section>
  );
}
