import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, CSBotConfig, IssueCategory } from './types';
import { ISSUE_CATEGORIES } from './types';
import { startConversation, sendMessage, fetchHistory, setCategoryAgent, getStoredSession, storeSessionLang, storeSessionCategory, storeSessionAgent, clearStoredSession, fetchCustomerTickets, fetchOpenTicket, getStoredCustomerId } from './api';
import type { PastTicket } from './api';
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
  },
  th: {
    placeholder: 'พิมพ์ข้อความของคุณ...',
    placeholderConnecting: 'กรุณารอการตอบกลับจากเจ้าหน้าที่...',
    send: 'ส่ง',
    header: 'ฝ่ายสนับสนุน',
    escalationBanner: 'กำลังเชื่อมต่อกับเจ้าหน้าที่สนับสนุน...',
    errorRetry: 'ส่งไม่สำเร็จ แตะเพื่อลองใหม่',
    welcome: 'สวัสดีค่ะ! 😊 วันนี้มีอะไรให้ช่วยได้บ้างคะ?',
  },
};


interface Props {
  cfg: CSBotConfig;
  onClose: () => void;
}

export default function ChatWindow({ cfg, onClose }: Props) {
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
  const [agentClosureRequest, setAgentClosureRequest] = useState(false);
  const [prevTickets, setPrevTickets] = useState<PastTicket[]>([]);
  const [showPrevTickets, setShowPrevTickets] = useState(false);
  const [openTicket, setOpenTicket] = useState<PastTicket | null>(null);
  const [showOpenTicketBanner, setShowOpenTicketBanner] = useState(false);
  const [awaitingFirstReply, setAwaitingFirstReply] = useState(false);
  const [isGuest, setIsGuest] = useState<boolean>(cfg.guestMode ?? false);
  const [showGuestForm, setShowGuestForm] = useState<boolean>(false);
  const lastAgentMsgTime = useRef(0);
  const lastFailedText = useRef('');
  const sendRef = useRef<((text: string, category?: string, skipUserBubble?: boolean) => Promise<void>) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = UI_TEXT[lang];

  // Init conversation — restore if session exists, otherwise start fresh
  useEffect(() => {
    const existing = getStoredSession();
    if (existing) {
      // Resume: load history from backend
      setConvId(existing.id);
      if (existing.isGuest) setIsGuest(true);
      // Restore lang selection from session if available
      if (existing.lang) {
        setLang(existing.lang);
        setLangSelected(true);
      }
      // Restore category from session if available
      if (existing.category) {
        setSelectedCategory(existing.category as IssueCategory);
      }
      fetchHistory(cfg, existing.id).then(({ messages: history, humanHandling }) => {
        if (history.length === 0) {
          // Session exists but no messages — show greeting
          showGreeting();
          if (existing.lang) setLangSelected(false); // reset so lang picker shows again
          return;
        }
        // Always use the latest agent message from history as ground truth
        const firstAgentMsg = history.find((m) => m.role === 'agent');
        const restoredAgent = firstAgentMsg?.agent_name ? {
          name: firstAgentMsg.agent_name,
          avatar: firstAgentMsg.agent_avatar ?? firstAgentMsg.agent_name[0].toUpperCase(),
          avatarUrl: firstAgentMsg.agent_avatar_url ?? null,
        } : (existing.agent ?? null);
        if (restoredAgent) {
          setEscalated(true);
          setEscalatedAgent(restoredAgent);
        } else if (humanHandling) {
          // Human has taken over from dashboard but hasn't replied yet — dismiss the "connecting" banner
          setEscalated(true);
          setEscalatedAgent({ name: 'Support Agent', avatar: 'S', avatarUrl: null });
        }
        const restored: Message[] = history.map((m) => ({
          id: `restored-${m.created_at}`,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: m.created_at * 1000,
          agentName: m.agent_name ?? restoredAgent?.name,
          agentAvatar: m.agent_avatar ?? restoredAgent?.avatar,
          agentAvatarUrl: m.agent_avatar_url ?? restoredAgent?.avatarUrl ?? undefined,
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
          .catch(() => setError('Could not connect. Please refresh.'));
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
          const resolvedName = agentName ?? 'Ploy';
          setBotName(resolvedName);
          setBotAvatarUrl(agentAvatarUrl || null);
          setTimeout(() => {
            const greeting = lang === 'th'
              ? `สวัสดีค่ะ ฉันชื่อ${resolvedName}! 😊 มีอะไรให้ช่วยได้บ้างคะ?`
              : `Hi, I'm ${resolvedName}! 😊 How can I help you today?`;
            setMessages((prev) => [...prev, {
              id: 'ploy-intro',
              role: 'assistant' as const,
              content: greeting,
              timestamp: Date.now(),
              senderName: resolvedName,
              agentAvatarUrl: agentAvatarUrl || undefined,
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
    en: (name: string) => `Hi, I'm ${name}! 👋 Let me pull up your account details and I'll have an answer for you in just a moment.`,
    th: (name: string) => `สวัสดีค่ะ ฉันชื่อ${name}! 👋 กำลังดึงข้อมูลบัญชีของคุณ รอสักครู่นะคะ`,
  };

  const selectCategory = useCallback((category: IssueCategory) => {
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
      setCategoryAgent(cfg, convId, category).then(({ agentName, agentAvatarUrl }) => {
        const resolvedName = agentName ?? 'Support Agent';
        setBotName(resolvedName);
        setBotAvatarUrl(agentAvatarUrl || null);

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
        sendRef.current?.(openingMsg, category, true);
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
      const { messages: history, humanHandling } = await fetchHistory(cfg, convId);

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
            agentAvatarUrl: m.agent_avatar_url ?? undefined,
          })),
        ]);
      } else if (humanHandling) {
        // Dashboard marked conversation as escalated but agent hasn't replied yet —
        // dismiss the "connecting" spinner banner without waiting for a message.
        setEscalated(true);
        setEscalatedAgent((prev) => prev ?? { name: 'Support Agent', avatar: 'S', avatarUrl: null });
      }
    };
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [convId, cfg]);

  const send = useCallback(async (text: string, category?: string, skipUserBubble = false) => {
    if (!text.trim() || !convId || loading) return;
    setError(null);

    const trimmed = text.trim();
    if (!skipUserBubble) {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
    }
    setInput('');
    setLoading(true);

    try {
      lastFailedText.current = '';
      const activeCategory = category ?? selectedCategory ?? undefined;
      const result = await sendMessage(cfg, convId, trimmed, consecutiveLow, activeCategory);
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
          }

          // 3. Brief pause, then specialist's reply — pinned to specialist's identity
          await new Promise((r) => setTimeout(r, 2200 + Math.random() * 600));
          playNotificationBeep();
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: result.reply,
            timestamp: Date.now(),
            escalated: result.escalated,
            senderName: incomingName ?? undefined,
            agentAvatarUrl: incomingAvatarUrl ?? undefined,
          }]);
        } else {
          // Normal reply — pin current bot identity onto the bubble
          await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
          playNotificationBeep();
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: result.reply,
            timestamp: Date.now(),
            escalated: result.escalated,
            senderName: botName ?? undefined,
            agentAvatarUrl: botAvatarUrl ?? undefined,
          }]);
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
  }, [convId, loading, consecutiveLow, selectedCategory, cfg, t]);

  // Keep sendRef current so selectCategory can call send before it's in scope
  useEffect(() => { sendRef.current = send; }, [send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const primaryColor = cfg.primaryColor ?? '#6366f1';

  return (
    <div className="csbot-window flex flex-col w-[380px] h-[560px] rounded-2xl overflow-hidden">
      {/* Header */}
      <div
        className="csbot-header flex items-center justify-between px-4 py-3 text-white relative overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}cc 100%)` }}
      >
        {/* subtle shine overlay */}
        <div className="absolute inset-0 bg-white/5 pointer-events-none" />
        <div className="relative flex items-center gap-3">
          <div className="csbot-avatar-ring w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm overflow-hidden">
            {escalatedAgent ? (
              escalatedAgent.avatarUrl ? (
                <img src={escalatedAgent.avatarUrl} alt={escalatedAgent.name} className="w-full h-full object-cover" />
              ) : (
                escalatedAgent.avatar
              )
            ) : botName ? botName[0].toUpperCase() : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.414 2.798H4.213c-1.444 0-2.414-1.798-1.414-2.798L4.2 15.3" />
              </svg>
            )}
          </div>
          <div>
            <div className="font-semibold text-sm leading-tight">{escalatedAgent?.name ?? botName ?? t.header}</div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
              <span className="text-white/70 text-[10px]">
                {escalatedAgent ? 'Live agent — connected' : 'Online — typically replies instantly'}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="relative w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
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
              ) : escalatedAgent?.avatar ? (
                <span className="w-5 h-5 rounded-full bg-amber-400 text-white flex items-center justify-center font-bold text-[10px]">
                  {escalatedAgent.avatar}
                </span>
              ) : null}
              <span><strong>{agentConnectedBanner}</strong> is connected</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
              </svg>
              <span>{t.escalationBanner}</span>
            </>
          )}
        </div>
      ) : null}

      {/* Open ticket banner — shown after lang selection if customer has an unresolved ticket */}
      {showOpenTicketBanner && openTicket && (
        <div data-testid="open-ticket-banner" className="px-4 py-3 bg-amber-50 border-b border-amber-100">
          <p className="text-xs text-amber-800 font-medium mb-2">
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
              className="px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors"
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
              className="px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors"
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
        {!showGuestForm && messages.map((m) => <MessageBubble key={m.id} message={m} primaryColor={primaryColor} botName={botName} botAvatarUrl={botAvatarUrl} escalatedAgent={escalatedAgent} />)}
        {(() => {
          const lastResMsg = [...messages].reverse().find((m) => m.offerResolution);
          if (!lastResMsg || csatPending || csatSubmitted) return null;
          if (messages[messages.length - 1]?.id !== lastResMsg.id) return null;
          return (
            <div className="flex gap-2 justify-center pt-1 pb-2">
              <button
                onClick={() => setCsatPending(true)}
                className="px-5 py-2 rounded-full text-xs font-semibold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
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
                className="px-5 py-2 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                {lang === 'th' ? '✗ ยังไม่แก้ไข' : '✗ No, I need more help'}
              </button>
            </div>
          );
        })()}
        {/* Agent-initiated closure confirmation */}
        {agentClosureRequest && !csatPending && !csatSubmitted && (
          <div className="flex flex-col items-center gap-2 py-3 px-2">
            <p className="text-sm text-gray-600 font-medium text-center">
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
                className="px-5 py-2 rounded-full text-xs font-semibold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
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
                className="px-5 py-2 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
              >
                {lang === 'th' ? '✗ ยังไม่แก้ไข' : '✗ No, I need more help'}
              </button>
            </div>
          </div>
        )}

        {csatPending && !csatSubmitted && (
          <div className="flex flex-col items-center gap-3 py-4 px-2">
            <p className="text-sm text-gray-600 font-medium text-center">
              {lang === 'th' ? 'กรุณาให้คะแนนประสบการณ์การบริการของคุณ' : 'Please rate your support experience'}
            </p>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
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
                  className="text-3xl hover:scale-110 transition-transform"
                  aria-label={`${star} star`}
                >
                  ⭐
                </button>
              ))}
            </div>
          </div>
        )}
        {csatSubmitted && (
          <div className="text-center text-xs text-gray-400 py-2">
            {lang === 'th' ? 'การสนทนานี้ปิดแล้ว' : 'This conversation is closed.'}
          </div>
        )}
        {!showGuestForm && !langSelected && (
          <div className="flex gap-2 justify-center pt-2 pb-1">
            <button
              onClick={() => selectLanguage('en')}
              disabled={!cfg.guestMode && !convId}
              className="csbot-lang-btn px-5 py-2 rounded-full text-xs font-semibold transition-all disabled:opacity-40"
              style={{ '--lang-color': primaryColor } as React.CSSProperties}
            >
              🇬🇧 English
            </button>
            <button
              onClick={() => selectLanguage('th')}
              disabled={!cfg.guestMode && !convId}
              className="csbot-lang-btn px-5 py-2 rounded-full text-xs font-semibold transition-all disabled:opacity-40"
              style={{ '--lang-color': primaryColor } as React.CSSProperties}
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

      {/* Input */}
      <div className="csbot-input-area px-3 py-3 flex gap-2 items-center">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={!langSelected ? 'Select a language / เลือกภาษา' : (!isGuest && !selectedCategory) ? (lang === 'th' ? 'เลือกประเภทปัญหาด้านบน' : 'Select an issue type above') : awaitingFirstReply ? t.placeholderConnecting : t.placeholder}
          disabled={showGuestForm || loading || !convId || !langSelected || (!isGuest && !selectedCategory) || awaitingFirstReply || csatPending || csatSubmitted || agentClosureRequest}
          className="csbot-input flex-1 text-sm px-4 py-2.5 outline-none disabled:opacity-40"
        />
        <button
          onClick={() => send(input)}
          disabled={showGuestForm || loading || !input.trim() || !convId || !langSelected || (!isGuest && !selectedCategory) || awaitingFirstReply || csatPending || csatSubmitted || agentClosureRequest}
          className="csbot-send-btn w-9 h-9 rounded-full flex items-center justify-center text-white transition-all disabled:opacity-30"
          style={{ background: `linear-gradient(135deg, ${primaryColor}, ${primaryColor}cc)` }}
          aria-label={t.send}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>

      {/* Footer branding */}
      <div className="csbot-footer text-center py-1.5 text-[10px]">
        Powered by <span className="font-semibold">CS Bot</span>
      </div>
    </div>
  );
}
