// ─── StorageAdapter interface ─────────────────────────────────────────────────
// Abstracts localStorage (web) and AsyncStorage (React Native) behind a
// single async interface so all session logic is platform-agnostic.

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ─── Web adapter ─────────────────────────────────────────────────────────────

export const localStorageAdapter: StorageAdapter = {
  getItem: (key) => Promise.resolve(localStorage.getItem(key)),
  setItem: (key, value) => { localStorage.setItem(key, value); return Promise.resolve(); },
  removeItem: (key) => { localStorage.removeItem(key); return Promise.resolve(); },
};

// ─── React Native adapter ─────────────────────────────────────────────────────
// Import AsyncStorage from the host app's node_modules — we don't bundle it.

export function makeAsyncStorageAdapter(
  AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  },
): StorageAdapter {
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
