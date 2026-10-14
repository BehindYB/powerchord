import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { IpcChannel, type Preferences } from '../shared/ipc';
import type { HubManager } from './hub';
import {
  getTheme,
  getTrustedFolders,
  setTheme,
  untrustFolder,
  type ThemePreference,
} from './settings';

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Applies the saved theme; call before creating windows. */
export async function applySavedTheme(): Promise<void> {
  nativeTheme.themeSource = await getTheme();
}

async function preferences(): Promise<Preferences> {
  return {
    theme: await getTheme(),
    trustedFolders: await getTrustedFolders(),
    dataFolder: app.getPath('userData'),
  };
}

export function registerPreferenceHandlers(hub: HubManager): void {
  ipcMain.handle(IpcChannel.GetPreferences, () => preferences());
  ipcMain.handle(IpcChannel.SetTheme, async (_event, theme: unknown) => {
    if (!isTheme(theme)) throw new Error('Invalid theme');
    await setTheme(theme);
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle(IpcChannel.RemoveTrustedFolder, async (_event, folder: unknown) => {
    if (typeof folder !== 'string') throw new Error('Invalid folder');
    await untrustFolder(folder);
  });
  ipcMain.handle(IpcChannel.OpenDataFolder, async () => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error(error);
  });
  ipcMain.handle(IpcChannel.RegenerateHubToken, async (event): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const confirmation: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Replace token', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Replace hub token',
      message: 'Replace the token that agents use to reach the hub?',
      detail:
        'Agents you added the hub to stop reaching it until you add it to them again. ' +
        'Sessions started in PowerChord are not affected.',
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirmation)
      : await dialog.showMessageBox(confirmation);
    if (response !== 0) return false;
    await hub.regenerateToken();
    return true;
  });
}
