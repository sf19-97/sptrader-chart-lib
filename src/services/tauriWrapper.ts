import { mockInvoke, mockListen } from './mockTauriApi';

// Check if we're running in Tauri
const isTauri = () => {
  try {
    return window.__TAURI__ !== undefined;
  } catch {
    return false;
  }
};

// Create invoke and listen functions that use the appropriate implementation
export const invoke = async (cmd: string, args?: any): Promise<any> => {
  if (isTauri()) {
    // Dynamically import Tauri API only when needed
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  } else {
    return mockInvoke(cmd, args);
  }
};

export const listen = async <T = any>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> => {
  if (isTauri()) {
    // Dynamically import Tauri API only when needed
    const { listen: tauriListen } = await import('@tauri-apps/api/event');
    return tauriListen<T>(event, handler);
  } else {
    // Mock listen needs to match the Tauri event structure
    return mockListen(event, (payload: T) => handler({ payload }));
  }
};

// Log the environment
if (isTauri()) {
  console.log('[TauriWrapper] Running in Tauri environment');
} else {
  console.log('[TauriWrapper] Running in browser - using mock API');
}