import type { StorageAdapter } from './storage';
import type { SupportedLanguage } from './types';

const SESSION_KEY = 'csbot_session';
const CUSTOMER_KEY = 'csbot_customer_id';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

export interface StoredAgent {
  name: string;
  avatar: string;
  avatarUrl: string | null;
}

export interface StoredSession {
  id: string;
  lang?: SupportedLanguage;
  category?: string;
  agent?: StoredAgent;
  isGuest?: boolean;
  botName?: string;
  botAvatarUrl?: string | null;
}

export async function clearStoredSession(adapter: StorageAdapter): Promise<void> {
  await adapter.removeItem(SESSION_KEY);
}

export async function getStoredCustomerId(adapter: StorageAdapter): Promise<string | null> {
  try {
    return await adapter.getItem(CUSTOMER_KEY);
  } catch {
    return null;
  }
}

export async function storeCustomerId(adapter: StorageAdapter, id: string): Promise<void> {
  try {
    await adapter.setItem(CUSTOMER_KEY, id);
  } catch { /* storage unavailable */ }
}

export async function getStoredSession(
  adapter: StorageAdapter,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<StoredSession | null> {
  try {
    const raw = await adapter.getItem(SESSION_KEY);
    if (!raw) return null;
    const { id, ts, lang, category, agent, isGuest, botName, botAvatarUrl } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) {
      await adapter.removeItem(SESSION_KEY);
      return null;
    }
    return { id, lang, category, agent, isGuest: !!isGuest, botName, botAvatarUrl };
  } catch {
    return null;
  }
}

export async function storeSession(
  adapter: StorageAdapter,
  id: string,
  fields: Partial<Omit<StoredSession, 'id'>> = {},
): Promise<void> {
  const existing = await getStoredSession(adapter);
  await adapter.setItem(SESSION_KEY, JSON.stringify({
    id,
    ts: Date.now(),
    lang: fields.lang ?? existing?.lang,
    category: fields.category ?? existing?.category,
    agent: fields.agent ?? existing?.agent,
    isGuest: fields.isGuest ?? existing?.isGuest ?? false,
    botName: fields.botName ?? existing?.botName,
    botAvatarUrl: fields.botAvatarUrl !== undefined ? fields.botAvatarUrl : existing?.botAvatarUrl,
  }));
}

export async function storeSessionLang(adapter: StorageAdapter, lang: SupportedLanguage): Promise<void> {
  const existing = await getStoredSession(adapter);
  if (existing) await storeSession(adapter, existing.id, { ...existing, lang });
}

export async function storeSessionCategory(adapter: StorageAdapter, category: string): Promise<void> {
  const existing = await getStoredSession(adapter);
  if (existing) await storeSession(adapter, existing.id, { ...existing, category });
}

export async function storeSessionAgent(adapter: StorageAdapter, agent: StoredAgent): Promise<void> {
  const existing = await getStoredSession(adapter);
  if (existing) await storeSession(adapter, existing.id, { ...existing, agent });
}

export async function storeSessionBotInfo(
  adapter: StorageAdapter,
  botName: string,
  botAvatarUrl: string | null,
): Promise<void> {
  const existing = await getStoredSession(adapter);
  if (existing) await storeSession(adapter, existing.id, { ...existing, botName, botAvatarUrl });
}
