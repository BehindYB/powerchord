import {
  detectAgent,
  getAgent,
  resolveSearchPath,
  type AgentDelegationGateway,
  type AgentId,
  type DelegationRequest,
  type DelegationResult,
  type DelegationTarget,
  type SessionState,
} from '@powerchord/core';
import { BrowserWindow, dialog } from 'electron';
import {
  API_PROVIDERS,
  SESSION_AGENT_NAMES,
  type ApiProviderId,
  type CreateSessionRequest,
  type SessionSummary,
} from '../shared/ipc';
import { getApiKey } from './api-keys';
import { listApiModels } from './api-models';
import { listEndpointInfos } from './models';

/*
 * Delegation between agents (docs/COMPLIANCE.md, "Delegation between agents"). A sub-chat is an
 * ordinary session: it runs the same official agents with the same permission prompts, cost
 * confirmations and project folder rules as a chat the user starts.
 */

/** Longest answer returned to the delegating agent; the end of the answer is kept. */
const MAX_RESPONSE_CHARS = 20_000;
const POLL_INTERVAL_MS = 400;
const CODING_AGENTS = ['claude-code', 'codex', 'gemini-cli'] as const;

/** What the delegation service needs from the session manager. */
export interface DelegationHost {
  get(sessionId: string): { summary: SessionSummary; state: SessionState } | null;
  /** Creates a session linked to its parent, starting its agent. */
  createChild(
    request: CreateSessionRequest,
    parentSessionId: string | null,
  ): Promise<SessionSummary>;
  /** Sends a message as the user would, including the cost confirmation of pay-as-you-go chats. */
  sendMessage(sessionId: string, text: string): Promise<void>;
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserIndex(state: SessionState): number {
  for (let index = state.items.length - 1; index >= 0; index--) {
    if (state.items[index]!.kind === 'user') return index;
  }
  return -1;
}

/** Whether the turn started at `from` (an index into the transcript) has ended. */
function turnEnded(summary: SessionSummary, state: SessionState, from: number): boolean {
  if (summary.status === 'running' || summary.status === 'starting') return false;
  return state.items
    .slice(Math.max(from, 0))
    .some(
      (item) => item.kind === 'turn-end' || item.kind === 'interrupted' || item.kind === 'error',
    );
}

function agentName(summary: SessionSummary): string {
  return summary.endpointId
    ? `local:${summary.endpointId}`
    : summary.agentId === 'api-model' && summary.provider
      ? `api:${summary.provider}`
      : summary.agentId;
}

/** The sub-chat's state as the delegating agent sees it. */
export function delegationResult(
  summary: SessionSummary,
  state: SessionState,
  ended: boolean,
): DelegationResult {
  const from = lastUserIndex(state);
  const turn = state.items.slice(from + 1);
  let response = turn
    .flatMap((item) => (item.kind === 'text' && item.text.trim() ? [item.text.trim()] : []))
    .join('\n\n');
  if (response.length > MAX_RESPONSE_CHARS) {
    response = `[…]\n${response.slice(-MAX_RESPONSE_CHARS)}`;
  }
  const last = [...turn]
    .reverse()
    .find(
      (item) => item.kind === 'turn-end' || item.kind === 'interrupted' || item.kind === 'error',
    );
  const error = turn.flatMap((item) => (item.kind === 'error' ? [item.message] : [])).at(-1);
  return {
    sessionId: summary.id,
    title: summary.title,
    agent: agentName(summary),
    status: !ended
      ? 'running'
      : last?.kind === 'interrupted'
        ? 'interrupted'
        : last?.kind === 'error' || (last?.kind === 'turn-end' && last.summary.isError)
          ? 'failed'
          : 'completed',
    waitingForUser: turn.some((item) => item.kind === 'permission' && item.status === 'pending'),
    response,
    error: error ?? null,
  };
}

export class DelegationService implements AgentDelegationGateway {
  private readonly host: DelegationHost;
  /** Sub-chats started by agents outside PowerChord, which have no session to link them to. */
  private readonly externalChildren = new Set<string>();

  constructor(host: DelegationHost) {
    this.host = host;
  }

  async targets(): Promise<DelegationTarget[]> {
    const searchPath = await resolveSearchPath();
    const agents = await Promise.all(
      CODING_AGENTS.map(async (id): Promise<DelegationTarget | null> => {
        const status = await detectAgent(getAgent(id as AgentId), { searchPath });
        if (!status.path) return null;
        if (id === 'gemini-cli' && !(await getApiKey('gemini'))) return null;
        return { agent: id, name: SESSION_AGENT_NAMES[id], models: [], modelRequired: false };
      }),
    );
    const endpoints = (await listEndpointInfos())
      .filter((endpoint) => endpoint.online && endpoint.models.length > 0)
      .map((endpoint): DelegationTarget => ({
        agent: `local:${endpoint.id}`,
        name: `${endpoint.name} (local model server)`,
        models: endpoint.models,
        modelRequired: endpoint.models.length > 1,
      }));
    const providers = await Promise.all(
      API_PROVIDERS.map(async (provider): Promise<DelegationTarget | null> => {
        if (!(await getApiKey(provider.id))) return null;
        const models = await listApiModels(provider.id).catch(() => []);
        return {
          agent: `api:${provider.id}`,
          name: `${provider.name} (pay-as-you-go)`,
          models: models.map((model) => model.id),
          modelRequired: true,
        };
      }),
    );
    return [...agents, ...endpoints, ...providers].filter(
      (target): target is DelegationTarget => target !== null,
    );
  }

  async start(request: DelegationRequest): Promise<DelegationResult> {
    const parent = request.parentSessionId ? this.host.get(request.parentSessionId) : null;
    if (request.parentSessionId && !parent) throw new Error('Unknown delegating session.');
    if (parent?.summary.parentSessionId) {
      throw new Error('A sub-chat cannot delegate further; answer the delegating agent instead.');
    }
    const folder = parent ? parent.summary.cwd : request.folder;
    if (!folder) throw new Error('Delegation needs a project folder.');
    if (!parent && !(await this.confirmExternal(request, folder))) {
      throw new Error('The user declined the delegation.');
    }

    const child = await this.host.createChild(
      await this.sessionRequest(request, folder, parent?.summary ?? null),
      parent ? parent.summary.id : null,
    );
    if (!parent) this.externalChildren.add(child.id);
    return this.sendAndWait(child.id, request.prompt, request.waitMs, request.signal);
  }

  async send(request: {
    parentSessionId: string | null;
    sessionId: string;
    prompt: string;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<DelegationResult> {
    const child = this.child(request.parentSessionId, request.sessionId);
    if (child.summary.status === 'running' || child.summary.status === 'starting') {
      throw new Error('The sub-chat is still working; call wait_for_agent first.');
    }
    return this.sendAndWait(child.summary.id, request.prompt, request.waitMs, request.signal);
  }

  async wait(request: {
    parentSessionId: string | null;
    sessionId: string;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<DelegationResult> {
    const child = this.child(request.parentSessionId, request.sessionId);
    return this.waitForTurn(
      child.summary.id,
      lastUserIndex(child.state),
      request.waitMs,
      request.signal,
    );
  }

  private child(parentSessionId: string | null, sessionId: string) {
    const child = this.host.get(sessionId);
    const linked = parentSessionId
      ? child?.summary.parentSessionId === parentSessionId
      : this.externalChildren.has(sessionId);
    if (!child || !linked) throw new Error('No sub-chat with this session id was started here.');
    return child;
  }

  private async sendAndWait(
    sessionId: string,
    prompt: string,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<DelegationResult> {
    const from = this.host.get(sessionId)?.state.items.length ?? 0;
    await this.host.sendMessage(sessionId, prompt);
    return this.waitForTurn(sessionId, from, waitMs, signal);
  }

  private async waitForTurn(
    sessionId: string,
    from: number,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<DelegationResult> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const session = this.host.get(sessionId);
      if (!session) throw new Error('The sub-chat was deleted.');
      const ended = turnEnded(session.summary, session.state, from);
      if (ended || Date.now() >= deadline || signal?.aborted) {
        return delegationResult(session.summary, session.state, ended);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Builds the sub-chat's settings: the parent's mode for the same agent, the default otherwise. */
  private async sessionRequest(
    request: DelegationRequest,
    cwd: string,
    parent: SessionSummary | null,
  ): Promise<CreateSessionRequest> {
    const inherited = (agentId: SessionSummary['agentId']) =>
      parent?.agentId === agentId ? parent.permissionMode : null;
    const model = request.model?.trim() || null;
    const agent = request.agent.trim();

    if (agent === 'claude-code') {
      // A planning parent still delegates work that has to be done, so plan mode is not inherited.
      const mode = inherited('claude-code');
      return {
        agentId: 'claude-code',
        cwd,
        model,
        permissionMode: mode === 'acceptEdits' || mode === 'auto' ? mode : 'default',
        billing: 'subscription',
      };
    }
    if (agent === 'codex') {
      return { agentId: 'codex', cwd, model, permissionMode: inherited('codex') ?? 'auto' };
    }
    if (agent === 'gemini-cli') {
      return { agentId: 'gemini-cli', cwd, model, permissionMode: inherited('gemini-cli') };
    }
    const modelMode =
      parent?.agentId === 'local-model' || parent?.agentId === 'api-model'
        ? (parent.permissionMode ?? 'ask')
        : 'ask';
    if (agent.startsWith('local:')) {
      const endpointId = agent.slice('local:'.length);
      const endpoint = (await listEndpointInfos()).find((entry) => entry.id === endpointId);
      if (!endpoint) throw new Error(`Unknown model server "${endpointId}"; see list_agents.`);
      const chosen = model ?? (endpoint.models.length === 1 ? endpoint.models[0]! : null);
      if (!chosen) throw new Error('Choose a model from list_agents.');
      return {
        agentId: 'local-model',
        endpointId,
        model: chosen,
        cwd,
        permissionMode: modelMode,
      };
    }
    if (agent.startsWith('api:')) {
      const provider = agent.slice('api:'.length) as ApiProviderId;
      if (!API_PROVIDERS.some((entry) => entry.id === provider)) {
        throw new Error(`Unknown provider "${provider}"; see list_agents.`);
      }
      if (!model) throw new Error('Choose a model from list_agents.');
      return { agentId: 'api-model', provider, model, cwd, permissionMode: modelMode };
    }
    throw new Error(`Unknown agent "${agent}"; see list_agents.`);
  }

  /** Agents outside PowerChord have no chat the user is watching, so the user confirms first. */
  private async confirmExternal(request: DelegationRequest, folder: string): Promise<boolean> {
    const window = mainWindow();
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Start sub-chat', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Delegation request',
      message: `${request.author} wants to start ${request.agent} in ${folder}.`,
      detail: `Task:\n${request.prompt.slice(0, 800)}${request.prompt.length > 800 ? '…' : ''}`,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    return response === 0;
  }
}
