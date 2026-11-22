import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannel,
  type DiscoveryProgress,
  type HubState,
  type InstallOutputEvent,
  type PowerChordApi,
  type ProjectSummary,
  type SessionEventMessage,
  type SessionSummary,
  type UsageOverview,
} from '../shared/ipc';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: PowerChordApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.GetAppInfo),
  listAgents: () => ipcRenderer.invoke(IpcChannel.ListAgents),
  installAgent: (agentId, methodId) =>
    ipcRenderer.invoke(IpcChannel.InstallAgent, agentId, methodId),
  onInstallOutput: (listener) => subscribe<InstallOutputEvent>(IpcChannel.InstallOutput, listener),
  openAgentSignIn: (agentId) => ipcRenderer.invoke(IpcChannel.OpenAgentSignIn, agentId),

  chooseWorkingDirectory: () => ipcRenderer.invoke(IpcChannel.ChooseWorkingDirectory),
  listSessions: () => ipcRenderer.invoke(IpcChannel.ListSessions),
  searchSessions: (query) => ipcRenderer.invoke(IpcChannel.SearchSessions, query),
  createSession: (request) => ipcRenderer.invoke(IpcChannel.CreateSession, request),
  getSession: (sessionId) => ipcRenderer.invoke(IpcChannel.GetSession, sessionId),
  sendMessage: (sessionId, text) => ipcRenderer.invoke(IpcChannel.SendMessage, sessionId, text),
  interruptSession: (sessionId) => ipcRenderer.invoke(IpcChannel.InterruptSession, sessionId),
  compactSession: (sessionId) => ipcRenderer.invoke(IpcChannel.CompactSession, sessionId),
  respondToPermission: (sessionId, requestId, behavior, scope) =>
    ipcRenderer.invoke(IpcChannel.RespondToPermission, sessionId, requestId, behavior, scope),
  updateSessionSettings: (sessionId, settings) =>
    ipcRenderer.invoke(IpcChannel.UpdateSessionSettings, sessionId, settings),
  answerQuestion: (sessionId, requestId, answers) =>
    ipcRenderer.invoke(IpcChannel.AnswerQuestion, sessionId, requestId, answers),
  deleteSession: (sessionId) => ipcRenderer.invoke(IpcChannel.DeleteSession, sessionId),
  openSessionIn: (sessionId, target) =>
    ipcRenderer.invoke(IpcChannel.OpenSessionIn, sessionId, target),
  onSessionEvent: (listener) => subscribe<SessionEventMessage>(IpcChannel.SessionEvent, listener),
  onSessionsChanged: (listener) =>
    subscribe<SessionSummary[]>(IpcChannel.SessionsChanged, listener),

  listProjects: () => ipcRenderer.invoke(IpcChannel.ListProjects),
  createProject: () => ipcRenderer.invoke(IpcChannel.CreateProject),
  renameProject: (projectId, name) => ipcRenderer.invoke(IpcChannel.RenameProject, projectId, name),
  removeProject: (projectId) => ipcRenderer.invoke(IpcChannel.RemoveProject, projectId),
  openProjectFolder: (projectId) => ipcRenderer.invoke(IpcChannel.OpenProjectFolder, projectId),
  onProjectsChanged: (listener) =>
    subscribe<ProjectSummary[]>(IpcChannel.ProjectsChanged, listener),
  getProjectContext: (projectId) => ipcRenderer.invoke(IpcChannel.GetProjectContext, projectId),
  saveProjectMemory: (projectId, text) =>
    ipcRenderer.invoke(IpcChannel.SaveProjectMemory, projectId, text),
  saveProjectInstructions: (projectId, text) =>
    ipcRenderer.invoke(IpcChannel.SaveProjectInstructions, projectId, text),
  linkProjectInstructions: (projectId, file) =>
    ipcRenderer.invoke(IpcChannel.LinkProjectInstructions, projectId, file),
  onProjectMemoryChanged: (listener) =>
    subscribe<string>(IpcChannel.ProjectMemoryChanged, listener),

  listModelEndpoints: () => ipcRenderer.invoke(IpcChannel.ListModelEndpoints),
  addModelEndpoint: (baseUrl, name, apiKey) =>
    ipcRenderer.invoke(IpcChannel.AddModelEndpoint, baseUrl, name, apiKey),
  removeModelEndpoint: (endpointId) =>
    ipcRenderer.invoke(IpcChannel.RemoveModelEndpoint, endpointId),
  discoverModelServers: () => ipcRenderer.invoke(IpcChannel.DiscoverModelServers),
  onDiscoveryProgress: (listener) =>
    subscribe<DiscoveryProgress>(IpcChannel.DiscoveryProgress, listener),

  getHub: () => ipcRenderer.invoke(IpcChannel.GetHub),
  onHubChanged: (listener) =>
    subscribe<Pick<HubState, 'tasks' | 'notes'>>(IpcChannel.HubChanged, listener),
  addHubTask: (task) => ipcRenderer.invoke(IpcChannel.AddHubTask, task),
  updateHubTask: (id, changes) => ipcRenderer.invoke(IpcChannel.UpdateHubTask, id, changes),
  deleteHubTask: (id) => ipcRenderer.invoke(IpcChannel.DeleteHubTask, id),
  saveHubNote: (note) => ipcRenderer.invoke(IpcChannel.SaveHubNote, note),
  deleteHubNote: (id) => ipcRenderer.invoke(IpcChannel.DeleteHubNote, id),
  setHubDefaultModel: (model) => ipcRenderer.invoke(IpcChannel.SetHubDefaultModel, model),
  registerHub: (target) => ipcRenderer.invoke(IpcChannel.RegisterHub, target),
  copyHubConfig: () => ipcRenderer.invoke(IpcChannel.CopyHubConfig),
  getPreferences: () => ipcRenderer.invoke(IpcChannel.GetPreferences),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannel.SetTheme, theme),
  removeTrustedFolder: (folder) => ipcRenderer.invoke(IpcChannel.RemoveTrustedFolder, folder),
  openDataFolder: () => ipcRenderer.invoke(IpcChannel.OpenDataFolder),
  regenerateHubToken: () => ipcRenderer.invoke(IpcChannel.RegenerateHubToken),
  listApiKeys: () => ipcRenderer.invoke(IpcChannel.ListApiKeys),
  setApiKey: (provider, key) => ipcRenderer.invoke(IpcChannel.SetApiKey, provider, key),
  deleteApiKey: (provider) => ipcRenderer.invoke(IpcChannel.DeleteApiKey, provider),
  listApiModels: (provider) => ipcRenderer.invoke(IpcChannel.ListApiModels, provider),
  listClaudeModels: () => ipcRenderer.invoke(IpcChannel.ListClaudeModels),
  getUsage: () => ipcRenderer.invoke(IpcChannel.GetUsage),
  setBudgets: (budgets) => ipcRenderer.invoke(IpcChannel.SetBudgets, budgets),
  onUsageChanged: (listener) => subscribe<UsageOverview>(IpcChannel.UsageChanged, listener),
};

contextBridge.exposeInMainWorld('powerchord', api);
