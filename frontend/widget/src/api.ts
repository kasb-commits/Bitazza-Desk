import type { CSBotConfig } from './types';

export function sendClientLog(apiUrl: string, entry: Record<string, unknown>) {
  fetch(`${apiUrl}/api/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'widget', entries: [entry] }),
  }).catch(() => {}); // fire-and-forget
}

function getHeaders(cfg: CSBotConfig): HeadersInit {
  const h: HeadersInit = { 'Content-Type': 'application/json' };
  if (cfg.token) h['Authorization'] = `Bearer ${cfg.token}`;
  return h;
}

// ── Bitazza Exchange bootstrap → session JWT ─────────────────────────────────
// Exchanges a single-use wstb_* bootstrap for our own session token. The
// downstream wstd_* token stays server-side; we only ever see this JWT.
export async function initWidgetSession(
  wstBootstrap: string,
  apiUrl: string,
): Promise<{ token: string; userId: string; tokenExpiresAt: number }> {
  const res = await fetch(`${apiUrl}/widget/session/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wst_bootstrap: wstBootstrap }),
  });
  if (!res.ok) throw new Error(`widget session init failed: ${res.status}`);
  const data = await res.json();
  return {
    token: data.token as string,
    userId: String(data.user_id),
    tokenExpiresAt: Date.now() + (data.expires_in as number) * 1000,
  };
}

// ── Proactive token refresh ──────────────────────────────────────────────────
// Checks if the token is within 60 s of expiry and refreshes it before the
// request fires.  Uses a singleton promise to dedup concurrent callers.
const TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh 60 s before expiry
let _refreshPromise: Promise<void> | null = null;

async function ensureFreshToken(cfg: CSBotConfig): Promise<void> {
  // Nothing to refresh — guest or no expiry info
  if (!cfg.onTokenRefresh || !cfg.tokenExpiresAt) return;
  // Token still has time
  if (Date.now() < cfg.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) return;

  // Already refreshing — wait for the in-flight refresh
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const newToken = await cfg.onTokenRefresh!();
      cfg.token = newToken;
      // Decode exp from JWT payload to update expiresAt
      try {
        const payload = JSON.parse(atob(newToken.split('.')[1]));
        if (payload.exp) cfg.tokenExpiresAt = payload.exp * 1000;
      } catch { /* non-standard JWT — keep old expiresAt, will refresh again next call */ }
    } catch (e) {
      // Refresh failed — proceed with the old (possibly expired) token.
      // The backend will treat it as guest; the next call will retry refresh.
      sendClientLog(cfg.apiUrl, { level: 'warn', event: 'token_refresh_failed', message: e instanceof Error ? e.message : String(e) });
    }
  })().finally(() => { _refreshPromise = null; });

  return _refreshPromise;
}

const SESSION_KEY = 'csbot_session';
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const CUSTOMER_KEY = 'csbot_customer_id'; // permanent — no TTL

export interface StoredAgent {
  name: string;
  avatar: string;
  avatarUrl: string | null;
}

export interface StoredSession {
  id: string;
  lang?: 'en' | 'th';
  category?: string;
  agent?: StoredAgent;
  isGuest?: boolean;
  botName?: string;
  botAvatarUrl?: string | null;
}

export function clearStoredSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function getStoredCustomerId(): string | null {
  try {
    return localStorage.getItem(CUSTOMER_KEY);
  } catch {
    return null;
  }
}

function storeCustomerId(id: string) {
  try {
    localStorage.setItem(CUSTOMER_KEY, id);
  } catch { /* storage unavailable */ }
}

export function getStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { id, ts, lang, category, agent, isGuest, botName, botAvatarUrl } = JSON.parse(raw);
    if (Date.now() - ts > SESSION_TTL_MS) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return { id, lang, category, agent, isGuest: !!isGuest, botName, botAvatarUrl } as StoredSession;
  } catch {
    return null;
  }
}

function storeSession(
  id: string,
  lang?: 'en' | 'th',
  category?: string,
  agent?: StoredAgent,
  isGuest?: boolean,
  botName?: string,
  botAvatarUrl?: string | null,
) {
  const existing = getStoredSession();
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    id,
    ts: Date.now(),
    lang: lang ?? existing?.lang,
    category: category ?? existing?.category,
    agent: agent ?? existing?.agent,
    isGuest: isGuest ?? existing?.isGuest ?? false,
    botName: botName ?? existing?.botName,
    botAvatarUrl: botAvatarUrl !== undefined ? botAvatarUrl : existing?.botAvatarUrl,
  }));
}

export function storeSessionLang(lang: 'en' | 'th') {
  const existing = getStoredSession();
  if (existing) storeSession(existing.id, lang, existing.category, existing.agent, existing.isGuest, existing.botName, existing.botAvatarUrl);
}

export function storeSessionCategory(category: string) {
  const existing = getStoredSession();
  if (existing) storeSession(existing.id, existing.lang, category, existing.agent, existing.isGuest, existing.botName, existing.botAvatarUrl);
}

export function storeSessionAgent(agent: StoredAgent) {
  const existing = getStoredSession();
  if (existing) storeSession(existing.id, existing.lang, existing.category, agent, existing.isGuest, existing.botName, existing.botAvatarUrl);
}

export function storeSessionBotInfo(botName: string, botAvatarUrl: string | null) {
  const existing = getStoredSession();
  if (existing) storeSession(existing.id, existing.lang, existing.category, existing.agent, existing.isGuest, botName, botAvatarUrl);
}

let _startPromise: Promise<string> | null = null;

async function _attemptStart(cfg: CSBotConfig, guestName?: string, guestEmail?: string): Promise<string> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/start`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({
      platform: cfg.platform,
      ...(guestName ? { guest_name: guestName } : {}),
      ...(guestEmail ? { guest_email: guestEmail } : {}),
    }),
  });
  if (!res.ok) {
    sendClientLog(cfg.apiUrl, { level: 'error', event: 'api_error', path: '/chat/start', status: res.status });
    throw new Error(`start failed: ${res.status}`);
  }
  const data = await res.json();
  const isGuest: boolean = data.is_guest ?? false;
  storeSession(data.conversation_id, undefined, undefined, undefined, isGuest);
  if (data.customer_id && !isGuest) storeCustomerId(data.customer_id);
  return data.conversation_id as string;
}

export async function startConversation(
  cfg: CSBotConfig,
  guestName?: string,
  guestEmail?: string,
): Promise<string> {
  const cached = getStoredSession();
  if (cached) return cached.id;

  // Deduplicate concurrent calls (e.g. React StrictMode double-mount)
  // so only one /chat/start request is ever in-flight at a time.
  if (_startPromise) return _startPromise;

  _startPromise = (async () => {
    try {
      return await _attemptStart(cfg, guestName, guestEmail);
    } catch {
      // One retry before giving up
      return await _attemptStart(cfg, guestName, guestEmail);
    }
  })().finally(() => { _startPromise = null; });
  return _startPromise;
}

export interface EmergencyEscalateResult {
  conversationId: string;
  ticketId: string;
}

export async function emergencyEscalate(
  cfg: CSBotConfig,
  errorSource: string,
  userMessage?: string,
): Promise<EmergencyEscalateResult> {
  const res = await fetch(`${cfg.apiUrl}/chat/emergency-escalate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error_source: errorSource,
      platform: cfg.platform ?? 'web',
      ...(userMessage ? { user_message: userMessage } : {}),
    }),
  });
  if (!res.ok) throw new Error(`emergency-escalate failed: ${res.status}`);
  const data = await res.json();
  return { conversationId: data.conversation_id, ticketId: data.ticket_id };
}

export interface SendResult {
  reply: string;
  language: 'en' | 'th';
  escalated: boolean;
  ticketId: string | null;
  agentName: string | null;
  agentAvatar: string | null;
  agentAvatarUrl: string | null;
  offerResolution: boolean;
  upgradedCategory: string | null;
  transitionMessage: string | null;
  quickReplies: string[];
}

export interface GreetResult {
  greeting: string;
  botName: string;
  botAvatarUrl: string | null;
}

export interface SetCategoryResult {
  agentName: string;
  agentAvatar: string;
  agentAvatarUrl: string;
}

export async function setCategoryAgent(
  cfg: CSBotConfig,
  conversationId: string,
  category: string,
): Promise<SetCategoryResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/set-category`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({ conversation_id: conversationId, category }),
  });
  if (!res.ok) throw new Error(`set-category failed: ${res.status}`);
  const data = await res.json();
  return {
    agentName: data.agent_name,
    agentAvatar: data.agent_avatar,
    agentAvatarUrl: data.agent_avatar_url,
  };
}

export async function greetConversation(cfg: CSBotConfig, conversationId: string, language: 'en' | 'th'): Promise<GreetResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/greet`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({ conversation_id: conversationId, language }),
  });
  if (!res.ok) throw new Error(`greet failed: ${res.status}`);
  const data = await res.json();
  return { greeting: data.greeting as string, botName: data.bot_name as string, botAvatarUrl: data.agent_avatar_url ?? null };
}

export interface HistoryResult {
  messages: { role: string; content: string; created_at: number; agent_name?: string; agent_avatar?: string; agent_avatar_url?: string; attachments?: { id: string; url: string; name: string; mime_type: string; size: number }[] }[];
  humanHandling: boolean;
  ticketStatus: string | null;
}

export async function fetchHistory(cfg: CSBotConfig, conversationId: string): Promise<HistoryResult> {
  const res = await fetch(`${cfg.apiUrl}/chat/history/${conversationId}`, {
    headers: getHeaders(cfg),
  });
  if (!res.ok) return { messages: [], humanHandling: false, ticketStatus: null };
  const data = await res.json();
  return { messages: data.history ?? [], humanHandling: data.human_handling ?? false, ticketStatus: data.ticket_status ?? null };
}

export interface PastTicket {
  id: string;
  category: string;
  status: string;
  created_at: number;
  last_message: string | null;
  last_message_at: number | null;
}

export async function fetchCustomerTickets(cfg: CSBotConfig, page = 1, limit = 10): Promise<PastTicket[]> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/customer-tickets?page=${page}&limit=${limit}`, {
      headers: getHeaders(cfg),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.tickets ?? [];
  } catch {
    return [];
  }
}

export async function fetchOpenTicket(cfg: CSBotConfig): Promise<PastTicket | null> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/open-ticket`, {
      headers: getHeaders(cfg),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ticket ?? null;
  } catch {
    return null;
  }
}

export async function fetchPaginatedHistory(
  cfg: CSBotConfig,
  conversationId: string,
  page: number,
  limit = 10,
): Promise<HistoryResult> {
  try {
    const res = await fetch(
      `${cfg.apiUrl}/chat/history/${conversationId}?page=${page}&limit=${limit}`,
      { headers: getHeaders(cfg) },
    );
    if (!res.ok) return { messages: [], humanHandling: false, ticketStatus: null };
    const data = await res.json();
    return { messages: data.history ?? [], humanHandling: data.human_handling ?? false, ticketStatus: data.ticket_status ?? null };
  } catch {
    return { messages: [], humanHandling: false, ticketStatus: null };
  }
}

export interface Announcement {
  id: string;
  title_en: string;
  body_en: string;
  title_th: string;
  body_th: string;
  color: string | null;
}

export async function fetchAnnouncements(cfg: CSBotConfig): Promise<Announcement[]> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/announcement`, { headers: getHeaders(cfg) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.announcements ?? [];
  } catch {
    return [];
  }
}

export async function uploadAttachment(
  cfg: CSBotConfig,
  file: File,
): Promise<{ id: string; url: string; name: string; mimeType: string; size: number }> {
  await ensureFreshToken(cfg);
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {};
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.apiUrl}/api/uploads/attachment`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res.ok) {
    sendClientLog(cfg.apiUrl, { level: 'error', event: 'api_error', path: '/api/uploads/attachment', status: res.status });
    throw new Error(`upload failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    url: data.url,
    name: data.name,
    mimeType: data.mime_type,
    size: data.size,
  };
}

export async function sendMessage(
  cfg: CSBotConfig,
  conversationId: string,
  message: string,
  consecutiveLowConfidence = 0,
  category?: string,
  attachmentIds?: string[],
  language?: 'en' | 'th',
): Promise<SendResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/message`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({
      conversation_id: conversationId,
      message,
      consecutive_low_confidence: consecutiveLowConfidence,
      ...(language ? { language } : {}),
      ...(category ? { category } : {}),
      ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
    }),
  });
  if (!res.ok) {
    sendClientLog(cfg.apiUrl, { level: 'error', event: 'api_error', path: '/chat/message', status: res.status, conv_id: conversationId });
    throw new Error(`message failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    reply: data.reply,
    language: data.language,
    escalated: data.escalated,
    ticketId: data.ticket_id ?? null,
    agentName: data.agent_name ?? null,
    agentAvatar: data.agent_avatar ?? null,
    agentAvatarUrl: data.agent_avatar_url ?? null,
    offerResolution: data.offer_resolution ?? false,
    upgradedCategory: data.upgraded_category ?? null,
    transitionMessage: data.transition_message ?? null,
    quickReplies: Array.isArray(data.quick_replies) ? data.quick_replies : [],
  };
}
