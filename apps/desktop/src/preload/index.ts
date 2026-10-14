import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannel,
  type DiscoveryProgress,
  type InstallOutputEvent,
  type PowerChordApi,
  type SessionEventMessage,
  type SessionSummary,
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
  createSession: (request) => ipcRenderer.invoke(IpcChannel.CreateSession, request),
  getSession: (sessionId) => ipcRenderer.invoke(IpcChannel.GetSession, sessionId),
  sendMessage: (sessionId, text) => ipcRenderer.invoke(IpcChannel.SendMessage, sessionId, text),
  interruptSession: (sessionId) => ipcRenderer.invoke(IpcChannel.InterruptSession, sessionId),
  respondToPermission: (sessionId, requestId, behavior, scope) =>
    ipcRenderer.invoke(IpcChannel.RespondToPermission, sessionId, requestId, behavior, scope),
  updateSessionSettings: (sessionId, settings) =>
    ipcRenderer.invoke(IpcChannel.UpdateSessionSettings, sessionId, settings),
  closeSession: (sessionId) => ipcRenderer.invoke(IpcChannel.CloseSession, sessionId),
  openSessionIn: (sessionId, target) =>
    ipcRenderer.invoke(IpcChannel.OpenSessionIn, sessionId, target),
  onSessionEvent: (listener) => subscribe<SessionEventMessage>(IpcChannel.SessionEvent, listener),
  onSessionsChanged: (listener) =>
    subscribe<SessionSummary[]>(IpcChannel.SessionsChanged, listener),

  listModelEndpoints: () => ipcRenderer.invoke(IpcChannel.ListModelEndpoints),
  addModelEndpoint: (baseUrl, name) =>
    ipcRenderer.invoke(IpcChannel.AddModelEndpoint, baseUrl, name),
  removeModelEndpoint: (endpointId) =>
    ipcRenderer.invoke(IpcChannel.RemoveModelEndpoint, endpointId),
  discoverModelServers: () => ipcRenderer.invoke(IpcChannel.DiscoverModelServers),
  onDiscoveryProgress: (listener) =>
    subscribe<DiscoveryProgress>(IpcChannel.DiscoveryProgress, listener),
};

contextBridge.exposeInMainWorld('powerchord', api);
