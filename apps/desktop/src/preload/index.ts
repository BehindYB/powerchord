import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type PowerChordApi } from '../shared/ipc';

const api: PowerChordApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.GetAppInfo),
};

contextBridge.exposeInMainWorld('powerchord', api);
