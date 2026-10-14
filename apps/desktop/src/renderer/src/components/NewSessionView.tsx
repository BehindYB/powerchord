import type { PermissionMode } from '@powerchord/core/sessions';
import { useState } from 'react';
import { CLAUDE_MODELS, PERMISSION_MODES } from '../../../shared/ipc';
import { useAgents } from '../hooks/useAgents';
import { Composer, Picker } from './Composer';

interface NewSessionViewProps {
  onCreated: (sessionId: string) => void;
  onOpenAgents: () => void;
}

export function NewSessionView({ onCreated, onOpenAgents }: NewSessionViewProps) {
  const { agents } = useAgents();
  const claude = agents?.find((agent) => agent.id === 'claude-code');
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [error, setError] = useState<string | null>(null);
  const ready = claude?.installed === true && cwd !== null;

  const chooseFolder = async () => {
    const folder = await window.powerchord.chooseWorkingDirectory();
    if (folder) setCwd(folder);
  };

  const start = async (text: string) => {
    if (!cwd) return;
    try {
      const session = await window.powerchord.createSession({
        agentId: 'claude-code',
        cwd,
        model,
        permissionMode,
      });
      await window.powerchord.sendMessage(session.id, text);
      onCreated(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
      <h1 className="text-3xl font-semibold tracking-tight">What are we working on?</h1>

      <div className="mt-8 w-full max-w-2xl">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-lg border border-border bg-elevated px-3 py-1.5">
            Claude Code
          </span>
          <button
            type="button"
            onClick={() => void chooseFolder()}
            className="min-w-0 max-w-full truncate rounded-lg border border-border bg-elevated px-3 py-1.5 hover:bg-hover"
            title={cwd ?? undefined}
          >
            {cwd ?? 'Choose folder…'}
          </button>
        </div>

        {claude && !claude.installed && (
          <p className="mb-3 text-sm text-muted">
            Claude Code is not installed.{' '}
            <button type="button" onClick={onOpenAgents} className="text-accent hover:underline">
              Set it up
            </button>
            .
          </p>
        )}
        {claude?.auth?.state === 'signed-out' && (
          <p className="mb-3 text-sm text-muted">
            Claude Code is not signed in.{' '}
            <button type="button" onClick={onOpenAgents} className="text-accent hover:underline">
              Sign in
            </button>
            .
          </p>
        )}

        <Composer
          placeholder={ready ? 'Describe a task for Claude Code' : 'Choose a folder to start'}
          disabled={!ready}
          onSubmit={start}
        >
          <Picker label="Model" value={model} options={CLAUDE_MODELS} onChange={setModel} />
          <Picker<PermissionMode>
            label="Mode"
            value={permissionMode}
            options={PERMISSION_MODES}
            onChange={setPermissionMode}
          />
        </Composer>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      </div>
    </section>
  );
}
