// ─── Language ────────────────────────────────────────────────────────────────

export type SupportedLanguage = string; // open-ended: 'en' | 'th' | 'zh' | 'ms' | etc.

// ─── Config ──────────────────────────────────────────────────────────────────

export interface CSBotSDKConfig {
  platform: 'bitazza' | 'freedom' | 'web';
  apiUrl: string;
  token?: string;
  tokenExpiresAt?: number;           // ms since epoch
  onTokenRefresh?: () => Promise<string>;
  wstBootstrap?: string;             // Bitazza Exchange single-use bootstrap (wstb_*); exchanged for a session JWT
  primaryColor?: string;             // hex, default '#1a56db'
  lang?: SupportedLanguage;
  supportedLanguages: SupportedLanguage[];
  sessionTtlMs?: number;             // default: 3 * 60 * 60 * 1000
  guestMode?: boolean;
  onEscalated?: () => void;
  onCsatComplete?: () => void;
  onNotificationSound?: () => void;
}

// ─── Issue categories ────────────────────────────────────────────────────────

export type IssueCategory =
  | 'kyc_verification'
  | 'account_restriction'
  | 'password_2fa_reset'
  | 'fraud_security'
  | 'withdrawal_issue'
  | 'other';

export interface IssueCategoryDef {
  key: IssueCategory;
  icon: string;
  label: Record<SupportedLanguage, string>;
  openingMessage: Record<SupportedLanguage, string>;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'agent' | 'system';

export interface AttachmentMeta {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  escalated?: boolean;
  agentName?: string;
  agentAvatar?: string;
  agentAvatarUrl?: string;
  offerResolution?: boolean;
  senderName?: string;
  attachments?: AttachmentMeta[];
  quickReplies?: string[];
}

export interface AgentIdentity {
  name: string;
  avatar: string;
  avatarUrl: string | null;
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export type TicketStatus =
  | 'Open_Live'
  | 'In_Progress'
  | 'Pending_Customer'
  | 'Escalated'
  | 'Closed_Resolved'
  | 'Closed_Unresponsive';

export interface PastTicket {
  id: string;
  category: string;
  status: string;
  createdAt: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
}

// ─── Announcements ───────────────────────────────────────────────────────────

export interface Announcement {
  id: string;
  titleEn: string;
  bodyEn: string;
  titleTh: string;
  bodyTh: string;
  color: string | null;
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

export type WsInboundMessage =
  | { type: 'pong' }
  | { type: 'new_message'; message: Message }
  | { type: 'status_change'; status: TicketStatus }
  | { type: 'bot_message'; content: string };

export type WsOutboundMessage =
  | { type: 'ping' }
  | { type: 'auth'; token: string | null };

export type WsConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

// ─── Conversation hook ───────────────────────────────────────────────────────

export interface ConversationState {
  messages: Message[];
  loading: boolean;
  convId: string | null;
  lang: SupportedLanguage;
  langSelected: boolean;
  selectedCategory: IssueCategory | null;
  escalated: boolean;
  escalatedAgent: AgentIdentity | null;
  agentConnectedBanner: string | null;
  botName: string | null;
  botAvatarUrl: string | null;
  csatPending: boolean;
  csatSubmitted: boolean;
  prevTickets: PastTicket[];
  openTicket: PastTicket | null;
  showPrevTickets: boolean;
  showOpenTicketBanner: boolean;
  isGuest: boolean;
  showGuestForm: boolean;
  pendingAttachments: AttachmentMeta[];
  uploadingFiles: boolean;
  announcements: Announcement[];
  wsState: WsConnectionState;
  error: string | null;
  awaitingFirstReply: boolean;
}

export interface ConversationActions {
  send(text: string, category?: string, skipUserBubble?: boolean): Promise<void>;
  selectCategory(cat: IssueCategory): Promise<void>;
  selectLanguage(lang: SupportedLanguage): void;
  submitCsat(score: 1 | 2 | 3 | 4 | 5): Promise<void>;
  declineResolution(): void;
  resumeTicket(ticketId: string): Promise<void>;
  startGuestSession(name: string, email: string): Promise<void>;
  handleFiles(files: File[]): Promise<void>;
  removePendingAttachment(id: string): void;
  reset(): void;
}
