// ── Enums — match backend CHECK constraints exactly ──────────────────────────

export type TicketStatus =
  | 'Open_Live'
  | 'In_Progress'
  | 'Pending_Customer'
  | 'Closed_Resolved'
  | 'Closed_Unresponsive'
  | 'Orphaned'
  | 'Escalated';

export type Priority = 1 | 2 | 3; // 1=VIP 2=EA 3=Standard

export type Channel = 'web' | 'line' | 'facebook' | 'email';

export type CustomerTier = 'Standard' | 'EA' | 'VIP';

export type AgentStatus = 'Available' | 'Busy' | 'Break' | 'Offline' | 'away' | 'after_call_work';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export type TicketCategory =
  | 'kyc_verification'
  | 'account_restriction'
  | 'password_2fa_reset'
  | 'fraud_security'
  | 'withdrawal_issue'
  | 'unclassified';

export type InboxView =
  | 'all'
  | 'all_open'
  | 'mine'
  | 'unassigned'
  | 'sla_risk'
  | 'waiting'
  | 'by_priority';

export type StatusFilter =
  | 'all'
  | 'Open_Live'
  | 'In_Progress'
  | 'Pending_Customer'
  | 'Escalated'
  | 'Closed_Resolved'
  | 'Closed_Unresponsive';

export type ChannelFilter = 'all' | 'email' | 'web' | 'app';

export type SenderType =
  | 'customer'
  | 'agent'
  | 'bot'
  | 'system'
  | 'internal_note'
  | 'whisper'
  | 'ai'        // legacy alias
  | 'assistant'; // legacy alias

// ── Domain models ────────────────────────────────────────────────────────────

export interface CustomerProfile {
  id?: string;
  user_id?: string;
  name: string;
  email?: string;
  tier: CustomerTier;
  kyc_status?: string;
  kyc_tier?: number;
  bitazza_uid?: string;
  line_uid?: string;
  fb_psid?: string;
  past_conversation_count?: number;
}

export interface Agent {
  id: string;
  name: string;
  email?: string;
  role?: string;
  // DB field names (from backend)
  state?: AgentStatus;
  active_chats?: number;
  max_chats?: number;
  // Legacy frontend field names
  status?: AgentStatus;
  active_conversation_count?: number;
  max_capacity?: number;
  skills: string[];
  shift?: string;
  active?: boolean;
  avatar_url?: string | null;
  last_activity_at?: string | null;
  longest_open_mins?: number | null;
  open_ticket_count?: number | null;
  team?: string;
}

export interface MessageAttachment {
  id: string;
  url: string;
  name: string;
  mime_type: string;
  size: number;
}

export interface Message {
  id?: string;
  role: SenderType;
  sender_type?: SenderType;
  content: string;
  created_at: number; // unix seconds
  is_internal_note?: boolean;
  mentions?: string[];
  agent_name?: string;
  supervisor_name?: string;
  metadata?: Record<string, unknown>;
  attachments?: MessageAttachment[];
}

export interface Ticket {
  id: string;
  conversation_id?: string; // kept for WS event matching
  status: TicketStatus;
  priority: Priority;
  channel: Channel;
  category?: TicketCategory;
  customer?: CustomerProfile;
  // DB field names
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  // Legacy frontend field names
  assigned_agent_id?: string | null;
  assigned_agent_name?: string | null;
  ai_persona?: { ai_name?: string; ai_avatar?: string; ai_avatar_url?: string } | null;
  tags: string[];
  sla_deadline?: string | null;   // ISO timestamp from DB
  sla_breach_at?: string | null;  // alias
  sla_breached?: boolean;
  created_at: string | number;
  updated_at?: string | number;
  last_message?: string | null;
  last_message_at?: string | number | null;
  sentiment?: Sentiment | null;
  collision_agent_ids?: string[];
  csat_score?: number | null;
  customer_name?: string | null;   // flat field returned by some queries
  source?: string | null;          // originating app: "Bitazza GL" / "Bitazza TH" — from auth api (future)
}

export interface TicketDetail extends Ticket {
  history: Message[];
}

// ── Copilot ──────────────────────────────────────────────────────────────────

export interface CopilotSuggestion {
  draft: string;
  loading: boolean;
}

export interface RelatedTicket {
  id: string;
  customer_name?: string;
  category?: TicketCategory;
  status: TicketStatus;
  last_message?: string | null;
  created_at?: string;
}

// ── Supervisor ────────────────────────────────────────────────────────────────

export interface SupervisorStats {
  opened_today: number | string;
  resolved_today: number | string;
  resolved_yesterday?: number | string;
  avg_first_response_s?: number | string;
  avg_first_response_seconds?: number;
  avg_resolution_s?: number | string;
  avg_resolution_seconds?: number;
  csat_avg?: number | null;
  bot_active?: number | string;
  bot_active_count?: number;
  bot_handoff_rate?: number;
  bot_contained?: number | string;
  bot_total?: number | string;
  queue_depth?: number;
}

export interface QueueItem {
  channel: Channel;
  priority: Priority;
  count: number | string;
  oldest_at?: string;
}

export interface ChannelHealth {
  channel: string;
  open_count: number;
  queued: number;
  oldest_queued_at: string | null;
  sla_breached_count: number;
  sla_met_pct: number | null;
}

export interface PendingStale {
  id: string;
  created_at: string | null;
  last_customer_msg_at: string | null;
  customer_name: string | null;
  tier: string | null;
  assigned_to_name: string | null;
  sla_deadline: string | null;
}

export interface SLARiskTicket {
  id: string;
  priority: Priority;
  sla_deadline?: string;
  sla_breached?: boolean;
  customer_name?: string;
  tier?: CustomerTier;
  assigned_to_name?: string | null;
  // Legacy
  category?: TicketCategory;
  customer_tier?: CustomerTier;
  assigned_agent_name?: string | null;
  seconds_to_breach?: number;
  created_at?: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface AnalyticsFilters {
  date_range?: 'today' | '7d' | '30d' | 'custom';
  date_from?: string;
  date_to?: string;
  channel?: Channel;
  agent_id?: string;
  category?: TicketCategory;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export type NotificationPriority = 'critical' | 'high' | 'medium' | 'info';

export type NotificationType =
  | 'sla_breach'
  | 'sla_warning'
  | 'assigned'
  | 'vip_waiting'
  | 'agent_offline'
  | 'whisper'
  | 'escalated'
  | 'customer_reply';

export interface Notification {
  id: string;
  user_id: string;
  role: string;
  type: NotificationType | string;
  priority: NotificationPriority;
  title: string;
  body: string;
  ticket_id?: string | null;
  read: boolean;
  created_at: string; // ISO timestamp
}

// ── WebSocket events ─────────────────────────────────────────────────────────

export type WSEvent =
  | { type: 'new_message';      conversation_id: string; message: Message }
  | { type: 'new_ticket';       ticket: Ticket }
  | { type: 'status_change';    conversation_id: string; status: TicketStatus }
  | { type: 'ticket:updated';   ticketId: string; changes: Partial<Ticket> }
  | { type: 'ticket:assigned';  ticketId: string; agentId: string; agentName?: string | null; agentAvatarUrl?: string | null }
  | { type: 'ticket_assigned';  conversation_id: string; agent_id?: string; agent_name?: string; agent_avatar_url?: string | null }
  | { type: 'agent_typing';     conversation_id: string; agent_id?: string; agent_name: string }
  | { type: 'agent_presence';   agentId: string; state: AgentStatus }
  | { type: 'sla:breach';       ticketId: string; priority?: Priority }
  | { type: 'whisper';          ticket_id: string; content: string; supervisor_name: string }
  | { type: 'supervisor_joined'; ticket_id: string; supervisor_name: string }
  | { type: 'notification:new'; notification: Notification };

// ── Auth ─────────────────────────────────────────────────────────────────────

export type Role = 'agent' | 'supervisor' | 'admin' | 'kyc_agent' | 'finance_agent' | 'super_admin' | string;

export interface AgentRole {
  name: string;
  display_name?: string | null;
  is_preset: boolean;
  created_at?: string;
  permissions?: string[];
}

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role: Role;
  team?: string;
  token: string;
  permissions: string[];
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

export type KnowledgeSourceType = 'url' | 'pdf' | 'docx';

export interface KnowledgeItem {
  id: number;
  title: string;
  source_type: KnowledgeSourceType;
  source_ref: string | null;
  chunk_count: number;
  created_by: number | null;
  created_at: number; // unix seconds
}

export interface NotificationChannelConfig {
  channel: string;
  enabled: boolean;
  config: Record<string, string>;
  reports: { daily: boolean; weekly: boolean };
  updated_at?: string | null;
}

// ── Ticket Properties ─────────────────────────────────────────────────────────

export type PropertyFieldType = 'single_select' | 'multi_select' | 'text' | 'number' | 'boolean';

export interface PropertyOption {
  value: string;
  label: string;
}

export interface PropertyDefinition {
  id: string;
  name: string;
  field_key: string;
  field_type: PropertyFieldType;
  options: PropertyOption[] | null;
  applies_to: string[] | null;
  is_required: boolean;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface PropertyValue {
  property_id: string;
  value_text: string | null;
  value_array: string[] | null;
  value_number: number | null;
  updated_at: string;
  updated_by_name: string | null;
}

export type PropertyValuesMap = Record<string, PropertyValue>;

// Legacy — kept so old components referencing Conversation don't break
export interface Conversation {
  id: string;
  user_id: string;
  platform: string;
  language: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  ticket_id: string | null;
  ticket_status: TicketStatus | null;
  escalation_reason: string | null;
  last_message: string | null;
}
