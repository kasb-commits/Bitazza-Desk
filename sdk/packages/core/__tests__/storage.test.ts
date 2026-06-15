import { localStorageAdapter, makeAsyncStorageAdapter } from '../src/storage';

describe('localStorageAdapter', () => {
  beforeEach(() => localStorage.clear());

  test('setItem / getItem round-trip', async () => {
    await localStorageAdapter.setItem('key1', 'value1');
    expect(await localStorageAdapter.getItem('key1')).toBe('value1');
  });

  test('getItem returns null for missing key', async () => {
    expect(await localStorageAdapter.getItem('missing')).toBeNull();
  });

  test('removeItem deletes the key', async () => {
    await localStorageAdapter.setItem('del', 'x');
    await localStorageAdapter.removeItem('del');
    expect(await localStorageAdapter.getItem('del')).toBeNull();
  });
});

describe('makeAsyncStorageAdapter', () => {
  const store: Record<string, string> = {};
  const mockAsync = {
    getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
    setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
    removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
  };
  const adapter = makeAsyncStorageAdapter(mockAsync);

  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(store).forEach((k) => delete store[k]);
  });

  test('delegates setItem', async () => {
    await adapter.setItem('a', 'b');
    expect(mockAsync.setItem).toHaveBeenCalledWith('a', 'b');
  });

  test('delegates getItem', async () => {
    store['a'] = 'b';
    expect(await adapter.getItem('a')).toBe('b');
  });

  test('delegates removeItem', async () => {
    store['x'] = 'y';
    await adapter.removeItem('x');
    expect(store['x']).toBeUndefined();
  });
});
