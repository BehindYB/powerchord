import { useCallback, useEffect, useState } from 'react';
import type { ProjectContext, ProjectSummary } from '../../../shared/ipc';

const LINKABLE = [
  { file: 'CLAUDE.md', agent: 'Claude Code' },
  { file: 'GEMINI.md', agent: 'Gemini CLI' },
] as const;

function useProjectContext(projectId: string) {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const reload = useCallback(
    () => window.powerchord.getProjectContext(projectId).then(setContext),
    [projectId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { context, reload };
}

/** A text area saved explicitly, which follows outside changes while it has no edits. */
function Editor({
  label,
  description,
  value,
  placeholder,
  saveLabel,
  onSave,
}: {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  saveLabel: string;
  onSave: (text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== null && draft !== value;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        {dirty && <span className="text-xs text-muted">Unsaved changes</span>}
      </div>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <textarea
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        rows={8}
        className="mt-2 w-full resize-y rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-xs select-text"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            void onSave(draft ?? value).then(
              (saved) => {
                setSaving(false);
                if (saved !== false) setDraft(null);
              },
              () => setSaving(false),
            );
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-contrast disabled:opacity-40"
        >
          {saveLabel}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-hover"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}

/** Project instructions in the folder and the private memory kept in PowerChord. */
export function ProjectMemory({ project }: { project: ProjectSummary }) {
  const { context, reload } = useProjectContext(project.id);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      window.powerchord.onProjectMemoryChanged((projectId) => {
        if (projectId === project.id) void reload();
      }),
    [project.id, reload],
  );

  if (!context) return null;
  const file = (name: string) => context.instructions.find((entry) => entry.name === name);
  const shared = file('AGENTS.md');

  const run = async <T,>(action: Promise<T>): Promise<T> => {
    try {
      const result = await action;
      setError(null);
      await reload();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  return (
    <div className="mt-8 flex flex-col gap-8">
      {error && <p className="text-sm text-red-500">{error}</p>}

      <section>
        <Editor
          label="Instructions · AGENTS.md"
          description={
            'Shared instructions in the project folder: how to build, test and write code here. ' +
            'Codex and many other agents read AGENTS.md, and PowerChord gives it to model chats. ' +
            'It is part of the project, so it can be committed and shared.'
          }
          value={shared?.text ?? ''}
          placeholder={
            shared?.exists
              ? ''
              : '# Project instructions\n\n- How to build and test\n- Code style and conventions'
          }
          saveLabel={shared?.exists ? 'Save AGENTS.md' : 'Create AGENTS.md'}
          onSave={(text) => run(window.powerchord.saveProjectInstructions(project.id, text))}
        />
        <ul className="mt-3 flex flex-col gap-1.5 text-xs">
          {LINKABLE.map(({ file: name, agent }) => {
            const entry = file(name);
            return (
              <li key={name} className="flex flex-wrap items-center gap-2 text-muted">
                {entry?.importsShared ? (
                  <span>
                    ✓ {agent} reads {name}, which imports AGENTS.md.
                  </span>
                ) : (
                  <>
                    <span>
                      {agent} reads {name}
                      {entry?.exists ? ', which does not import AGENTS.md.' : ', which is missing.'}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void run(window.powerchord.linkProjectInstructions(project.id, name))
                      }
                      className="rounded-md border border-border px-2 py-0.5 text-text hover:bg-hover"
                    >
                      Use AGENTS.md in {name}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <Editor
          label="Memory · private"
          description={
            'Notes about this project kept in PowerChord on this computer, never in the folder. ' +
            'Model chats and Claude Code receive them when they start; every agent can read them ' +
            'and add to them with the hub tools, asking first as its mode requires.'
          }
          value={context.memory}
          placeholder={'- Prefers small commits\n- The staging server is staging.example.test'}
          saveLabel="Save memory"
          onSave={(text) => run(window.powerchord.saveProjectMemory(project.id, text))}
        />
      </section>
    </div>
  );
}
