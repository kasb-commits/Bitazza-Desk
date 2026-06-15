import { makeAsyncStorageAdapter } from '@bitazza/csbot-core';
import type { StorageAdapter } from '@bitazza/csbot-core';

// Lazy singleton — created once when first accessed.
// Import AsyncStorage at the call site to avoid bundling it at module load time.
let _adapter: StorageAdapter | null = null;

export function getAsyncStorageAdapter(): StorageAdapter {
  if (_adapter) return _adapter;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  _adapter = makeAsyncStorageAdapter(AsyncStorage);
  return _adapter;
}

export { makeAsyncStorageAdapter };
