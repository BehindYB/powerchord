import type { PermissionMode } from '@powerchord/core/sessions';
import { useEffect, useState } from 'react';
import {
  CLAUDE_MODELS,
  CODEX_MODE_OPTIONS,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  type CodingAgentId,
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
  onOpenSettings: () => void;
}

const AGENT_CHOICES: readonly SessionAgentId[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'local-model',
];

function LinkButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="text-accent hover:underline">
      {children}
    </button>
  );
}

function useGeminiKeyConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.powerchord.listApiKeys().then((keys) => {
      if (!cancelled)
        setConfigured(keys.some((key) => key.provider === 'gemini' && key.configured));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return configured;
}

export function NewSessionView({
  onCreated,
  onOpenAgents,
  onOpenModels,
  onOpenSettings,
}: NewSessionViewProps) {
  const { agents } = useAgents();
  const { endpoints } = useModelEndpoints();
  const geminiKey = useGeminiKeyConfigured();
  const onlineEndpoints =
    endpoints?.filter((endpoint) => endpoint.online && endpoint.models.length > 0) ?? [];

  const [agentId, setAgentId] = useState<SessionAgentId>('claude-code');
  const [cwd, setCwd] = useState<string | null>(null);
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [codexMode, setCodexMode] = useState<string>('auto');
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCodingAgent = agentId !== 'local-model';
  const agent = isCodingAgent ? agents?.find((entry) => entry.id === agentId) : undefined;
  const agentName = SESSION_AGENT_NAMES[agentId];
  const endpoint = onlineEndpoints.find((entry) => entry.id === endpointId) ?? onlineEndpoints[0];
  const model =
    endpoint && localModel && endpoint.models.includes(localModel)
      ? localModel
      : endpoint?.models[0];

  const ready = isCodingAgent
    ? agent?.installed === true && cwd !== null && (agentId !== 'gemini-cli' || geminiKey === true)
    : Boolean(endpoint && model);

  const chooseFolder = async () => {
    const folder = await window.powerchord.chooseWorkingDirectory();
    if (folder) setCwd(folder);
  };

  const buildRequest = (): CreateSessionRequest | null => {
    if (agentId === 'local-model') {
      return endpoint && model ? { agentId, endpointId: endpoint.id, model } : null;
    }
    if (!cwd) return null;
    if (agentId === 'claude-code') return { agentId, cwd, model: claudeModel, permissionMode };
    if (agentId === 'codex') return { agentId, cwd, model: null, permissionMode: codexMode };
    return { agentId, cwd, model: null, permissionMode: null };
  };

  const start = async (text: string) => {
    const request = buildRequest();
    if (!request) return;
    try {
      const session = await window.powerchord.createSession(request);
      await window.powerchord.sendMessage(session.id, text);
      onCreated(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  let placeholder: string;
  if (!ready) {
    placeholder = isCodingAgent ? 'Choose a folder to start' : 'Add a model server to start';
  } else {
    placeholder = isCodingAgent ? `Describe a task for ${agentName}` : 'Message the model';
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
      <h1 className="text-3xl font-semibold tracking-tight">What are we working on?</h1>

      <div className="mt-8 w-full max-w-2xl">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <div className="flex rounded-lg border border-border bg-elevated p-0.5">
            {AGENT_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setAgentId(choice)}
                aria-pressed={agentId === choice}
                className={`rounded-md px-3 py-1 ${agentId === choice ? 'bg-hover font-medium' : 'text-muted hover:text-text'}`}
              >
                {SESSION_AGENT_NAMES[choice]}
              </button>
            ))}
          </div>
          {isCodingAgent && (
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

        {agent && !agent.installed && (
          <p className="mb-3 text-sm text-muted">
            {agentName} is not installed. <LinkButton onClick={onOpenAgents}>Set it up</LinkButton>.
          </p>
        )}
        {agent?.installed && agent.auth?.state === 'signed-out' && (
          <p className="mb-3 text-sm text-muted">
            {agentName} is not signed in. <LinkButton onClick={onOpenAgents}>Sign in</LinkButton>.
          </p>
        )}
        {agentId === 'gemini-cli' && geminiKey === false && (
          <p className="mb-3 text-sm text-muted">
            Gemini CLI runs with your Gemini API key.{' '}
            <LinkButton onClick={onOpenSettings}>Add a key</LinkButton>.
          </p>
        )}
        {agentId === 'gemini-cli' && geminiKey && (
          <p className="mb-3 text-xs text-muted">
            Usage is billed by Google to the project of your API key, within its free tier or
            credits.
          </p>
        )}
        {agentId === 'local-model' && endpoints && onlineEndpoints.length === 0 && (
          <p className="mb-3 text-sm text-muted">
            No reachable model server.{' '}
            <LinkButton onClick={onOpenModels}>Add or find one</LinkButton>.
          </p>
        )}

        <Composer placeholder={placeholder} disabled={!ready} onSubmit={start}>
          <AgentPickers
            agentId={agentId}
            claudeModel={claudeModel}
            onClaudeModel={setClaudeModel}
            permissionMode={permissionMode}
            onPermissionMode={setPermissionMode}
            codexMode={codexMode}
            onCodexMode={setCodexMode}
          />
          {agentId === 'local-model' && endpoint && model && (
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
          )}
        </Composer>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      </div>
    </section>
  );
}

function AgentPickers(props: {
  agentId: SessionAgentId;
  claudeModel: string | null;
  onClaudeModel: (model: string | null) => void;
  permissionMode: PermissionMode;
  onPermissionMode: (mode: PermissionMode) => void;
  codexMode: string;
  onCodexMode: (mode: string) => void;
}) {
  const agentId: CodingAgentId | null = props.agentId === 'local-model' ? null : props.agentId;
  if (agentId === 'claude-code') {
    return (
      <>
        <Picker
          label="Model"
          value={props.claudeModel}
          options={CLAUDE_MODELS}
          onChange={props.onClaudeModel}
        />
        <Picker<PermissionMode>
          label="Mode"
          value={props.permissionMode}
          options={PERMISSION_MODES}
          onChange={props.onPermissionMode}
        />
      </>
    );
  }
  // Codex and Gemini CLI report their models once they start; the session view lists them.
  if (agentId === 'codex') {
    return (
      <Picker
        label="Mode"
        value={props.codexMode}
        options={CODEX_MODE_OPTIONS}
        onChange={props.onCodexMode}
      />
    );
  }
  return null;
}
