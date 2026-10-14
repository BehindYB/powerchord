/**
 * Contract between the main process and the renderer.
 * Channel names and payload types live here so both sides stay in sync.
 */

export const IpcChannel = {
  GetAppInfo: 'app:get-info',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

/** API exposed to the renderer as `window.powerchord` by the preload script. */
export interface PowerChordApi {
  getAppInfo(): Promise<AppInfo>;
}
