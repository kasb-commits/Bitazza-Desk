import { useState, useEffect, useRef, useCallback } from 'react';
import DOMPurify from 'dompurify';

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['p','strong','em','u','s','h2','h3','ul','ol','li','a','br','blockquote','code'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
};

function isHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}
import type { Message, MessageAttachment, CSBotConfig, IssueCategory } from './types';
import { ISSUE_CATEGORIES } from './types';
import { startConversation, sendMessage, uploadAttachment, fetchHistory, setCategoryAgent, getStoredSession, storeSessionLang, storeSessionCategory, storeSessionAgent, storeSessionBotInfo, clearStoredSession, fetchCustomerTickets, fetchOpenTicket, getStoredCustomerId, emergencyEscalate, fetchAnnouncements } from './api';
import type { PastTicket, Announcement } from './api';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import CategoryPicker from './CategoryPicker';
import PrevConversations from './PrevConversations';
import GuestIdentityForm from './GuestIdentityForm';

function playNotificationBeep() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch {
    // AudioContext unavailable — fail silently
  }
}

const CATEGORY_LABEL_SHORT: Record<string, { en: string; th: string }> = {
  ai_handling:         { en: 'Support',             th: 'การสนับสนุน' },
  kyc_verification:    { en: 'KYC Verification',    th: 'KYC' },
  account_restriction: { en: 'Account Restricted',  th: 'บัญชีถูกระงับ' },
  password_2fa_reset:  { en: 'Password/2FA',        th: 'รหัสผ่าน/2FA' },
  fraud_security:      { en: 'Fraud/Security',      th: 'การฉ้อโกง' },
  withdrawal_issue:    { en: 'Withdrawal',           th: 'การถอนเงิน' },
  other:               { en: 'Other',                th: 'อื่นๆ' },
};

function relativeDate(unixTs: number, lang: 'en' | 'th'): string {
  const diff = Math.floor((Date.now() / 1000 - unixTs) / 86400);
  if (lang === 'th') {
    if (diff === 0) return 'วันนี้';
    if (diff === 1) return 'เมื่อวาน';
    return `${diff} วันที่แล้ว`;
  }
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return `${diff} days ago`;
}

const UI_TEXT = {
  en: {
    placeholder: 'Type your message...',
    placeholderConnecting: 'Please wait for the agent to respond...',
    send: 'Send',
    header: 'Support',
    escalationBanner: 'Connecting you to a support agent...',
    errorRetry: 'Failed to send. Tap to retry.',
    welcome: 'Hey there! 😊 What can I help you with today?',
    connectionFallback: "We're having trouble connecting. Please email us at support@bitazza.com or call +66-2-171-2417.",
  },
  th: {
    placeholder: 'พิมพ์ข้อความของคุณ...',
    placeholderConnecting: 'กรุณารอการตอบกลับจากเจ้าหน้าที่...',
    send: 'ส่ง',
    header: 'ฝ่ายสนับสนุน',
    escalationBanner: 'กำลังเชื่อมต่อกับเจ้าหน้าที่สนับสนุน...',
    errorRetry: 'ส่งไม่สำเร็จ แตะเพื่อลองใหม่',
    welcome: 'สวัสดีค่ะ! 😊 วันนี้มีอะไรให้ช่วยได้บ้างคะ?',
    connectionFallback: 'ขณะนี้ระบบขัดข้อง กรุณาติดต่อเราที่ support@bitazza.com หรือโทร +66-2-171-2417',
  },
};


interface Props {
  cfg: CSBotConfig;
  onClose: () => void;
}

const CLOSED_STATUSES = ['Closed_Resolved', 'Closed_Unresponsive'];

export default function ChatWindow({ cfg, onClose }: Props) {
  const resolveUrl = (url: string | null | undefined): string | null => {
    if (!url) return null;
    return url.startsWith('/') ? `${cfg.apiUrl}${url}` : url;
  };

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [escalatedAgent, setEscalatedAgent] = useState<{ name: string; avatar: string; avatarUrl: string | null } | null>(null);
  const [agentConnectedBanner, setAgentConnectedBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<'en' | 'th'>(cfg.lang ?? 'en');
  const [langSelected, setLangSelected] = useState(!!cfg.lang);
  const [convId, setConvId] = useState<string | null>(null);
  const [consecutiveLow, setConsecutiveLow] = useState(0);
  const [botName, setBotName] = useState<string | null>(null);
  const [botAvatarUrl, setBotAvatarUrl] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<IssueCategory | null>(null);
  const [resolutionRejections, setResolutionRejections] = useState(0);
  const [csatPending, setCsatPending] = useState(false);
  const [csatSubmitted, setCsatSubmitted] = useState(false);
  const [csatHover, setCsatHover] = useState(0);
  const [agentClosureRequest, setAgentClosureRequest] = useState(false);
  const [ticketStatus, setTicketStatus] = useState<string | null>(null);
  const prevClosedRef = useRef(false);
  const [prevTickets, setPrevTickets] = useState<PastTicket[]>([]);
  const [showPrevTickets, setShowPrevTickets] = useState(false);
  const [openTicket, setOpenTicket] = useState<PastTicket | null>(null);
  const [showOpenTicketBanner, setShowOpenTicketBanner] = useState(false);
  const [awaitingFirstReply, setAwaitingFirstReply] = useState(false);
  const [isGuest, setIsGuest] = useState<boolean>(cfg.guestMode ?? false);
  const [showGuestForm, setShowGuestForm] = useState<boolean>(false);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [dismissedAnnIds, setDismissedAnnIds] = useState<Set<string>>(new Set());
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [activePills, setActivePills] = useState<{ msgId: string; pills: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastAgentMsgTime = useRef(0);
  const lastFailedText = useRef('');
  const sendRef = useRef<((text: string, category?: string, skipUserBubble?: boolean) => Promise<void>) | null>(null);
  // Holds the category the customer was in before clicking "Go back", so selectCategory can show the topic-switch divider
  const prevCategoryRef = useRef<IssueCategory | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = UI_TEXT[lang];
  // Closed when DB status says so; fall back to csatSubmitted if status not yet known
  const isTicketClosed = ticketStatus ? CLOSED_STATUSES.includes(ticketStatus) : csatSubmitted;

  // Init conversation — restore if session exists, otherwise start fresh
  useEffect(() => {
    const existing = getStoredSession();
    if (existing) {
      // Resume: load history from backend
      // If the stored session is a guest session but we're now authenticated, discard it
      // so a fresh authenticated conversation starts instead.
      if (existing.isGuest && !cfg.guestMode) {
        clearStoredSession();
        showGreeting();
        startConversation(cfg)
          .then((id) => setConvId(id))
          .catch(() => setError('Could not connect. Please refresh.'));
        return;
      }
      if (existing.isGuest) setIsGuest(true);
      // Restore lang selection from session if available
      if (existing.lang) {
        setLang(existing.lang);
        setLangSelected(true);
        fetchAnnouncements(cfg).then(setAnnouncements).catch(() => {});
      }
      // Restore category from session if available
      if (existing.category) {
        setSelectedCategory(existing.category as IssueCategory);
      }
      // Restore AI bot persona so message bubbles show the correct name instead of "Bitazza Support"
      if (existing.botName) {
        setBotName(existing.botName);
        setBotAvatarUrl(existing.botAvatarUrl ?? null);
      }
      fetchHistory(cfg, existing.id).then(({ messages: history, humanHandling, ticketStatus: restoredStatus }) => {
        // Seed ticketStatus and prevClosedRef from server truth before enabling the input.
        // setConvId is intentionally deferred to here so ticketStatus and convId land in the
        // same React render batch — preventing a window where convId is set but ticketStatus
        // is still null, which would briefly enable the input on a closed ticket.
        if (restoredStatus) {
          setTicketStatus(restoredStatus);
          prevClosedRef.current = CLOSED_STATUSES.includes(restoredStatus);
        }
        setConvId(existing.id);
        if (history.length === 0) {
          // Session exists but no messages — show greeting
          showGreeting();
          if (existing.lang) setLangSelected(false); // reset so lang picker shows again
          return;
        }
        // Always use the latest agent message from history as ground truth
        const lastAgentMsg = [...history].reverse().find((m) => m.role === 'agent');
        const restoredAgent = lastAgentMsg?.agent_name ? {
          name: lastAgentMsg.agent_name,
          avatar: lastAgentMsg.agent_avatar ?? lastAgentMsg.agent_name[0].toUpperCase(),
          avatarUrl: lastAgentMsg.agent_avatar_url ?? null,
        } : (existing.agent ?? null);
        if (restoredAgent) {
          setEscalated(true);
          setEscalatedAgent(restoredAgent);
          storeSessionAgent(restoredAgent); // persist so next reload still has agent identity
        } else if (humanHandling) {
          // Human has taken over from dashboard but hasn't replied yet —
          // only set the escalated flag; leave escalatedAgent null so the back button
          // stays visible (matches poll path behaviour).
          setEscalated(true);
        }
        // Re-populate previous tickets for restored sessions (mirrors selectCategory logic)
        if (existing.category && !existing.isGuest && getStoredCustomerId()) {
          fetchCustomerTickets(cfg, 1, 20).then((tickets) => {
            if (tickets.length > 0) {
              setPrevTickets(tickets);
              setShowPrevTickets(true);
            }
          }).catch(() => {});
        }
        const restored: Message[] = history.map((m, idx) => ({
          id: `restored-${m.created_at}-${idx}`,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: m.created_at * 1000,
          agentName: m.agent_name ?? restoredAgent?.name,
          agentAvatar: m.agent_avatar ?? restoredAgent?.avatar,
          agentAvatarUrl: resolveUrl(m.agent_avatar_url ?? restoredAgent?.avatarUrl) ?? undefined,
          attachments: m.attachments?.map(a => ({ id: a.id, url: a.url, name: a.name, mimeType: a.mime_type, size: a.size })),
        }));
        setMessages(restored);
        // If any agent message exists, mark as escalated
        if (history.some((m) => m.role === 'agent')) setEscalated(true);
      }).catch(() => {
        // Session is stale/unreachable — clear it and start fresh
        clearStoredSession();
        setLangSelected(false);
        showGreeting();
        startConversation(cfg)
          .then((id) => setConvId(id))
          .catch(() => setError('Could not connect. Please refresh.'));
      });
    } else {
      showGreeting();
      // Guest mode: don't call startConversation yet — wait until after lang + identity form
      if (!cfg.guestMode) {
        startConversation(cfg)
          .then((id) => setConvId(id))
          .catch(async () => {
            try {
              const result = await emergencyEscalate(cfg, 'start_failed');
              setConvId(result.conversationId);
              setEscalated(true);
              setLangSelected(true);
              setSelectedCategory('other' as IssueCategory);
            } catch {
              setMessages((prev) => [...prev, {
                id: 'emergency-fallback',
                role: 'assistant',
                content: UI_TEXT[cfg.lang ?? 'en'].connectionFallback,
                timestamp: Date.now(),
              }]);
            }
          });
      }
    }
  }, []);

  const handleGuestFormSubmit = (name: string, email: string) => {
    setShowGuestForm(false);
    setAwaitingFirstReply(true);
    startConversation(cfg, name || undefined, email || undefined)
      .then((id) => {
        setConvId(id);
        setCategoryAgent(cfg, id, 'other').then(({ agentName, agentAvatarUrl }) => {
          const resolvedName = agentName ?? 'Aria';
          const resolvedAvatar = resolveUrl(agentAvatarUrl);
          setBotName(resolvedName);
          setBotAvatarUrl(resolvedAvatar);
          storeSessionBotInfo(resolvedName, resolvedAvatar);
          setTimeout(() => {
            const greeting = lang === 'th'
              ? `สวัสดีค่ะ ดิฉันชื่อ ${resolvedName} เป็น AI ผู้ช่วยฝ่ายสนับสนุนค่ะ 🤖 ยินดีช่วยเหลือคุณลูกค้าในเซสชันนี้เลยนะคะ`
              : `Hi! I'm ${resolvedName}, your AI support assistant. 🤖 I'll gladly help you on this session.`;
            setMessages((prev) => [...prev, {
              id: 'aria-intro',
              role: 'assistant' as const,
              content: greeting,
              timestamp: Date.now(),
              senderName: resolvedName,
              agentAvatarUrl: resolvedAvatar || undefined,
            }]);
            setAwaitingFirstReply(false);
          }, 1200 + Math.random() * 600);
        }).catch(() => {
          // setCategoryAgent failed — still unlock input with a generic greeting
          setTimeout(() => {
            setMessages((prev) => [...prev, {
              id: 'ploy-intro',
              role: 'assistant' as const,
              content: lang === 'th' ? 'สวัสดีค่ะ! มีอะไรให้ช่วยได้บ้างคะ? 😊' : 'Hi there! 😊 How can I help you today?',
              timestamp: Date.now(),
            }]);
            setAwaitingFirstReply(false);
          }, 1000);
        });
      })
      .catch(() => {
        setAwaitingFirstReply(false);
        setError('Could not connect. Please refresh.');
      });
  };

  function showGreeting() {
    const now = Date.now();
    setMessages([
      {
        id: 'greeting',
        role: 'assistant',
        content: '👋 Hi! How can I help you today?\n\nPlease select your language:\n---\n👋 สวัสดีค่ะ! มีอะไรให้ช่วยได้บ้างคะ?\n\nกรุณาเลือกภาษา:',
        timestamp: now,
        senderName: 'Bitazza Support',
      },
    ]);
  }

  const AGENT_INTRO = {
    en: (name: string) => `Hi! I'm ${name}, your AI support assistant. 🤖 I'll gladly help you on this session.`,
    th: (name: string) => `สวัสดีค่ะ ดิฉันชื่อ ${name} เป็น AI ผู้ช่วยฝ่ายสนับสนุนค่ะ 🤖 ยินดีช่วยเหลือคุณลูกค้าในเซสชันนี้เลยนะคะ`,
  };

  const selectCategory = useCallback((category: IssueCategory) => {
    // If customer came from a previous category (went back and re-picked), inject an inline topic-switch divider
    if (prevCategoryRef.current && prevCategoryRef.current !== category) {
      const oldLabel = ISSUE_CATEGORIES.find((c) => c.key === prevCategoryRef.current!)?.label[lang] ?? prevCategoryRef.current;
      const newLabel = ISSUE_CATEGORIES.find((c) => c.key === category)?.label[lang] ?? category;
      setMessages((msgs) => [...msgs, {
        id: crypto.randomUUID(),
        role: 'system' as const,
        content: `${oldLabel} → ${newLabel}`,
        timestamp: Date.now(),
      }]);
      prevCategoryRef.current = null;
    }
    setSelectedCategory(category);
    storeSessionCategory(category);
    // Load previous tickets for returning customers (not guests)
    if (!isGuest && getStoredCustomerId()) {
      fetchCustomerTickets(cfg, 1, 20).then((tickets) => {
        if (tickets.length > 0) {
          setPrevTickets(tickets);
          setShowPrevTickets(true);
          // Scroll after React has painted the PrevConversations block at the top
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 0);
        }
      });
    }
    const cat = ISSUE_CATEGORIES.find((c) => c.key === category)!;
    const openingMsg = cat.openingMessage[lang];

    // 1. Show the user's opening message bubble immediately
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: openingMsg,
      timestamp: Date.now(),
    }]);

    if (convId) {
      setAwaitingFirstReply(true);
      const trySetCategory = async () => {
        try {
          return await setCategoryAgent(cfg, convId, category);
        } catch {
          return await setCategoryAgent(cfg, convId, category);
        }
      };
      trySetCategory().then(({ agentName, agentAvatarUrl }) => {
        const resolvedName = agentName ?? 'Support Agent';
        const resolvedAvatar = resolveUrl(agentAvatarUrl);
        setBotName(resolvedName);
        setBotAvatarUrl(resolvedAvatar);
        storeSessionBotInfo(resolvedName, resolvedAvatar);

        // 2. After a short human-feel delay, show the agent's intro message
        //    Skip for "other" — the AI's first response will ask what they need.
        setTimeout(() => {
          if (category !== 'other') {
            setMessages((prev) => [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: AGENT_INTRO[lang](resolvedName),
              timestamp: Date.now(),
            }]);
          }

          // 3. Then fire the API call — send() will skip adding the user bubble again
          sendRef.current?.(openingMsg, category, true);
        }, 1200 + Math.random() * 600);
      }).catch(() => {
        // Both setCategoryAgent attempts failed — ticket already exists, just escalate
        setEscalated(true);
        setAwaitingFirstReply(false);
      });
    } else {
      sendRef.current?.(openingMsg, category, true);
    }
  }, [convId, cfg, lang, isGuest]);

  const CATEGORY_PROMPT = {
    en: 'Please select the type of issue you need help with:',
    th: 'กรุณาเลือกประเภทปัญหาที่ต้องการความช่วยเหลือ:',
  };

  const selectLanguage = useCallback((selected: 'en' | 'th') => {
    setLang(selected);
    setLangSelected(true);
    storeSessionLang(selected);
    // Fetch active announcements (non-blocking — shown above category picker)
    fetchAnnouncements(cfg).then(anns => {
      setAnnouncements(anns);
      if (anns.length > 0) {
        // Scroll to the announcement card once it renders
        setTimeout(() => annRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      }
    }).catch(() => {});
    // For guest mode: show the identity form instead of proceeding to category picker
    if (cfg.guestMode) {
      setShowGuestForm(true);
      return;
    }

    // Always show the category prompt immediately in the selected language
    setMessages((prev) => [...prev, {
      id: 'category-prompt',
      role: 'assistant',
      content: CATEGORY_PROMPT[selected],
      timestamp: Date.now(),
      senderName: 'Bitazza Support',
    }]);
    // Check for an open ticket from a *previous* session (only if authenticated customer_id is known)
    if (!isGuest && getStoredCustomerId()) {
      fetchOpenTicket(cfg).then((ticket) => {
        if (!ticket) return;
        // Skip if this is the conversation we just started — nothing to "resume".
        if (ticket.id === convId) return;
        // Verify the ticket actually has messages before showing the resume banner.
        // A ticket can be "open" in the DB (created via dashboard/email) while having
        // zero messages in the widget conversation store — nothing to resume in that case.
        fetchHistory(cfg, ticket.id).then(({ messages: history }) => {
          if (history.length > 0) {
            setOpenTicket(ticket);
            setShowOpenTicketBanner(true);
          }
        });
      });
    }
  }, [cfg, convId, isGuest]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, showPrevTickets]);

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Poll for agent messages
  useEffect(() => {
    if (!convId) return;
    // Only show agent messages sent after the widget opened
    const startedAt = Math.floor(Date.now() / 1000);
    lastAgentMsgTime.current = startedAt;

    const poll = async () => {
      const { messages: history, humanHandling, ticketStatus: polledStatus } = await fetchHistory(cfg, convId);

      // Track closed→open transition so we can reset stale UI state
      const polledClosed = polledStatus ? CLOSED_STATUSES.includes(polledStatus) : false;
      if (prevClosedRef.current && !polledClosed) {
        // Agent reopened a previously closed ticket — clear stale closure UI
        setAgentClosureRequest(false);
        setCsatPending(false);
      }
      prevClosedRef.current = polledClosed;
      setTicketStatus(polledStatus);

      // Check for a new resolve_request system message from agent
      const resolveRequestMsgs = history.filter(
        (m) => m.role === 'system' && m.content === '__resolve_request__' && m.created_at > lastAgentMsgTime.current
      );
      if (resolveRequestMsgs.length > 0) {
        lastAgentMsgTime.current = resolveRequestMsgs[resolveRequestMsgs.length - 1].created_at;
        setAgentClosureRequest(true);
        playNotificationBeep();
      }

      const newAgentMsgs = history.filter(
        (m) => m.role === 'agent' && m.created_at > lastAgentMsgTime.current
      );
      if (newAgentMsgs.length > 0) {
        lastAgentMsgTime.current = newAgentMsgs[newAgentMsgs.length - 1].created_at;
        playNotificationBeep();
        // Prefer identity already known from escalation response; fall back to message metadata
        const firstMsg = newAgentMsgs[0];
        setEscalated(true);
        const agentName = firstMsg.agent_name || 'Support Agent';
        const agent = {
          name: agentName,
          avatar: firstMsg.agent_avatar ?? agentName[0].toUpperCase(),
          avatarUrl: firstMsg.agent_avatar_url ?? null,
        };
        setEscalatedAgent(agent);
        storeSessionAgent(agent);
        if (firstMsg.agent_name) {
          setAgentConnectedBanner((prev) => prev ?? firstMsg.agent_name ?? null);
        }
        setTimeout(() => setAgentConnectedBanner(null), 7000);
        setMessages((prev) => [
          ...prev,
          ...newAgentMsgs.map((m) => ({
            id: `agent-${m.created_at}`,
            role: 'agent' as const,
            content: m.content,
            timestamp: m.created_at * 1000,
            agentName: m.agent_name,
            agentAvatar: m.agent_avatar,
            agentAvatarUrl: resolveUrl(m.agent_avatar_url) ?? undefined,
            attachments: m.attachments?.map(a => ({ id: a.id, url: a.url, name: a.name, mimeType: a.mime_type, size: a.size })),
          })),
        ]);
      } else if (humanHandling) {
        // Dashboard marked conversation as escalated but agent hasn't replied yet —
        // set escalated flag only; leave escalatedAgent null so the back button
        // stays visible and the "connecting" banner shows until a real agent replies.
        setEscalated(true);
      }
    };
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [convId, cfg]);

  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!convId) return;
    const arr = Array.from(files).slice(0, 5);
    const valid = arr.filter(f => ALLOWED_MIME.includes(f.type) && f.size <= MAX_FILE_SIZE);
    if (!valid.length) return;
    setUploadingFiles(true);
    try {
      const uploaded = await Promise.all(valid.map(f => uploadAttachment(cfg, f)));
      const attachments: MessageAttachment[] = uploaded.map(u => ({
        id: u.id, url: u.url, name: u.name, mimeType: u.mimeType, size: u.size,
      }));
      setPendingAttachments(prev => [...prev, ...attachments].slice(0, 5));
    } catch {
      // fail silently — user can retry
    } finally {
      setUploadingFiles(false);
    }
  }, [convId, cfg]);

  const send = useCallback(async (text: string, category?: string, skipUserBubble = false) => {
    setActivePills(null);
    const hasAttachments = pendingAttachments.length > 0;
    if (!text.trim() && !hasAttachments) return;
    if (!convId || loading) return;
    setError(null);

    const trimmed = text.trim();
    const attachmentsSnapshot = [...pendingAttachments];
    setPendingAttachments([]);

    if (!skipUserBubble) {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        attachments: attachmentsSnapshot.length ? attachmentsSnapshot : undefined,
      };
      setMessages((prev) => [...prev, userMsg]);
    }
    setInput('');
    setLoading(true);

    try {
      lastFailedText.current = '';
      const activeCategory = category ?? selectedCategory ?? undefined;
      const attachmentIds = attachmentsSnapshot.map(a => a.id);
      const result = await sendMessage(cfg, convId, trimmed, consecutiveLow, activeCategory, attachmentIds.length ? attachmentIds : undefined);
      setLang(result.language as 'en' | 'th');

      // reply is null when a human is already handling — suppress the bot bubble entirely
      if (result.reply !== null) {
        if (result.transitionMessage) {
          // 1. Show the outgoing agent's handoff notice — pinned to the current agent's identity
          await new Promise((r) => setTimeout(r, 900 + Math.random() * 400));
          playNotificationBeep();
          const outgoingName = botName;
          const outgoingAvatarUrl = botAvatarUrl;
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: result.transitionMessage!,
            timestamp: Date.now(),
            senderName: outgoingName ?? undefined,
            agentAvatarUrl: outgoingAvatarUrl ?? undefined,
          }]);

          // 2. Swap persona to the incoming specialist
          const incomingName = result.agentName ?? botName;
          const incomingAvatarUrl = result.agentAvatarUrl ?? null;
          if (result.agentName) {
            setBotName(incomingName);
            setBotAvatarUrl(incomingAvatarUrl);
            storeSessionBotInfo(incomingName!, incomingAvatarUrl);
          }

          // 3. Brief pause, then specialist's reply — pinned to specialist's identity
          await new Promise((r) => setTimeout(r, 2200 + Math.random() * 600));
          playNotificationBeep();
          const transitionMsgId = crypto.randomUUID();
          setMessages((prev) => [...prev, {
            id: transitionMsgId,
            role: 'assistant' as const,
            content: result.reply,
            timestamp: Date.now(),
            escalated: result.escalated,
            senderName: incomingName ?? undefined,
            agentAvatarUrl: incomingAvatarUrl ?? undefined,
          }]);
          if (result.quickReplies.length > 0 && !result.escalated && !result.offerResolution) {
            setActivePills({ msgId: transitionMsgId, pills: result.quickReplies });
          }
        } else {
          // Normal reply — pin current bot identity onto the bubble
          await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
          playNotificationBeep();
          const botMsgId = crypto.randomUUID();
          setMessages((prev) => [...prev, {
            id: botMsgId,
            role: 'assistant' as const,
            content: result.reply,
            timestamp: Date.now(),
            escalated: result.escalated,
            senderName: botName ?? undefined,
            agentAvatarUrl: botAvatarUrl ?? undefined,
          }]);
          if (result.quickReplies.length > 0 && !result.escalated && !result.offerResolution) {
            setActivePills({ msgId: botMsgId, pills: result.quickReplies });
          }
        }
      }

      if (result.offerResolution && !escalated) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: lang === 'th'
              ? 'ปัญหาของคุณได้รับการแก้ไขแล้วหรือยังคะ?'
              : 'Did this resolve your issue?',
            timestamp: Date.now(),
            offerResolution: true,
          },
        ]);
      }

      if (result.upgradedCategory) {
        // Update category state so future messages use the specialist's tools/overlay.
        // Persona swap is handled inside the transition animation block above.
        setSelectedCategory(result.upgradedCategory as IssueCategory);
        storeSessionCategory(result.upgradedCategory);
      }

      if (result.escalated) {
        setEscalated(true);
        setConsecutiveLow(0);
      } else {
        setConsecutiveLow(0);
      }
    } catch {
      lastFailedText.current = trimmed;
      setError(t.errorRetry);
      // Keep user message visible but mark error
    } finally {
      setLoading(false);
      setAwaitingFirstReply(false);
      inputRef.current?.focus();
    }
  }, [convId, loading, consecutiveLow, selectedCategory, cfg, t, pendingAttachments, botName, botAvatarUrl]);

  // Keep sendRef current so selectCategory can call send before it's in scope
  useEffect(() => { sendRef.current = send; }, [send]);

  const handleTalkToAgent = useCallback(() => {
    if (!selectedCategory) {
      setSelectedCategory('other' as IssueCategory);
      storeSessionCategory('other');
    }
    send(lang === 'th' ? 'ขอติดต่อเจ้าหน้าที่' : 'I need to speak to a human agent');
  }, [send, lang, selectedCategory]);

  const handleGoBack = useCallback(() => {
    prevCategoryRef.current = selectedCategory;
    setSelectedCategory(null);
    storeSessionCategory('');
    // Keep existing messages — append a pick-topic prompt so the category picker appears below history
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: lang === 'th' ? 'กรุณาเลือกประเภทปัญหาที่ต้องการความช่วยเหลือ:' : 'Please select the type of issue you need help with:',
      timestamp: Date.now(),
      senderName: 'Bitazza Support',
    }]);
    setEscalated(false);
    setEscalatedAgent(null);
    setAwaitingFirstReply(false);
    setResolutionRejections(0);
    setConsecutiveLow(0);
    setBotName(null);
    setBotAvatarUrl(null);
    setError(null);
    setInput('');
    setPendingAttachments([]);
  }, [selectedCategory, lang]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const primaryColor = cfg.primaryColor ?? '#00CE80';

  return (
    <div className="csbot-window flex flex-col rounded-2xl overflow-hidden" style={{ width: 384, height: 'min(624px, calc(100vh - 116px))' }}>
      {/* Header — Bitazza: flat Background Color/950 dark surface */}
      <div
        className="csbot-header flex items-center justify-between px-4 py-3"
        style={{ background: '#090916', borderBottom: '1px solid #2C2C53' }}
      >
        {/* Who — left-aligned avatar + name/status */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {messages.length > 0 && langSelected && !escalatedAgent ? (
            <button
              onClick={handleGoBack}
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors"
              style={{ background: '#2C2C53', border: '1px solid #13132C', color: 'rgba(255,255,255,1)' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#13132C')}
              onMouseLeave={e => (e.currentTarget.style.background = '#2C2C53')}
              aria-label="Go back to topics"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          ) : null}
          {/* Avatar 36×36 */}
          <div className="w-9 h-9 rounded-full flex items-center justify-center font-extrabold text-[15px] overflow-hidden shrink-0" style={{ background: '#00CE80', color: '#1B1A18' }}>
            {escalatedAgent ? (
              escalatedAgent.avatarUrl ? (
                <img src={escalatedAgent.avatarUrl} alt={escalatedAgent.name} className="w-full h-full object-cover" />
              ) : (
                escalatedAgent.avatar
              )
            ) : 'B'}
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[15px] leading-tight truncate" style={{ color: 'rgba(255,255,255,1)' }}>{escalatedAgent?.name ?? 'Bitazza Support'}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={"w-[7px] h-[7px] rounded-full shrink-0" + (escalatedAgent ? " animate-pulse" : "")} style={{ backgroundColor: '#10F48B' }} />
              <span className="text-[11.5px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
                {escalatedAgent ? 'Live agent — connected' : 'Online — typically replies instantly'}
              </span>
            </div>
          </div>
        </div>
        {/* Close button */}
        <button
          onClick={onClose}
          className="w-[30px] h-[30px] rounded-full flex items-center justify-center shrink-0 transition-colors"
          style={{ background: '#2C2C53', border: '1px solid #13132C', color: 'rgba(255,255,255,1)' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#13132C')}
          onMouseLeave={e => (e.currentTarget.style.background = '#2C2C53')}
          aria-label="Close"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Escalation banner */}
      {(escalated && !escalatedAgent) || agentConnectedBanner ? (
        <div className="csbot-escalation-banner px-4 py-2 text-xs flex items-center justify-center gap-2">
          {agentConnectedBanner ? (
            <>
              {escalatedAgent?.avatarUrl ? (
                <img src={escalatedAgent.avatarUrl} alt={escalatedAgent.name} className="w-5 h-5 rounded-full" />
              ) : (
                <span className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px]" style={{ background: '#F4B72A', color: '#1B1A18' }}>
                  {escalatedAgent?.avatar ?? agentConnectedBanner[0].toUpperCase()}
                </span>
              )}
              <span><strong>{agentConnectedBanner}</strong> is connected</span>
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
              </svg>
              <span>{t.escalationBanner}</span>
            </>
          )}
        </div>
      ) : null}

      {/* Open ticket banner — shown after lang selection if customer has an unresolved ticket */}
      {showOpenTicketBanner && openTicket && (
        <div data-testid="open-ticket-banner" className="px-4 py-3" style={{ background: '#FEF8EA', borderBottom: '1px solid #F4B72A' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#705514' }}>
            {lang === 'th'
              ? `คุณมีการสนทนา "${CATEGORY_LABEL_SHORT[openTicket.category]?.[lang] ?? openTicket.category}" ที่ยังค้างอยู่ (${relativeDate(openTicket.created_at, lang)})`
              : `You have an open "${CATEGORY_LABEL_SHORT[openTicket.category]?.[lang] ?? openTicket.category}" conversation from ${relativeDate(openTicket.created_at, lang)}`
            }
          </p>
          <div className="flex gap-2">
            <button
              data-testid="continue-ticket-btn"
              onClick={() => {
                setShowOpenTicketBanner(false);
                setConvId(openTicket.id);
                setSelectedCategory(openTicket.category as IssueCategory);
                // Load history for the resumed ticket
                fetchHistory(cfg, openTicket.id).then(({ messages: history, humanHandling }) => {
                  const restored: Message[] = history.map((m) => ({
                    id: `restored-${m.created_at}`,
                    role: m.role as Message['role'],
                    content: m.content,
                    timestamp: m.created_at * 1000,
                    agentName: m.agent_name ?? undefined,
                    agentAvatar: m.agent_avatar ?? undefined,
                    agentAvatarUrl: m.agent_avatar_url ?? undefined,
                  }));
                  setMessages(restored);
                  if (humanHandling) {
                    setEscalated(true);
                    setEscalatedAgent({ name: 'Support Agent', avatar: 'S', avatarUrl: null });
                  }
                });
              }}
              className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
              style={{ background: '#00CE80', color: '#1B1A18' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#079755')}
              onMouseLeave={e => (e.currentTarget.style.background = '#00CE80')}
            >
              {lang === 'th' ? 'ดำเนินการต่อ' : 'Continue it'}
            </button>
            <button
              data-testid="start-new-btn"
              onClick={() => {
                setShowOpenTicketBanner(false);
                setMessages((prev) => [...prev, {
                  id: 'category-prompt',
                  role: 'assistant',
                  content: CATEGORY_PROMPT[lang],
                  timestamp: Date.now(),
                  senderName: 'Bitazza Support',
                }]);
              }}
              className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
              style={{ background: '#FFFFFF', border: '1px solid #F4B72A', color: '#705514' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#FEF8EA')}
              onMouseLeave={e => (e.currentTarget.style.background = '#FFFFFF')}
            >
              {lang === 'th' ? 'เริ่มใหม่' : 'Start new'}
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="csbot-messages flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {showGuestForm && (
          <GuestIdentityForm primaryColor={primaryColor} onSubmit={handleGuestFormSubmit} />
        )}
        {!showGuestForm && showPrevTickets && !isGuest && (
          <PrevConversations
            tickets={prevTickets}
            cfg={cfg}
            lang={lang}
            primaryColor={primaryColor}
          />
        )}
        {/* Messages + announcement cards interleaved:
            Find the category-prompt message by ID and splice announcement cards
            immediately before it — so they stay pinned at that position for the
            entire conversation, even after the user has selected a category. */}
        {!showGuestForm && (() => {
          const visibleAnnouncements = langSelected
            ? announcements.filter(a => !dismissedAnnIds.has(a.id))
            : [];
          const annCards = visibleAnnouncements.map((a, idx) => {
            const accentColor = a.color || primaryColor;
            return (
              <div
                key={a.id}
                ref={idx === 0 ? annRef : undefined}
                style={{
                  margin: '4px 0 40px',
                  borderRadius: 12,
                  background: '#ffffff',
                  border: '1px solid #EDEDF8',
                  borderLeft: `3px solid ${accentColor}`,
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: '10px 12px 11px 11px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: '#1B1A18', lineHeight: '20px', margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M22 4 12 8H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1l2 5h2l-1-5h2l10 4V4z"/>
                      </svg>
                      {lang === 'th' ? a.title_th : a.title_en}
                    </p>
                    <button
                      onClick={() => setDismissedAnnIds(prev => new Set([...prev, a.id]))}
                      style={{
                        flexShrink: 0,
                        width: 20, height: 20, borderRadius: 6,
                        background: '#FCFCFE',
                        border: '1px solid #EDEDF8',
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'rgba(27,26,24,0.4)', transition: 'background 0.15s, border-color 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#EDEDF8'; e.currentTarget.style.borderColor = '#D8D8EC'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#FCFCFE'; e.currentTarget.style.borderColor = '#EDEDF8'; }}
                      aria-label="Dismiss"
                    >
                      <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M1 1l10 10M11 1L1 11"/>
                      </svg>
                    </button>
                  </div>
                  {(() => {
                    const body = lang === 'th' ? a.body_th : a.body_en;
                    return isHtml(body)
                      ? <div
                          className="csbot-rich-text"
                          style={{ fontSize: 14, color: 'rgba(27,26,24,0.65)', lineHeight: '20px', margin: 0 }}
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body, SANITIZE_CONFIG) }}
                        />
                      : <p style={{ fontSize: 14, color: 'rgba(27,26,24,0.65)', lineHeight: '20px', margin: 0 }}>{body}</p>;
                  })()}
                </div>
              </div>
            );
          });

          // Splice announcements immediately before the category-prompt message so
          // they stay pinned there for the whole conversation.
          const categoryPromptIdx = messages.findIndex(m => m.id === 'category-prompt');
          if (visibleAnnouncements.length === 0 || categoryPromptIdx === -1) {
            return messages.map((m) => <MessageBubble key={m.id} message={m} primaryColor={primaryColor} botName={botName} botAvatarUrl={botAvatarUrl} escalatedAgent={escalatedAgent} activePills={activePills?.msgId === m.id ? activePills.pills : undefined} onPillTap={send} />);
          }
          const before = messages.slice(0, categoryPromptIdx);
          const after = messages.slice(categoryPromptIdx);
          return (
            <>
              {before.map((m) => <MessageBubble key={m.id} message={m} primaryColor={primaryColor} botName={botName} botAvatarUrl={botAvatarUrl} escalatedAgent={escalatedAgent} activePills={activePills?.msgId === m.id ? activePills.pills : undefined} onPillTap={send} />)}
              {annCards}
              {after.map((m) => <MessageBubble key={m.id} message={m} primaryColor={primaryColor} botName={botName} botAvatarUrl={botAvatarUrl} escalatedAgent={escalatedAgent} activePills={activePills?.msgId === m.id ? activePills.pills : undefined} onPillTap={send} />)}
            </>
          );
        })()}
        {(() => {
          const lastResMsg = [...messages].reverse().find((m) => m.offerResolution);
          if (!lastResMsg || csatPending || isTicketClosed) return null;
          if (messages[messages.length - 1]?.id !== lastResMsg.id) return null;
          return (
            <div className="flex gap-2 justify-center pt-1 pb-2">
              <button
                onClick={() => setCsatPending(true)}
                className="px-5 py-2 rounded-full text-xs font-semibold transition-colors"
                style={{ background: '#00CE80', color: '#1B1A18' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#079755')}
                onMouseLeave={e => (e.currentTarget.style.background = '#00CE80')}
              >
                {lang === 'th' ? '✓ แก้ไขแล้ว' : '✓ Yes, resolved'}
              </button>
              <button
                onClick={() => {
                  const newCount = resolutionRejections + 1;
                  setResolutionRejections(newCount);
                  if (newCount >= 2) {
                    setMessages((prev) => prev.map((m) =>
                      m.id === lastResMsg.id ? { ...m, offerResolution: false } : m
                    ));
                    send(lang === 'th' ? 'ขอคุยกับเจ้าหน้าที่' : 'I need to speak to a human agent');
                  } else {
                    setMessages((prev) => prev.map((m) =>
                      m.id === lastResMsg.id
                        ? { ...m, offerResolution: false, content: lang === 'th' ? 'ขอโทษที่ยังไม่ได้ช่วยแก้ปัญหา กรุณาอธิบายปัญหาเพิ่มเติมได้เลยค่ะ' : 'Sorry to hear that! Please describe what\'s still not resolved and I\'ll do my best to help.' }
                        : m
                    ));
                  }
                }}
                className="px-5 py-2 rounded-full text-xs font-semibold transition-colors"
                style={{ background: '#FCFCFE', color: '#1B1A18', border: '1px solid #EDEDF8' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#EDEDF8')}
                onMouseLeave={e => (e.currentTarget.style.background = '#FCFCFE')}
              >
                {lang === 'th' ? '✗ ยังไม่แก้ไข' : '✗ No, I need more help'}
              </button>
            </div>
          );
        })()}
        {/* Agent-initiated closure confirmation */}
        {agentClosureRequest && !csatPending && !isTicketClosed && (
          <div className="flex flex-col items-center gap-2 py-3 px-2">
            <p className="text-sm font-medium text-center" style={{ color: 'rgba(27,26,24,0.75)' }}>
              {lang === 'th'
                ? `${escalatedAgent?.name ?? 'เจ้าหน้าที่'} ต้องการปิดการสนทนานี้ ปัญหาของคุณได้รับการแก้ไขแล้วหรือยังคะ?`
                : `${escalatedAgent?.name ?? 'Your agent'} is closing this conversation. Was your issue resolved?`}
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => {
                  setAgentClosureRequest(false);
                  setCsatPending(true);
                }}
                className="px-5 py-2 rounded-full text-xs font-semibold transition-colors"
                style={{ background: '#00CE80', color: '#1B1A18' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#079755')}
                onMouseLeave={e => (e.currentTarget.style.background = '#00CE80')}
              >
                {lang === 'th' ? '✓ แก้ไขแล้ว' : '✓ Yes, resolved'}
              </button>
              <button
                onClick={() => {
                  // Dismiss prompt — conversation stays open with human agent, AI stays silent
                  setAgentClosureRequest(false);
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: 'assistant' as const,
                      content: lang === 'th'
                        ? 'ได้รับทราบค่ะ เจ้าหน้าที่จะดูแลต่อ'
                        : 'Understood. Your agent will continue assisting you.',
                      timestamp: Date.now(),
                      senderName: escalatedAgent?.name ?? 'Support Agent',
                      agentAvatarUrl: escalatedAgent?.avatarUrl ?? undefined,
                    },
                  ]);
                }}
                className="px-5 py-2 rounded-full text-xs font-semibold transition-colors"
                style={{ background: '#FCFCFE', color: '#1B1A18', border: '1px solid #EDEDF8' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#EDEDF8')}
                onMouseLeave={e => (e.currentTarget.style.background = '#FCFCFE')}
              >
                {lang === 'th' ? '✗ ยังไม่แก้ไข' : '✗ No, I need more help'}
              </button>
            </div>
          </div>
        )}

        {csatPending && !csatSubmitted && (
          <div className="flex flex-col items-center gap-3 py-4 px-2">
            <p className="text-sm font-medium text-center" style={{ color: 'rgba(27,26,24,0.75)' }}>
              {lang === 'th' ? 'กรุณาให้คะแนนประสบการณ์การบริการของคุณ' : 'Please rate your support experience'}
            </p>
            <div className="flex gap-1" onMouseLeave={() => setCsatHover(0)}>
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onMouseEnter={() => setCsatHover(star)}
                  onClick={async () => {
                    if (!convId) return;
                    try {
                      await fetch(`${cfg.apiUrl}/chat/csat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
                        body: JSON.stringify({ ticket_id: convId, score: star }),
                      });
                    } catch { /* non-critical */ }
                    setCsatSubmitted(true);
                    clearStoredSession();
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: crypto.randomUUID(),
                        role: 'assistant' as const,
                        content: lang === 'th'
                          ? 'ขอบคุณสำหรับคะแนนของคุณ! ดีใจที่ได้ช่วยเหลือค่ะ 😊'
                          : 'Thanks for your feedback! Glad we could help 😊',
                        timestamp: Date.now(),
                      },
                    ]);
                  }}
                  style={{
                    fontSize: 30,
                    lineHeight: 1,
                    padding: '0 2px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    filter: star <= csatHover ? 'none' : 'grayscale(1) opacity(0.4)',
                    transform: star <= csatHover ? 'scale(1.12)' : 'scale(1)',
                    transition: 'filter 0.12s ease, transform 0.12s ease',
                  }}
                  aria-label={`${star} star`}
                >
                  ⭐
                </button>
              ))}
            </div>
          </div>
        )}
        {isTicketClosed && (
          <div className="text-center text-xs py-2" style={{ color: 'rgba(27,26,24,0.5)' }}>
            {lang === 'th' ? 'การสนทนานี้ปิดแล้ว' : 'This conversation is closed.'}
          </div>
        )}
        {!showGuestForm && !langSelected && (
          <div className="flex gap-2 pt-2 pb-1">
            <button
              onClick={() => selectLanguage('en')}
              disabled={!cfg.guestMode && !convId}
              className="csbot-lang-btn flex-1 py-2.5 text-xs font-semibold"
            >
              🇬🇧 English
            </button>
            <button
              onClick={() => selectLanguage('th')}
              disabled={!cfg.guestMode && !convId}
              className="csbot-lang-btn flex-1 py-2.5 text-xs font-semibold"
            >
              🇹🇭 ภาษาไทย
            </button>
          </div>
        )}
        {!showGuestForm && !isGuest && langSelected && !selectedCategory && !escalated && !showOpenTicketBanner && (
          <CategoryPicker
            lang={lang}
            primaryColor={primaryColor}
            onSelect={selectCategory}
            disabled={loading || !convId}
          />
        )}
        {!showGuestForm && loading && <TypingIndicator />}
        {!showGuestForm && error && (
          <button
            className="w-full text-center text-xs text-red-400 py-2 hover:text-red-500 transition-colors"
            onClick={() => send(lastFailedText.current)}
          >
            ↻ {error}
          </button>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Request human support pill — visible once conversation has started, until a human agent connects */}
      {messages.length > 0 && langSelected && !escalatedAgent && !csatPending && !isTicketClosed && !agentClosureRequest && (
        <div className="flex justify-center px-4 py-2 bg-white" style={{ borderTop: '1px solid #EDEDF8' }}>
          <button
            onClick={handleTalkToAgent}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={{ background: '#F0FEF8', border: '1px solid #00CE80', color: '#079755' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#00CE80'; e.currentTarget.style.color = '#ffffff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#F0FEF8'; e.currentTarget.style.color = '#079755'; }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            {lang === 'th' ? 'ขอติดต่อเจ้าหน้าที่' : 'Request human support'}
          </button>
        </div>
      )}

      {/* Input */}
      <div
        className={`csbot-input-area px-3 py-3 flex flex-col gap-2${isDragOver ? ' ring-2 ring-inset ring-[#00CE80]' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); handleFiles(e.clipboardData.files); } }}
      >
        {/* Pending attachment previews */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1">
            {pendingAttachments.map((a) => (
              <div key={a.id} className="relative group">
                {a.mimeType.startsWith('image/') ? (
                  <img src={a.url} alt={a.name} className="w-14 h-14 object-cover rounded-lg" style={{ border: '1px solid #EDEDF8' }} />
                ) : (
                  <div className="w-14 h-14 flex items-center justify-center rounded-lg text-[10px] text-center px-1 break-all" style={{ border: '1px solid #EDEDF8', background: '#FCFCFE', color: 'rgba(27,26,24,0.5)' }}>{a.name}</div>
                )}
                <button
                  className="absolute -top-1 -right-1 w-4 h-4 bg-gray-700 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setPendingAttachments(prev => prev.filter(x => x.id !== a.id))}
                  aria-label="Remove attachment"
                >×</button>
              </div>
            ))}
            {uploadingFiles && <div className="w-14 h-14 flex items-center justify-center rounded-lg text-[10px]" style={{ border: '1px solid #EDEDF8', background: '#FCFCFE', color: 'rgba(27,26,24,0.4)' }}>...</div>}
          </div>
        )}
        <div className="flex gap-2 items-center">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) { handleFiles(e.target.files); e.target.value = ''; } }}
          />
          {/* Paperclip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={showGuestForm || !convId || !langSelected || (!isGuest && !selectedCategory) || awaitingFirstReply || csatPending || isTicketClosed || agentClosureRequest}
            className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-30 flex-shrink-0"
            aria-label="Attach file"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={!langSelected ? 'Select a language / เลือกภาษา' : (!isGuest && !selectedCategory) ? (lang === 'th' ? 'เลือกประเภทปัญหาด้านบน' : 'Select an issue type above') : awaitingFirstReply ? t.placeholderConnecting : t.placeholder}
            disabled={showGuestForm || loading || !convId || !langSelected || (!isGuest && !selectedCategory) || awaitingFirstReply || csatPending || isTicketClosed || agentClosureRequest}
            className="csbot-input flex-1 text-sm px-4 py-2.5 outline-none disabled:opacity-40"
          />
          <button
            onClick={() => send(input)}
            disabled={showGuestForm || loading || (!input.trim() && !pendingAttachments.length) || !convId || !langSelected || (!isGuest && !selectedCategory) || awaitingFirstReply || csatPending || isTicketClosed || agentClosureRequest}
            className="csbot-send-btn w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: primaryColor }}
            aria-label={t.send}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1B1A18" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Footer branding */}
      <div className="csbot-footer text-center py-1.5 text-[10px]">
        Powered by <span className="font-semibold">Bitazza</span>
      </div>
    </div>
  );
}
