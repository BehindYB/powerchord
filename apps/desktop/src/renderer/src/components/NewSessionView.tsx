import {
  MODEL_CHAT_MODES,
  type ModelChatMode,
  type PermissionMode,
} from '@powerchord/core/sessions';
import { useState } from 'react';
import {
  API_PROVIDERS,
  CODEX_MODE_OPTIONS,
  PERMISSION_MODES,
  SESSION_AGENT_NAMES,
  type ApiProviderId,
  type ClaudeBilling,
  type CodingAgentId,
  type CreateSessionRequest,
  type ProjectSummary,
  type SessionAgentId,
} from '../../../shared/ipc';
import { useAgents } from '../hooks/useAgents';
import { formatUsd, useApiKeys, useApiModels, useClaudeModels } from '../hooks/useApi';
import { useModelEndpoints } from '../hooks/useModelEndpoints';
import { Composer, Picker } from './Composer';

interface NewSessionViewProps {
  projects: ProjectSummary[];
  /** Project the chat starts in; the user can pick another one. */
  projectId?: string | undefined;
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
  'api-model',
];

/** Select value that opens the folder dialog instead of choosing a project. */
const CHOOSE_FOLDER = '__choose-folder';

const BILLING_OPTIONS: readonly { id: ClaudeBilling; label: string }[] = [
  { id: 'subscription', label: 'Subscription' },
  { id: 'api', label: 'API key' },
];

function LinkButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="text-accent hover:underline">
      {children}
    </button>
  );
}

export function NewSessionView({
  projects,
  projectId,
  onCreated,
  onOpenAgents,
  onOpenModels,
  onOpenSettings,
}: NewSessionViewProps) {
  const { agents } = useAgents();
  const { endpoints } = useModelEndpoints();
  const apiKeys = useApiKeys();
  const configuredProviders = API_PROVIDERS.filter((provider) =>
    apiKeys?.some((key) => key.provider === provider.id && key.configured),
  );
  const hasKey = (id: ApiProviderId) => configuredProviders.some((entry) => entry.id === id);
  const onlineEndpoints =
    endpoints?.filter((endpoint) => endpoint.online && endpoint.models.length > 0) ?? [];

  const [agentId, setAgentId] = useState<SessionAgentId>('claude-code');
  const [projectChoice, setProjectChoice] = useState<string | null>(projectId ?? null);
  const project = projects.find((entry) => entry.id === projectChoice) ?? null;
  const cwd = project?.folder ?? null;
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [codexMode, setCodexMode] = useState<string>('auto');
  const [modelMode, setModelMode] = useState<ModelChatMode>('ask');
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [billing, setBilling] = useState<ClaudeBilling>('subscription');
  const [providerChoice, setProviderChoice] = useState<ApiProviderId | null>(null);
  const [apiModelChoice, setApiModelChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCodingAgent = agentId !== 'local-model' && agentId !== 'api-model';
  const provider =
    providerChoice && hasKey(providerChoice)
      ? providerChoice
      : (configuredProviders[0]?.id ?? null);
  const { models: apiModels, error: apiModelsError } = useApiModels(
    agentId === 'api-model' ? provider : null,
  );
  const apiModel =
    apiModels?.find((entry) => entry.id === apiModelChoice) ?? apiModels?.[0] ?? null;
  const claudeBilling: ClaudeBilling = hasKey('anthropic') ? billing : 'subscription';
  const agent = isCodingAgent ? agents?.find((entry) => entry.id === agentId) : undefined;
  const agentName = SESSION_AGENT_NAMES[agentId];
  const endpoint = onlineEndpoints.find((entry) => entry.id === endpointId) ?? onlineEndpoints[0];
  const model =
    endpoint && localModel && endpoint.models.includes(localModel)
      ? localModel
      : endpoint?.models[0];

  let ready: boolean;
  if (isCodingAgent) {
    ready =
      agent?.installed === true && cwd !== null && (agentId !== 'gemini-cli' || hasKey('gemini'));
  } else if (agentId === 'api-model') {
    ready = apiModel !== null;
  } else {
    ready = Boolean(endpoint && model);
  }

  const chooseFolder = async () => {
    const created = await window.powerchord.createProject();
    if (created) setProjectChoice(created.id);
  };

  const buildRequest = (): CreateSessionRequest | null => {
    const folder = { cwd, permissionMode: cwd === null ? null : modelMode };
    if (agentId === 'local-model') {
      return endpoint && model ? { agentId, endpointId: endpoint.id, model, ...folder } : null;
    }
    if (agentId === 'api-model') {
      return provider && apiModel ? { agentId, provider, model: apiModel.id, ...folder } : null;
    }
    if (!cwd) return null;
    if (agentId === 'claude-code') {
      return { agentId, cwd, model: claudeModel, permissionMode, billing: claudeBilling };
    }
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
  if (ready) {
    placeholder =
      isCodingAgent || cwd !== null ? `Describe a task for ${agentName}` : 'Message the model';
  } else if (isCodingAgent) {
    placeholder = 'Choose a project to start';
  } else if (agentId === 'api-model') {
    placeholder = configuredProviders.length > 0 ? 'Loading models…' : 'Add an API key to start';
  } else {
    placeholder = 'Add a model server to start';
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        {project ? `New chat in ${project.name}` : 'What are we working on?'}
      </h1>

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
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="sr-only">Project</span>
            <select
              value={projectChoice ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (value === CHOOSE_FOLDER) void chooseFolder();
                else setProjectChoice(value || null);
              }}
              title={cwd ?? undefined}
              className="max-w-64 min-w-0 truncate rounded-lg border border-border bg-elevated px-2 py-1.5 hover:bg-hover"
            >
              <option value="">
                {isCodingAgent ? 'Choose a project…' : 'No project (chat only)'}
              </option>
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              <option value={CHOOSE_FOLDER}>New project from a folder…</option>
            </select>
          </label>
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
        {agentId === 'gemini-cli' && apiKeys && !hasKey('gemini') && (
          <p className="mb-3 text-sm text-muted">
            Gemini CLI runs with your Gemini API key.{' '}
            <LinkButton onClick={onOpenSettings}>Add a key</LinkButton>.
          </p>
        )}
        {agentId === 'gemini-cli' && hasKey('gemini') && (
          <p className="mb-3 text-xs text-muted">
            Usage is billed by Google to the project of your API key, within its free tier or
            credits.
          </p>
        )}
        {agentId === 'claude-code' && claudeBilling === 'api' && (
          <p className="mb-3 text-xs text-muted">
            Claude Code runs with your Anthropic API key instead of your plan, billed by Anthropic
            to your API account. It uses a separate Claude Code profile, so your personal Claude
            Code settings, memory and MCP servers are not loaded.
          </p>
        )}
        {agentId === 'api-model' && apiKeys && configuredProviders.length === 0 && (
          <p className="mb-3 text-sm text-muted">
            Chat with models billed to your own API account.{' '}
            <LinkButton onClick={onOpenSettings}>Add an API key</LinkButton>.
          </p>
        )}
        {agentId === 'api-model' && apiModelsError && (
          <p className="mb-3 text-sm text-red-500">{apiModelsError}</p>
        )}
        {agentId === 'api-model' && apiModel && (
          <p className="mb-3 text-xs text-muted">
            {apiModel.price
              ? `List price ${formatUsd(apiModel.price.input)} input and ${formatUsd(apiModel.price.output)} output per million tokens, billed by the provider.`
              : 'PowerChord does not know the price of this model; spending estimates leave it out.'}
          </p>
        )}
        {!isCodingAgent && (
          <p className="mb-3 text-xs text-muted">
            {cwd === null
              ? 'Without a project the model can only chat: it cannot see your files or the web.'
              : 'The model can read and change files in the project folder, run commands and fetch web pages. The mode decides what it does without asking.'}
          </p>
        )}
        {agentId === 'local-model' && endpoints && onlineEndpoints.length === 0 && (
          <p className="mb-3 text-sm text-muted">
            No reachable model server.{' '}
            <LinkButton onClick={onOpenModels}>Add or find one</LinkButton>.
          </p>
        )}

        <Composer placeholder={placeholder} disabled={!ready} onSubmit={start}>
          {agentId === 'claude-code' && hasKey('anthropic') && (
            <Picker<ClaudeBilling>
              label="Billing"
              value={claudeBilling}
              options={BILLING_OPTIONS}
              onChange={setBilling}
            />
          )}
          {agentId === 'api-model' && provider && (
            <Picker<ApiProviderId>
              label="Provider"
              value={provider}
              options={configuredProviders.map((entry) => ({ id: entry.id, label: entry.name }))}
              onChange={(value) => {
                setProviderChoice(value);
                setApiModelChoice(null);
              }}
            />
          )}
          {agentId === 'api-model' && apiModels && apiModel && (
            <Picker
              label="Model"
              value={apiModel.id}
              options={apiModels.map((entry) => ({ id: entry.id, label: entry.label }))}
              onChange={setApiModelChoice}
            />
          )}
          {!isCodingAgent && cwd !== null && (
            <Picker<ModelChatMode>
              label="Mode"
              value={modelMode}
              options={MODEL_CHAT_MODES}
              onChange={setModelMode}
            />
          )}
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
  const agentId: CodingAgentId | null =
    props.agentId === 'local-model' || props.agentId === 'api-model' ? null : props.agentId;
  const claudeModels = useClaudeModels();
  if (agentId === 'claude-code') {
    return (
      <>
        <Picker
          label="Model"
          value={props.claudeModel}
          options={claudeModels}
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
