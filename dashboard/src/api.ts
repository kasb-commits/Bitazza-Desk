import { io, type Socket } from 'socket.io-client';
import type {
  Ticket, TicketDetail, TicketStatus, Priority, Agent, AgentRole,
  AgentStatus, InboxView, StatusFilter, SupervisorStats, QueueItem, SLARiskTicket,
  ChannelHealth, PendingStale,
  AnalyticsFilters, RelatedTicket, KnowledgeItem, NotificationChannelConfig,
  Notification,
} from './types';

// ── Base URL ──────────────────────────────────────────────────────────────────
// VITE_API_URL overrides — default to Node backend on :3002
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

// ── Token helpers (reads from localStorage, set by LoginPage) ────────────────
function getToken(): string | null {
  try {
    const raw = localStorage.getItem('auth_user');
    if (!raw) return null;
    return (JSON.parse(raw) as { token: string }).token ?? null;
  } catch {
    return null;
  }
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────
async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `${API}${path}`;
  console.debug('[api] %s %s', options.method ?? 'GET', url);
  const r = await fetch(url, { ...options, headers });
  console.debug('[api] %s %s → %d', options.method ?? 'GET', url, r.status);

  if (r.status === 401) {
    // Token expired — clear session; let React Router handle the redirect
    localStorage.removeItem('auth_user');
    window.dispatchEvent(new Event('auth:expired'));
    throw new Error('Session expired');
  }

  if (!r.ok) {
    let msg = `${r.status} ${path}`;
    try { const body = await r.json(); msg = body.error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }

  // 204 No Content
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

// ── API surface ───────────────────────────────────────────────────────────────
export const api = {

  // Auth
  login: (email: string, password: string) =>
    req<{ token: string; user: { id: string; name: string; role: string; team: string } }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    ),

  me: () =>
    req<{ id: string; name: string; email: string; avatar_url?: string; role: string; team: string; permissions: string[] }>(
      '/api/auth/me'
    ),

  // Tickets
  getTickets: (view: InboxView = 'all_open', search = '', statusFilter: StatusFilter = 'all') =>
    req<Ticket[]>(`/api/tickets?view=${view}&search=${encodeURIComponent(search)}&status_filter=${statusFilter}`),

  getTicketStats: () =>
    req<{ open: number; active: number; escalated: number; pending: number; resolved: number; closed: number }>('/api/tickets/stats'),

  getTicket: (id: string) =>
    req<TicketDetail>(`/api/tickets/${id}`),

  createTicket: (data: { customer_id: string; channel: string; category?: string; priority?: Priority }) =>
    req<{ id: string }>('/api/tickets', { method: 'POST', body: JSON.stringify(data) }),

  setStatus: (id: string, status: TicketStatus) =>
    req(`/api/tickets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  setPriority: (id: string, priority: Priority) =>
    req(`/api/tickets/${id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority }) }),

  assign: (id: string, assigned_to: string | null, team?: string, handoff_note?: string) =>
    req(`/api/tickets/${id}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ assigned_to, team, handoff_note }),
    }),

  setTags: (id: string, tags: string[]) =>
    req(`/api/tickets/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) }),

  escalate: (id: string, reason?: string) =>
    req(`/api/tickets/${id}/escalate`, { method: 'POST', body: JSON.stringify({ reason }) }),

  reply: (id: string, content: string, is_note = false, channel?: string) =>
    req(`/api/tickets/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, is_note, channel }),
    }),

  claimTicket: (id: string) =>
    req(`/api/tickets/${id}/claim`, { method: 'POST' }),

  requestResolution: (id: string) =>
    req(`/api/tickets/${id}/resolve-request`, { method: 'POST' }),

  // Agents
  getAgents: (includeInactive = false) =>
    req<Agent[]>(`/api/agents${includeInactive ? '?include_inactive=true' : ''}`),

  createAgent: (data: {
    name: string; email: string; password: string; role: string;
    team?: string; max_chats?: number; skills?: string[]; shift?: string;
  }) => req<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(data) }),

  updateAgent: (id: string, data: {
    name?: string; role?: string; team?: string;
    max_chats?: number; skills?: string[]; shift?: string;
  }) => req<Agent>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deactivateAgent: (id: string) =>
    req(`/api/agents/${id}`, { method: 'DELETE' }),

  reactivateAgent: (id: string) =>
    req(`/api/agents/${id}/reactivate`, { method: 'POST' }),

  resetAgentPassword: (id: string, password: string) =>
    req(`/api/agents/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),

  uploadAvatar: (id: string, file: File) => {
    const token = getToken();
    const form = new FormData();
    form.append('avatar', file);
    return fetch(`${API}/api/agents/${id}/avatar`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }).then(async r => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error((b as {error?:string}).error ?? `${r.status}`); }
      return r.json() as Promise<{ avatar_url: string }>;
    });
  },

  setMyStatus: (state: AgentStatus) =>
    req('/api/agents/me/status', { method: 'PATCH', body: JSON.stringify({ state }) }),

  // Roles
  getRoles: () => req<{ roles: AgentRole[]; all_permissions: string[] }>('/api/roles'),

  createRole: (data: { name: string; display_name?: string; permissions?: string[] }) =>
    req<AgentRole>('/api/roles', { method: 'POST', body: JSON.stringify(data) }),

  updateRole: (name: string, data: { name?: string; display_name?: string; permissions?: string[] }) =>
    req<AgentRole>(`/api/roles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteRole: (name: string) =>
    req(`/api/roles/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Assignment Rules
  getAssignmentRules: () =>
    req<Record<string, { value: unknown; updated_at: string; updated_by: string | null }>>('/api/assignment-rules'),

  updateAssignmentRule: (key: string, value: unknown) =>
    req(`/api/assignment-rules/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ value }) }),

  // Notification channels
  getNotificationChannels: () =>
    req<NotificationChannelConfig[]>('/api/admin/notification-channels'),

  saveNotificationChannel: (channel: string, payload: { enabled: boolean; config: Record<string, string>; reports: { daily: boolean; weekly: boolean } }) =>
    req<NotificationChannelConfig>(`/api/admin/notification-channels/${channel}`, { method: 'PUT', body: JSON.stringify(payload) }),

  testNotificationChannel: (channel: string, config: Record<string, string>, reportType: 'daily' | 'weekly' = 'daily') =>
    req<{ ok: boolean }>(`/api/admin/notification-channels/${channel}/test`, { method: 'POST', body: JSON.stringify({ enabled: true, config, reports: { daily: true, weekly: true }, report_type: reportType }) }),

  // Supervisor
  getSupervisorLive: () =>
    req<{
      agents: Agent[];
      queues: QueueItem[];
      sla_risk: SLARiskTicket[];
      sla_breached_count: number;
      sla_at_risk_count: number;
      stats: SupervisorStats;
      channel_health: ChannelHealth[];
      pending_stale: PendingStale[];
    }>('/api/supervisor/live'),

  assignTicket: (ticketId: string, agentId: string) =>
    req(`/api/tickets/${ticketId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ assigned_to: agentId }),
    }),

  getAgentTickets: (agentId: string) =>
    req<Ticket[]>(`/api/supervisor/agent/${agentId}/tickets`),

  // Analytics (Phase 4 — stub until backend route added)
  getAnalytics: (filters: AnalyticsFilters) => {
    const params = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null)) as Record<string, string>
    );
    return req<Record<string, unknown>>(`/api/analytics?${params}`);
  },

  // Insights — unified analytics + metrics in one call
  getInsights: (filters: { range?: string; channel?: string; agent_id?: string; category?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null && v !== '')) as Record<string, string>
    );
    return req<Record<string, unknown>>(`/api/insights?${params}`);
  },

  // Canned responses
  getCannedResponses: () =>
    req<{ id: string; title: string; shortcut: string; body: string; scope: string }[]>(
      '/api/canned-responses'
    ),

  createCannedResponse: (data: { title: string; shortcut: string; body: string; scope: string }) =>
    req('/api/canned-responses', { method: 'POST', body: JSON.stringify(data) }),

  deleteCannedResponse: (id: string) =>
    req(`/api/canned-responses/${id}`, { method: 'DELETE' }),

  // Tags
  getTags: () => req<{ tags: string[] }>('/api/tags').then(r => r.tags),
  createTag: (name: string) => req<{ tags: string[] }>('/api/tags', { method: 'POST', body: JSON.stringify({ name }) }).then(r => r.tags),
  deleteTag: (name: string) => req<{ tags: string[] }>(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(r => r.tags),

  // Copilot
  suggestReply: (ticketId: string) =>
    req<{ suggestion: string }>('/api/copilot/suggest-reply', {
      method: 'POST', body: JSON.stringify({ ticketId }),
    }),

  summarize: (ticketId: string) =>
    req<{ summary: string }>('/api/copilot/summarize', {
      method: 'POST', body: JSON.stringify({ ticketId }),
    }),

  draftReply: (ticketId: string, shorthand: string) =>
    req<{ draft: string }>('/api/copilot/draft', {
      method: 'POST', body: JSON.stringify({ ticketId, shorthand }),
    }),

  draftAssisted: (ticketId: string, instruction: string, partialDraft: string) =>
    req<{ draft: string }>('/api/copilot/draft-assisted', {
      method: 'POST', body: JSON.stringify({ ticketId, instruction, partialDraft }),
    }),

  sentiment: (ticketId: string) =>
    req<{ sentiment: string }>('/api/copilot/sentiment', {
      method: 'POST', body: JSON.stringify({ ticketId }),
    }),

  relatedTickets: (ticketId: string) =>
    req<{ related: RelatedTicket[] }>('/api/copilot/related-tickets', {
      method: 'POST', body: JSON.stringify({ ticketId }),
    }),

  // Knowledge Base
  listKnowledge: () =>
    req<{ items: KnowledgeItem[] }>('/api/knowledge').then(r => r.items),

  addKnowledgeUrl: (url: string) =>
    req<KnowledgeItem>('/api/knowledge/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  uploadKnowledgeFile: (file: File) => {
    const token = getToken();
    const form = new FormData();
    form.append('file', file);
    return fetch(`${API}/api/knowledge/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }).then(async r => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error((b as { detail?: string }).detail ?? `${r.status}`); }
      return r.json() as Promise<KnowledgeItem>;
    });
  },

  deleteKnowledge: (id: number) =>
    req(`/api/knowledge/${id}`, { method: 'DELETE' }),

  getKnowledgeChunks: (id: number) =>
    req<{ item_id: number; chunks: { index: number; text: string }[] }>(`/api/knowledge/${id}/chunks`),

  // Notifications
  getNotifications: () =>
    req<Notification[]>('/api/notifications'),

  markNotificationRead: (id: string) =>
    req(`/api/notifications/${id}/read`, { method: 'PATCH' }),

  markNotificationUnread: (id: string) =>
    req(`/api/notifications/${id}/unread`, { method: 'PATCH' }),

  markAllNotificationsRead: () =>
    req('/api/notifications/read-all/mark', { method: 'PATCH' }),

  bulkMarkNotifications: (ids: string[], read: boolean) =>
    req('/api/notifications/bulk', { method: 'PATCH', body: JSON.stringify({ ids, read }) }),

  // FR-09: Core API — live customer profile from Bitazza backend (5s timeout)
  getCoreProfile: async (bitazzaUid: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      return await req<{
        kyc_status: string;
        kyc_level: number;
        account_status: string;
        balances: { currency: string; available: number; locked: number }[];
        recent_transactions: { id: string; type: string; amount: number; currency: string; status: string; created_at: string }[];
      }>(`/api/core/profile/${encodeURIComponent(bitazzaUid)}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  },
};

// ── Socket.io client ──────────────────────────────────────────────────────────
// Returns a Socket instance. Caller handles events via socket.on(...)
// createWS kept for backwards compat with App.tsx (returns WebSocket-like object).
// New code should use createSocket() instead.

export function createSocket(): Socket {
  const token = getToken();
  return io(API, {
    auth: { token: token ?? '' },
    transports: ['websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
}

// Backwards-compat shim: wraps socket.io in a WebSocket-shaped object
// so existing App.tsx / MessageThread.tsx code continues to work unchanged.
export function createWS(onEvent: (e: unknown) => void): WebSocket {
  const socket = createSocket();

  // Forward all server→client events as fake MessageEvents
  const EVENTS = [
    'new_message', 'status_change', 'ticket:updated', 'ticket:assigned',
    'ticket_assigned', 'agent_typing', 'agent_presence', 'sla:breach',
    'whisper', 'supervisor_joined', 'ticket:resolve_request', 'notification:new',
  ];

  EVENTS.forEach(ev => {
    socket.on(ev, (payload: unknown) => {
      onEvent({ type: ev, ...((payload as object) ?? {}) });
    });
  });

  // Fake WebSocket interface expected by callers
  const fake = {
    readyState: WebSocket.CONNECTING as number,
    send: (data: string) => {
      try {
        const parsed = JSON.parse(data) as { type: string; [k: string]: unknown };
        const { type, ...rest } = parsed;
        socket.emit(type, rest);
      } catch { /* ignore */ }
    },
    close: () => socket.disconnect(),
    onclose: null as ((e: CloseEvent) => void) | null,
    addEventListener: (_: string, __: unknown) => {},
    removeEventListener: (_: string, __: unknown) => {},
  };

  socket.on('connect',    () => { fake.readyState = WebSocket.OPEN; });
  socket.on('disconnect', () => {
    fake.readyState = WebSocket.CLOSED;
    fake.onclose?.({} as CloseEvent);
  });

  return fake as unknown as WebSocket;
}
