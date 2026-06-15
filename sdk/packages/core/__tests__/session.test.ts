import {
  getStoredSession, storeSession, clearStoredSession,
  getStoredCustomerId, storeCustomerId,
  storeSessionLang, storeSessionCategory, storeSessionAgent, storeSessionBotInfo,
} from '../src/session';
import { localStorageAdapter } from '../src/storage';

const adapter = localStorageAdapter;

beforeEach(() => localStorage.clear());

describe('storeSession / getStoredSession', () => {
  test('round-trip basic session', async () => {
    await storeSession(adapter, 'conv-1', { isGuest: false });
    const s = await getStoredSession(adapter);
    expect(s?.id).toBe('conv-1');
    expect(s?.isGuest).toBe(false);
  });

  test('returns null for expired session', async () => {
    await storeSession(adapter, 'conv-2');
    // Manually patch timestamp to be ancient
    const raw = JSON.parse(localStorage.getItem('csbot_session')!);
    raw.ts = Date.now() - 4 * 60 * 60 * 1000; // 4 hours ago
    localStorage.setItem('csbot_session', JSON.stringify(raw));
    const s = await getStoredSession(adapter, 3 * 60 * 60 * 1000);
    expect(s).toBeNull();
  });

  test('returns null when nothing stored', async () => {
    expect(await getStoredSession(adapter)).toBeNull();
  });

  test('merges fields on subsequent storeSession calls', async () => {
    await storeSession(adapter, 'conv-3', { lang: 'th' });
    await storeSession(adapter, 'conv-3', { isGuest: true });
    const s = await getStoredSession(adapter);
    expect(s?.lang).toBe('th');
    expect(s?.isGuest).toBe(true);
  });
});

describe('clearStoredSession', () => {
  test('removes stored session', async () => {
    await storeSession(adapter, 'conv-x');
    await clearStoredSession(adapter);
    expect(await getStoredSession(adapter)).toBeNull();
  });
});

describe('storeCustomerId / getStoredCustomerId', () => {
  test('round-trip', async () => {
    await storeCustomerId(adapter, 'cust-42');
    expect(await getStoredCustomerId(adapter)).toBe('cust-42');
  });
});

describe('storeSessionLang', () => {
  test('updates lang without losing other fields', async () => {
    await storeSession(adapter, 'conv-4', { isGuest: true });
    await storeSessionLang(adapter, 'th');
    const s = await getStoredSession(adapter);
    expect(s?.lang).toBe('th');
    expect(s?.isGuest).toBe(true);
  });

  test('no-op when no session exists', async () => {
    await expect(storeSessionLang(adapter, 'en')).resolves.not.toThrow();
  });
});

describe('storeSessionCategory', () => {
  test('updates category', async () => {
    await storeSession(adapter, 'conv-5', { lang: 'en' });
    await storeSessionCategory(adapter, 'kyc_verification');
    const s = await getStoredSession(adapter);
    expect(s?.category).toBe('kyc_verification');
    expect(s?.lang).toBe('en');
  });
});

describe('storeSessionAgent', () => {
  test('stores agent identity', async () => {
    await storeSession(adapter, 'conv-6');
    await storeSessionAgent(adapter, { name: 'Aria', avatar: 'A', avatarUrl: null });
    const s = await getStoredSession(adapter);
    expect(s?.agent?.name).toBe('Aria');
  });
});

describe('storeSessionBotInfo', () => {
  test('stores bot name and avatarUrl', async () => {
    await storeSession(adapter, 'conv-7');
    await storeSessionBotInfo(adapter, 'PloyBot', 'https://example.com/bot.png');
    const s = await getStoredSession(adapter);
    expect(s?.botName).toBe('PloyBot');
    expect(s?.botAvatarUrl).toBe('https://example.com/bot.png');
  });
});
