import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel, type InstallOutputEvent, type PowerChordApi } from '../shared/ipc';

const api: PowerChordApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.GetAppInfo),
  listAgents: () => ipcRenderer.invoke(IpcChannel.ListAgents),
  installAgent: (agentId, methodId) =>
    ipcRenderer.invoke(IpcChannel.InstallAgent, agentId, methodId),
  onInstallOutput: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: InstallOutputEvent): void =>
      listener(payload);
    ipcRenderer.on(IpcChannel.InstallOutput, handler);
    return () => ipcRenderer.off(IpcChannel.InstallOutput, handler);
  },
  openAgentSignIn: (agentId) => ipcRenderer.invoke(IpcChannel.OpenAgentSignIn, agentId),
};

contextBridge.exposeInMainWorld('powerchord', api);
