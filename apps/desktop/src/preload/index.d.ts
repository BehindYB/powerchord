import type { PowerChordApi } from '../shared/ipc';

declare global {
  interface Window {
    powerchord: PowerChordApi;
  }
}
