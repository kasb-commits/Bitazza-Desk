import type { CSBotSDKConfig, IssueCategory, PastTicket, Announcement, AttachmentMeta } from './types';
import type { StorageAdapter } from './storage';
import { getStoredSession, storeSession, storeCustomerId } from './session';

// ─── Internals ────────────────────────────────────────────────────────────────

function getHeaders(cfg: CSBotSDKConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) h['Authorization'] = `Bearer ${cfg.token}`;
  return h;
}

export function sendClientLog(apiUrl: string, entry: Record<string, unknown>): void {
  fetch(`${apiUrl}/api/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'sdk', entries: [entry] }),
  }).catch(() => {});
}

const TOKEN_REFRESH_BUFFER_MS = 60_000;
let _refreshPromise: Promise<void> | null = null;

async function ensureFreshToken(cfg: CSBotSDKConfig): Promise<void> {
  if (!cfg.onTokenRefresh || !cfg.tokenExpiresAt) return;
  if (Date.now() < cfg.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) return;
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const newToken = await cfg.onTokenRefresh!();
      cfg.token = newToken;
      try {
        const payload = JSON.parse(atob(newToken.split('.')[1]));
        if (payload.exp) cfg.tokenExpiresAt = payload.exp * 1000;
      } catch { /* non-standard JWT */ }
    } catch (e) {
      sendClientLog(cfg.apiUrl, { level: 'warn', event: 'token_refresh_failed', message: e instanceof Error ? e.message : String(e) });
    }
  })().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// ─── Bitazza Exchange bootstrap → session JWT ──────────────────────────────────
// Exchanges a single-use wstb_* bootstrap for our own session token and stores it
// on the config. Guarded by a singleton promise so the single-use bootstrap is
// consumed exactly once even under StrictMode double-invoke / re-render. No-op if
// a token is already present or no bootstrap was supplied. Throws on failure so
// the caller can surface a clear error (the bootstrap is spent and can't be retried).
let _bootstrapPromise: Promise<void> | null = null;

export async function exchangeBootstrapToken(cfg: CSBotSDKConfig): Promise<void> {
  if (cfg.token || !cfg.wstBootstrap) return;
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    const res = await fetch(`${cfg.apiUrl}/widget/session/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wst_bootstrap: cfg.wstBootstrap }),
    });
    if (!res.ok) {
      sendClientLog(cfg.apiUrl, { level: 'error', event: 'bootstrap_exchange_failed', status: res.status });
      throw new Error(`bootstrap exchange failed: ${res.status}`);
    }
    const data = await res.json();
    cfg.token = data.token;
    cfg.tokenExpiresAt = Date.now() + (data.expires_in as number) * 1000;
  })().finally(() => { _bootstrapPromise = null; });
  return _bootstrapPromise;
}

// ─── Start / session ─────────────────────────────────────────────────────────

let _startPromise: Promise<string> | null = null;

async function _attemptStart(
  cfg: CSBotSDKConfig,
  adapter: StorageAdapter,
  guestName?: string,
  guestEmail?: string,
): Promise<string> {
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
  await storeSession(adapter, data.conversation_id, { isGuest });
  if (data.customer_id && !isGuest) await storeCustomerId(adapter, data.customer_id);
  return data.conversation_id as string;
}

export async function startConversation(
  cfg: CSBotSDKConfig,
  adapter: StorageAdapter,
  opts?: { guestName?: string; guestEmail?: string },
): Promise<string> {
  const cached = await getStoredSession(adapter, cfg.sessionTtlMs);
  if (cached) return cached.id;
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    try {
      return await _attemptStart(cfg, adapter, opts?.guestName, opts?.guestEmail);
    } catch {
      return await _attemptStart(cfg, adapter, opts?.guestName, opts?.guestEmail);
    }
  })().finally(() => { _startPromise = null; });
  return _startPromise;
}

// ─── Greet ───────────────────────────────────────────────────────────────────

export interface GreetResult {
  greeting: string;
  botName: string;
  botAvatarUrl: string | null;
}

export async function greetConversation(
  cfg: CSBotSDKConfig,
  conversationId: string,
  language: string,
): Promise<GreetResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/greet`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({ conversation_id: conversationId, language }),
  });
  if (!res.ok) throw new Error(`greet failed: ${res.status}`);
  const data = await res.json();
  return { greeting: data.greeting, botName: data.bot_name, botAvatarUrl: data.agent_avatar_url ?? null };
}

// ─── Set category ─────────────────────────────────────────────────────────────

export interface SetCategoryResult {
  agentName: string;
  agentAvatar: string;
  agentAvatarUrl: string | null;
}

export async function setCategoryAgent(
  cfg: CSBotSDKConfig,
  conversationId: string,
  category: IssueCategory,
): Promise<SetCategoryResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/set-category`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({ conversation_id: conversationId, category }),
  });
  if (!res.ok) throw new Error(`set-category failed: ${res.status}`);
  const data = await res.json();
  return { agentName: data.agent_name, agentAvatar: data.agent_avatar, agentAvatarUrl: data.agent_avatar_url ?? null };
}

// ─── Send message ─────────────────────────────────────────────────────────────

export interface SendResult {
  reply: string | null;
  language: string;
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

export async function sendMessage(
  cfg: CSBotSDKConfig,
  conversationId: string,
  message: string,
  consecutiveLowConfidence = 0,
  category?: string,
  attachmentIds?: string[],
): Promise<SendResult> {
  await ensureFreshToken(cfg);
  const res = await fetch(`${cfg.apiUrl}/chat/message`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({
      conversation_id: conversationId,
      message,
      consecutive_low_confidence: consecutiveLowConfidence,
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
    reply: data.reply ?? null,
    language: data.language,
    escalated: data.escalated ?? false,
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

// ─── History ──────────────────────────────────────────────────────────────────

export interface HistoryMessage {
  role: string;
  content: string;
  created_at: number;
  agent_name?: string;
  agent_avatar?: string;
  agent_avatar_url?: string;
  attachments?: { id: string; url: string; name: string; mime_type: string; size: number }[];
}

export interface HistoryResult {
  messages: HistoryMessage[];
  humanHandling: boolean;
  ticketStatus: string | null;
}

export async function fetchHistory(cfg: CSBotSDKConfig, conversationId: string): Promise<HistoryResult> {
  const res = await fetch(`${cfg.apiUrl}/chat/history/${conversationId}`, { headers: getHeaders(cfg) });
  if (!res.ok) return { messages: [], humanHandling: false, ticketStatus: null };
  const data = await res.json();
  return { messages: data.history ?? [], humanHandling: data.human_handling ?? false, ticketStatus: data.ticket_status ?? null };
}

export async function fetchPaginatedHistory(
  cfg: CSBotSDKConfig,
  conversationId: string,
  page: number,
  limit = 10,
): Promise<HistoryResult> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/history/${conversationId}?page=${page}&limit=${limit}`, { headers: getHeaders(cfg) });
    if (!res.ok) return { messages: [], humanHandling: false, ticketStatus: null };
    const data = await res.json();
    return { messages: data.history ?? [], humanHandling: data.human_handling ?? false, ticketStatus: data.ticket_status ?? null };
  } catch {
    return { messages: [], humanHandling: false, ticketStatus: null };
  }
}

// ─── Customer tickets ─────────────────────────────────────────────────────────

export async function fetchCustomerTickets(cfg: CSBotSDKConfig, page = 1, limit = 10): Promise<PastTicket[]> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/customer-tickets?page=${page}&limit=${limit}`, { headers: getHeaders(cfg) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.tickets ?? []).map((t: Record<string, unknown>) => ({
      id: t.id,
      category: t.category,
      status: t.status,
      createdAt: t.created_at,
      lastMessage: t.last_message ?? null,
      lastMessageAt: t.last_message_at ?? null,
    }));
  } catch {
    return [];
  }
}

export async function fetchOpenTicket(cfg: CSBotSDKConfig): Promise<PastTicket | null> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/open-ticket`, { headers: getHeaders(cfg) });
    if (!res.ok) return null;
    const data = await res.json();
    const t = data.ticket;
    if (!t) return null;
    return { id: t.id, category: t.category, status: t.status, createdAt: t.created_at, lastMessage: t.last_message ?? null, lastMessageAt: t.last_message_at ?? null };
  } catch {
    return null;
  }
}

// ─── CSAT ─────────────────────────────────────────────────────────────────────

export async function submitCsat(cfg: CSBotSDKConfig, ticketId: string, score: 1 | 2 | 3 | 4 | 5): Promise<void> {
  await fetch(`${cfg.apiUrl}/chat/csat`, {
    method: 'POST',
    headers: getHeaders(cfg),
    body: JSON.stringify({ ticket_id: ticketId, score }),
  });
}

// ─── Announcements ────────────────────────────────────────────────────────────

export async function fetchAnnouncements(cfg: CSBotSDKConfig): Promise<Announcement[]> {
  try {
    const res = await fetch(`${cfg.apiUrl}/chat/announcement`, { headers: getHeaders(cfg) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.announcements ?? []).map((a: Record<string, unknown>) => ({
      id: a.id,
      titleEn: a.title_en,
      bodyEn: a.body_en,
      titleTh: a.title_th,
      bodyTh: a.body_th,
      color: a.color ?? null,
    }));
  } catch {
    return [];
  }
}

// ─── Emergency escalate ───────────────────────────────────────────────────────

export interface EmergencyEscalateResult {
  conversationId: string;
  ticketId: string;
}

export async function emergencyEscalate(
  cfg: CSBotSDKConfig,
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

// ─── Attachments ──────────────────────────────────────────────────────────────

export async function uploadAttachment(
  cfg: CSBotSDKConfig,
  file: File | { uri: string; name: string; type: string },
): Promise<AttachmentMeta> {
  await ensureFreshToken(cfg);
  const form = new FormData();
  // Both web File and RN document-picker objects work with FormData
  form.append('file', file as Blob);
  const headers: Record<string, string> = {};
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.apiUrl}/api/uploads/attachment`, { method: 'POST', headers, body: form });
  if (!res.ok) {
    sendClientLog(cfg.apiUrl, { level: 'error', event: 'api_error', path: '/api/uploads/attachment', status: res.status });
    throw new Error(`upload failed: ${res.status}`);
  }
  const data = await res.json();
  return { id: data.id, url: data.url, name: data.name, mimeType: data.mime_type, size: data.size };
}
