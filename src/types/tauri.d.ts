// Tauri window type declaration
declare global {
  interface Window {
    __TAURI__?: any;
  }
}

export {};