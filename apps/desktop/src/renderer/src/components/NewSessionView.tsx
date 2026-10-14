import type { PermissionMode } from '@powerchord/core/sessions';
import { useState } from 'react';
import {
  CLAUDE_MODELS,
  PERMISSION_MODES,
  type CreateSessionRequest,
  type SessionAgentId,
} from '../../../shared/ipc';
import { useAgents } from '../hooks/useAgents';
import { useModelEndpoints } from '../hooks/useModelEndpoints';
import { Composer, Picker } from './Composer';

interface NewSessionViewProps {
  onCreated: (sessionId: string) => void;
  onOpenAgents: () => void;
  onOpenModels: () => void;
}

const AGENT_CHOICES: readonly { id: SessionAgentId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'local-model', label: 'Local model' },
];

function LinkButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="text-accent hover:underline">
      {children}
    </button>
  );
}

export function NewSessionView({ onCreated, onOpenAgents, onOpenModels }: NewSessionViewProps) {
  const { agents } = useAgents();
  const { endpoints } = useModelEndpoints();
  const claude = agents?.find((agent) => agent.id === 'claude-code');
  const onlineEndpoints =
    endpoints?.filter((endpoint) => endpoint.online && endpoint.models.length > 0) ?? [];

  const [agentId, setAgentId] = useState<SessionAgentId>('claude-code');
  const [cwd, setCwd] = useState<string | null>(null);
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endpoint = onlineEndpoints.find((entry) => entry.id === endpointId) ?? onlineEndpoints[0];
  const model =
    endpoint && localModel && endpoint.models.includes(localModel)
      ? localModel
      : endpoint?.models[0];

  const ready =
    agentId === 'claude-code'
      ? claude?.installed === true && cwd !== null
      : Boolean(endpoint && model);

  const chooseFolder = async () => {
    const folder = await window.powerchord.chooseWorkingDirectory();
    if (folder) setCwd(folder);
  };

  const start = async (text: string) => {
    let request: CreateSessionRequest;
    if (agentId === 'claude-code') {
      if (!cwd) return;
      request = { agentId, cwd, model: claudeModel, permissionMode };
    } else {
      if (!endpoint || !model) return;
      request = { agentId, endpointId: endpoint.id, model };
    }
    try {
      const session = await window.powerchord.createSession(request);
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
          <div className="flex rounded-lg border border-border bg-elevated p-0.5">
            {AGENT_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                onClick={() => setAgentId(choice.id)}
                aria-pressed={agentId === choice.id}
                className={`rounded-md px-3 py-1 ${agentId === choice.id ? 'bg-hover font-medium' : 'text-muted hover:text-text'}`}
              >
                {choice.label}
              </button>
            ))}
          </div>
          {agentId === 'claude-code' && (
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="max-w-full min-w-0 truncate rounded-lg border border-border bg-elevated px-3 py-1.5 hover:bg-hover"
              title={cwd ?? undefined}
            >
              {cwd ?? 'Choose folder…'}
            </button>
          )}
        </div>

        {agentId === 'claude-code' && claude && !claude.installed && (
          <p className="mb-3 text-sm text-muted">
            Claude Code is not installed. <LinkButton onClick={onOpenAgents}>Set it up</LinkButton>.
          </p>
        )}
        {agentId === 'claude-code' && claude?.auth?.state === 'signed-out' && (
          <p className="mb-3 text-sm text-muted">
            Claude Code is not signed in. <LinkButton onClick={onOpenAgents}>Sign in</LinkButton>.
          </p>
        )}
        {agentId === 'local-model' && endpoints && onlineEndpoints.length === 0 && (
          <p className="mb-3 text-sm text-muted">
            No reachable model server.{' '}
            <LinkButton onClick={onOpenModels}>Add or find one</LinkButton>.
          </p>
        )}

        <Composer
          placeholder={
            ready
              ? agentId === 'claude-code'
                ? 'Describe a task for Claude Code'
                : 'Message the model'
              : agentId === 'claude-code'
                ? 'Choose a folder to start'
                : 'Add a model server to start'
          }
          disabled={!ready}
          onSubmit={start}
        >
          {agentId === 'claude-code' ? (
            <>
              <Picker
                label="Model"
                value={claudeModel}
                options={CLAUDE_MODELS}
                onChange={setClaudeModel}
              />
              <Picker<PermissionMode>
                label="Mode"
                value={permissionMode}
                options={PERMISSION_MODES}
                onChange={setPermissionMode}
              />
            </>
          ) : (
            endpoint &&
            model && (
              <>
                <Picker
                  label="Server"
                  value={endpoint.id}
                  options={onlineEndpoints.map((entry) => ({ id: entry.id, label: entry.name }))}
                  onChange={setEndpointId}
                />
                <Picker
                  label="Model"
                  value={model}
                  options={endpoint.models.map((name) => ({ id: name, label: name }))}
                  onChange={setLocalModel}
                />
              </>
            )
          )}
        </Composer>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      </div>
    </section>
  );
}
