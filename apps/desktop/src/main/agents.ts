import { homedir } from 'node:os';
import {
  buildChildEnv,
  detectAgent,
  detectAgents,
  getAgent,
  installOptions,
  isAgentId,
  openInTerminal,
  resolveSearchPath,
  runInstall,
  type AgentDefinition,
  type AgentId,
  type AgentStatus,
  type InstallMethod,
} from '@powerchord/core';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IpcChannel,
  type AgentInfo,
  type InstallOutcome,
  type InstallOutputEvent,
} from '../shared/ipc';

const installsInProgress = new Set<AgentId>();

function requireAgentId(value: unknown): AgentId {
  if (typeof value !== 'string' || !isAgentId(value)) throw new Error('Unknown agent');
  return value;
}

async function toAgentInfo(status: AgentStatus, searchPath: string[]): Promise<AgentInfo> {
  const options = await installOptions(getAgent(status.id), { searchPath });
  return {
    id: status.id,
    displayName: status.displayName,
    vendor: status.vendor,
    integration: status.integration,
    docsUrl: status.docsUrl,
    installed: status.installed,
    version: status.version,
    path: status.path,
    auth: status.auth,
    installMethods: options.map(({ method, missingRequirements }) => ({
      id: method.id,
      label: method.label,
      display: method.display,
      sourceUrl: method.sourceUrl,
      missingRequirements,
    })),
  };
}

async function listAgents(): Promise<AgentInfo[]> {
  const searchPath = await resolveSearchPath();
  const statuses = await detectAgents({ searchPath });
  return Promise.all(statuses.map((status) => toAgentInfo(status, searchPath)));
}

async function installAgent(
  sender: Electron.WebContents,
  agentId: AgentId,
  methodId: string,
): Promise<InstallOutcome> {
  const agent = getAgent(agentId);
  const option = (await installOptions(agent)).find(
    (candidate) => candidate.method.id === methodId,
  );
  if (!option) return { status: 'failed', message: 'This install method is not available.' };
  if (option.missingRequirements.length > 0) {
    return {
      status: 'failed',
      message: `Missing requirements: ${option.missingRequirements.join(', ')}`,
    };
  }
  if (installsInProgress.has(agentId)) {
    return { status: 'failed', message: 'An installation is already running for this agent.' };
  }

  installsInProgress.add(agentId);
  try {
    return await confirmAndInstall(sender, agent, option.method);
  } finally {
    installsInProgress.delete(agentId);
  }
}

async function confirmAndInstall(
  sender: Electron.WebContents,
  agent: AgentDefinition,
  method: InstallMethod,
): Promise<InstallOutcome> {
  // The confirmation is shown by the main process so the renderer cannot bypass it.
  const window = BrowserWindow.fromWebContents(sender);
  const confirmation = {
    type: 'question' as const,
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: `Install ${agent.displayName}`,
    message: `Install ${agent.displayName} from ${agent.vendor}'s official channel?`,
    detail: `PowerChord will run:\n\n${method.display}\n\nSource: ${method.sourceUrl}`,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, confirmation)
    : await dialog.showMessageBox(confirmation);
  if (response !== 0) return { status: 'cancelled' };

  try {
    const result = await runInstall(method, {
      onOutput: (chunk) => {
        if (sender.isDestroyed()) return;
        const event: InstallOutputEvent = { agentId: agent.id, chunk };
        sender.send(IpcChannel.InstallOutput, event);
      },
    });
    if (result.exitCode !== 0) {
      return { status: 'failed', message: `The installer exited with code ${result.exitCode}.` };
    }
    const status = await detectAgent(agent);
    return status.installed
      ? { status: 'installed', version: status.version }
      : {
          status: 'failed',
          message: 'The installer finished, but the agent was not found. Restart PowerChord.',
        };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

async function openAgentSignIn(agentId: AgentId): Promise<void> {
  const agent = getAgent(agentId);
  const searchPath = await resolveSearchPath();
  const status = await detectAgent(agent, { searchPath });
  if (!status.path) throw new Error(`${agent.displayName} is not installed.`);
  // The agent's own sign-in flow runs in a separate terminal; PowerChord never sees credentials.
  await openInTerminal(
    { command: status.path, args: agent.loginArgs },
    { cwd: homedir(), env: buildChildEnv(searchPath) },
  );
}

export function registerAgentHandlers(): void {
  ipcMain.handle(IpcChannel.ListAgents, () => listAgents());
  ipcMain.handle(IpcChannel.InstallAgent, (event, agentId: unknown, methodId: unknown) => {
    if (typeof methodId !== 'string') throw new Error('Invalid install method');
    return installAgent(event.sender, requireAgentId(agentId), methodId);
  });
  ipcMain.handle(IpcChannel.OpenAgentSignIn, (_event, agentId: unknown) =>
    openAgentSignIn(requireAgentId(agentId)),
  );
}
