import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { IpcChannel, type AppInfo } from '../shared/ipc';
import { registerAgentHandlers } from './agents';
import { registerModelHandlers } from './models';
import { SessionManager } from './sessions';

const APP_USER_MODEL_ID = 'io.github.behindyb.powerchord';
const TITLE_BAR_HEIGHT = 40;

const sessions = new SessionManager();

// Must match the `--pc-bg` token in the renderer stylesheet.
const BACKGROUND = { light: '#f7f7f8', dark: '#18181b' } as const;
const SYMBOL = { light: '#3f3f46', dark: '#d4d4d8' } as const;

function currentTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const theme = currentTheme();
  return { color: BACKGROUND[theme], symbolColor: SYMBOL[theme], height: TITLE_BAR_HEIGHT };
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function createMainWindow(): BrowserWindow {
  const usesOverlay = process.platform !== 'darwin';

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'PowerChord',
    backgroundColor: BACKGROUND[currentTheme()],
    titleBarStyle: 'hidden',
    ...(usesOverlay ? { titleBarOverlay: titleBarOverlay() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // External links open in the user's browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (usesOverlay) {
    const onThemeUpdated = (): void => window.setTitleBarOverlay(titleBarOverlay());
    nativeTheme.on('updated', onThemeUpdated);
    window.on('closed', () => nativeTheme.off('updated', onThemeUpdated));
  }

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.GetAppInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }));
  registerAgentHandlers();
  registerModelHandlers();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    registerIpcHandlers();
    await sessions.start();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // Agent processes must not outlive the app.
  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    void sessions.stop().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
