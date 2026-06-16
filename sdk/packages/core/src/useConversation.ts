import { useState, useEffect, useCallback, useRef } from 'react';
import type { CSBotSDKConfig, IssueCategory, Message, AgentIdentity, AttachmentMeta, PastTicket, Announcement, WsConnectionState, WsInboundMessage, ConversationState, ConversationActions } from './types';
import type { StorageAdapter } from './storage';
import {
  getStoredSession, storeSession, clearStoredSession,
  getStoredCustomerId, storeSessionLang, storeSessionCategory,
  storeSessionAgent, storeSessionBotInfo,
} from './session';
import {
  startConversation, sendMessage, setCategoryAgent, greetConversation,
  fetchHistory, fetchCustomerTickets, fetchOpenTicket, fetchAnnouncements,
  emergencyEscalate, uploadAttachment, submitCsat as apiSubmitCsat,
  exchangeBootstrapToken, sendClientLog, HistoryMessage,
} from './api';
import { ConversationSocket } from './ws';

const CLOSED_STATUSES = ['Closed_Resolved', 'Closed_Unresponsive'];
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function makeId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function resolveUrl(url: string | null | undefined, apiUrl: string): string | null {
  if (!url) return null;
  return url.startsWith('/') ? `${apiUrl}${url}` : url;
}

function mapHistory(
  history: HistoryMessage[],
  apiUrl: string,
): Message[] {
  return history.map((m, idx) => ({
    id: `restored-${m.created_at}-${idx}`,
    role: m.role as Message['role'],
    content: m.content,
    timestamp: m.created_at * 1000,
    agentName: m.agent_name,
    agentAvatar: m.agent_avatar,
    agentAvatarUrl: resolveUrl(m.agent_avatar_url, apiUrl) ?? undefined,
    attachments: m.attachments?.map((a) => ({
      id: a.id, url: a.url, name: a.name, mimeType: a.mime_type, size: a.size,
    })),
  }));
}

export function useConversation(
  cfg: CSBotSDKConfig,
  storage: StorageAdapter,
): ConversationState & ConversationActions {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [lang, setLang] = useState<string>(cfg.lang ?? 'en');
  const [langSelected, setLangSelected] = useState(!!cfg.lang);
  const [selectedCategory, setSelectedCategory] = useState<IssueCategory | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [escalatedAgent, setEscalatedAgent] = useState<AgentIdentity | null>(null);
  const [agentConnectedBanner, setAgentConnectedBanner] = useState<string | null>(null);
  const [botName, setBotName] = useState<string | null>(null);
  const [botAvatarUrl, setBotAvatarUrl] = useState<string | null>(null);
  const [csatPending, setCsatPending] = useState(false);
  const [csatSubmitted, setCsatSubmitted] = useState(false);
  const [prevTickets, setPrevTickets] = useState<PastTicket[]>([]);
  const [showPrevTickets, setShowPrevTickets] = useState(false);
  const [openTicket, setOpenTicket] = useState<PastTicket | null>(null);
  const [showOpenTicketBanner, setShowOpenTicketBanner] = useState(false);
  const [awaitingFirstReply, setAwaitingFirstReply] = useState(false);
  const [isGuest, setIsGuest] = useState<boolean>(cfg.guestMode ?? false);
  const [showGuestForm, setShowGuestForm] = useState<boolean>(false);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  const [error, setError] = useState<string | null>(null);
  const [ticketStatus, setTicketStatus] = useState<string | null>(null);
  const [consecutiveLow, setConsecutiveLow] = useState(0);
  const [resolutionRejections, setResolutionRejections] = useState(0);

  const socketRef = useRef<ConversationSocket>(new ConversationSocket());
  const lastAgentMsgTime = useRef(0);
  const prevClosedRef = useRef(false);
  const prevCategoryRef = useRef<IssueCategory | null>(null);
  const sendRef = useRef<((text: string, category?: string, skipUserBubble?: boolean) => Promise<void>) | null>(null);
  const convIdRef = useRef<string | null>(null);

  // Keep convIdRef in sync for use inside closures
  useEffect(() => { convIdRef.current = convId; }, [convId]);

  const isTicketClosed = ticketStatus ? CLOSED_STATUSES.includes(ticketStatus) : csatSubmitted;

  // ── Mount: restore or start session ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // Bitazza Exchange: exchange a single-use bootstrap for our session JWT
      // before any authenticated call. Singleton-guarded; no-op without a bootstrap.
      if (cfg.wstBootstrap && !cfg.token) {
        try {
          await exchangeBootstrapToken(cfg);
        } catch {
          if (!cancelled) setError('Could not start secure session. Please reopen the chat.');
          return;
        }
      }

      const existing = await getStoredSession(storage, cfg.sessionTtlMs);

      if (existing) {
        // Guest→auth upgrade: discard stale guest session
        if (existing.isGuest && !cfg.guestMode) {
          await clearStoredSession(storage);
          showGreeting();
          try {
            const id = await startConversation(cfg, storage);
            if (!cancelled) setConvId(id);
          } catch { if (!cancelled) setError('Could not connect. Please refresh.'); }
          return;
        }

        if (existing.isGuest) setIsGuest(true);
        if (existing.lang) { setLang(existing.lang); setLangSelected(true); }
        if (existing.category) setSelectedCategory(existing.category as IssueCategory);
        if (existing.botName) { setBotName(existing.botName); setBotAvatarUrl(existing.botAvatarUrl ?? null); }

        try {
          const { messages: history, humanHandling, ticketStatus: restoredStatus } = await fetchHistory(cfg, existing.id);
          if (cancelled) return;

          if (restoredStatus) {
            setTicketStatus(restoredStatus);
            prevClosedRef.current = CLOSED_STATUSES.includes(restoredStatus);
          }
          setConvId(existing.id);

          if (history.length === 0) { showGreeting(); if (existing.lang) setLangSelected(false); return; }

          const lastAgentMsg = [...history].reverse().find((m) => m.role === 'agent');
          const restoredAgent = lastAgentMsg?.agent_name
            ? { name: lastAgentMsg.agent_name, avatar: lastAgentMsg.agent_avatar ?? lastAgentMsg.agent_name[0].toUpperCase(), avatarUrl: lastAgentMsg.agent_avatar_url ?? null }
            : (existing.agent ?? null);

          if (restoredAgent) {
            setEscalated(true);
            setEscalatedAgent(restoredAgent);
            await storeSessionAgent(storage, restoredAgent);
          } else if (humanHandling) {
            setEscalated(true);
          }

          if (existing.category && !existing.isGuest && await getStoredCustomerId(storage)) {
            fetchCustomerTickets(cfg, 1, 20).then((tickets) => {
              if (!cancelled && tickets.length > 0) { setPrevTickets(tickets); setShowPrevTickets(true); }
            }).catch(() => {});
          }

          setMessages(mapHistory(history, cfg.apiUrl));
          if (history.some((m) => m.role === 'agent')) setEscalated(true);
        } catch {
          await clearStoredSession(storage);
          setLangSelected(false);
          showGreeting();
          try {
            const id = await startConversation(cfg, storage);
            if (!cancelled) setConvId(id);
          } catch { if (!cancelled) setError('Could not connect. Please refresh.'); }
        }
      } else {
        showGreeting();
        if (!cfg.guestMode) {
          try {
            const id = await startConversation(cfg, storage);
            if (!cancelled) setConvId(id);
          } catch {
            try {
              const result = await emergencyEscalate(cfg, 'start_failed');
              if (!cancelled) {
                setConvId(result.conversationId);
                setEscalated(true);
                setLangSelected(true);
                setSelectedCategory('other' as IssueCategory);
              }
            } catch {
              if (!cancelled) setMessages((prev) => [...prev, {
                id: 'emergency-fallback', role: 'assistant',
                content: lang === 'th' ? 'ขณะนี้ระบบขัดข้อง กรุณาติดต่อฝ่ายสนับสนุนโดยตรงค่ะ' : 'We are having trouble connecting. Please contact support directly.',
                timestamp: Date.now(),
              }]);
            }
          }
        }
      }
    };

    init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Open WebSocket when convId is set ──────────────────────────────────────
  useEffect(() => {
    if (!convId) return;
    const socket = socketRef.current;
    lastAgentMsgTime.current = Math.floor(Date.now() / 1000);

    // Fallback polling
    socket.setFallbackPoll(async () => {
      const cid = convIdRef.current;
      if (!cid) return;
      await pollAgentMessages(cid);
    });

    const unsubMsg = socket.onMessage((msg: WsInboundMessage) => {
      if (msg.type === 'new_message') {
        const m = msg.message;
        if (m.role !== 'agent') return;
        cfg.onNotificationSound?.();
        const agentName = m.agentName ?? 'Support Agent';
        const agent: AgentIdentity = {
          name: agentName,
          avatar: m.agentAvatar ?? agentName[0].toUpperCase(),
          avatarUrl: m.agentAvatarUrl ?? null,
        };
        setEscalated(true);
        setEscalatedAgent(agent);
        storeSessionAgent(storage, agent).catch(() => {});
        setAgentConnectedBanner(agentName);
        setTimeout(() => setAgentConnectedBanner(null), 7000);
        setMessages((prev) => [...prev, m]);
      } else if (msg.type === 'status_change') {
        setTicketStatus(msg.status);
      }
    });

    const unsubState = socket.onStateChange((state) => setWsState(state));

    socket.connect(convId, cfg.apiUrl, cfg.token ?? null);

    return () => {
      unsubMsg();
      unsubState();
      socket.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  // ── REST poll for agent messages (used as WS fallback) ────────────────────
  const pollAgentMessages = useCallback(async (cid: string) => {
    const { messages: history, humanHandling, ticketStatus: polledStatus } = await fetchHistory(cfg, cid);
    const polledClosed = polledStatus ? CLOSED_STATUSES.includes(polledStatus) : false;
    if (prevClosedRef.current && !polledClosed) {
      setCsatPending(false);
    }
    prevClosedRef.current = polledClosed;
    setTicketStatus(polledStatus);

    const newAgentMsgs = history.filter((m) => m.role === 'agent' && m.created_at > lastAgentMsgTime.current);
    if (newAgentMsgs.length > 0) {
      lastAgentMsgTime.current = newAgentMsgs[newAgentMsgs.length - 1].created_at;
      cfg.onNotificationSound?.();
      const firstMsg = newAgentMsgs[0];
      setEscalated(true);
      const agentName = firstMsg.agent_name ?? 'Support Agent';
      const agent: AgentIdentity = {
        name: agentName,
        avatar: firstMsg.agent_avatar ?? agentName[0].toUpperCase(),
        avatarUrl: firstMsg.agent_avatar_url ?? null,
      };
      setEscalatedAgent(agent);
      await storeSessionAgent(storage, agent);
      setAgentConnectedBanner(agentName);
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
          agentAvatarUrl: resolveUrl(m.agent_avatar_url, cfg.apiUrl) ?? undefined,
          attachments: m.attachments?.map((a) => ({ id: a.id, url: a.url, name: a.name, mimeType: a.mime_type, size: a.size })),
        })),
      ]);
    } else if (humanHandling) {
      setEscalated(true);
    }
  }, [cfg, storage]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function showGreeting() {
    setMessages([{
      id: 'greeting',
      role: 'assistant',
      content: '👋 Hi! How can I help you today?\n\nPlease select your language:\n---\n👋 สวัสดีค่ะ! มีอะไรให้ช่วยได้บ้างคะ?\n\nกรุณาเลือกภาษา:',
      timestamp: Date.now(),
      senderName: 'Bitazza Support',
    }]);
  }

  // ── send ───────────────────────────────────────────────────────────────────

  const send = useCallback(async (
    text: string,
    category?: string,
    skipUserBubble = false,
  ) => {
    const cid = convIdRef.current;
    const hasAttachments = pendingAttachments.length > 0;
    if (!text.trim() && !hasAttachments) return;
    if (!cid || loading) return;
    setError(null);

    const trimmed = text.trim();
    const attachmentsSnapshot = [...pendingAttachments];
    setPendingAttachments([]);

    if (!skipUserBubble) {
      setMessages((prev) => [...prev, {
        id: makeId(), role: 'user', content: trimmed, timestamp: Date.now(),
        attachments: attachmentsSnapshot.length ? attachmentsSnapshot : undefined,
      }]);
    }
    setLoading(true);

    try {
      const activeCategory = category ?? selectedCategory ?? undefined;
      const attachmentIds = attachmentsSnapshot.map((a) => a.id);
      const result = await sendMessage(cfg, cid, trimmed, consecutiveLow, activeCategory, attachmentIds.length ? attachmentIds : undefined);
      setLang(result.language);

      if (result.reply !== null) {
        if (result.transitionMessage) {
          const outName = botName;
          const outAvatarUrl = botAvatarUrl;
          await new Promise((r) => setTimeout(r, 900 + Math.random() * 400));
          cfg.onNotificationSound?.();
          setMessages((prev) => [...prev, {
            id: makeId(), role: 'assistant', content: result.transitionMessage!,
            timestamp: Date.now(), senderName: outName ?? undefined, agentAvatarUrl: outAvatarUrl ?? undefined,
          }]);
          const inName = result.agentName ?? botName;
          const inAvatarUrl = result.agentAvatarUrl ?? null;
          if (result.agentName) {
            setBotName(inName);
            setBotAvatarUrl(inAvatarUrl);
            await storeSessionBotInfo(storage, inName!, inAvatarUrl);
          }
          await new Promise((r) => setTimeout(r, 2200 + Math.random() * 600));
          cfg.onNotificationSound?.();
          setMessages((prev) => [...prev, {
            id: makeId(), role: 'assistant', content: result.reply!,
            timestamp: Date.now(), escalated: result.escalated,
            senderName: inName ?? undefined, agentAvatarUrl: inAvatarUrl ?? undefined,
            quickReplies: result.quickReplies.length && !result.escalated && !result.offerResolution ? result.quickReplies : undefined,
          }]);
        } else {
          await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
          cfg.onNotificationSound?.();
          setMessages((prev) => [...prev, {
            id: makeId(), role: 'assistant', content: result.reply!,
            timestamp: Date.now(), escalated: result.escalated,
            senderName: botName ?? undefined, agentAvatarUrl: botAvatarUrl ?? undefined,
            quickReplies: result.quickReplies.length && !result.escalated && !result.offerResolution ? result.quickReplies : undefined,
          }]);
        }
      }

      if (result.offerResolution && !escalated) {
        setMessages((prev) => [...prev, {
          id: makeId(), role: 'assistant',
          content: lang === 'th' ? 'ปัญหาของคุณได้รับการแก้ไขแล้วหรือยังคะ?' : 'Did this resolve your issue?',
          timestamp: Date.now(), offerResolution: true,
        }]);
      }

      if (result.upgradedCategory) {
        setSelectedCategory(result.upgradedCategory as IssueCategory);
        await storeSessionCategory(storage, result.upgradedCategory);
      }

      if (result.escalated) { setEscalated(true); setConsecutiveLow(0); }
      else { setConsecutiveLow(0); }
    } catch {
      setError(lang === 'th' ? 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง' : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      setAwaitingFirstReply(false);
    }
  }, [convId, loading, consecutiveLow, selectedCategory, cfg, lang, pendingAttachments, botName, botAvatarUrl, escalated, storage]);

  useEffect(() => { sendRef.current = send; }, [send]);

  // ── selectCategory ─────────────────────────────────────────────────────────

  const selectCategory = useCallback(async (category: IssueCategory) => {
    if (prevCategoryRef.current && prevCategoryRef.current !== category) {
      setMessages((msgs) => [...msgs, {
        id: makeId(), role: 'system' as const,
        content: `${prevCategoryRef.current} → ${category}`,
        timestamp: Date.now(),
      }]);
      prevCategoryRef.current = null;
    }
    setSelectedCategory(category);
    await storeSessionCategory(storage, category);

    const cid = convIdRef.current;
    if (!isGuest && await getStoredCustomerId(storage)) {
      fetchCustomerTickets(cfg, 1, 20).then((tickets) => {
        if (tickets.length > 0) { setPrevTickets(tickets); setShowPrevTickets(true); }
      }).catch(() => {});
    }

    const openingMessages: Record<string, Record<string, string>> = {
      kyc_verification: { en: 'I need help with my KYC verification.', th: 'ฉันต้องการความช่วยเหลือเกี่ยวกับการยืนยันตัวตน KYC' },
      account_restriction: { en: 'I need help with my account access.', th: 'ฉันต้องการความช่วยเหลือเกี่ยวกับการเข้าถึงบัญชี' },
      password_2fa_reset: { en: 'I need to reset my password or 2FA.', th: 'ฉันต้องการรีเซ็ตรหัสผ่านหรือ 2FA' },
      fraud_security: { en: 'I have a fraud or security concern.', th: 'ฉันมีปัญหาเกี่ยวกับการฉ้อโกงหรือความปลอดภัย' },
      withdrawal_issue: { en: 'I have a problem with a withdrawal.', th: 'ฉันมีปัญหาเกี่ยวกับการถอนเงิน' },
      other: { en: 'I need help with something else.', th: 'ฉันต้องการความช่วยเหลือเรื่องอื่น' },
    };
    const openingMsg = openingMessages[category]?.[lang] ?? openingMessages[category]?.en ?? '';

    setMessages((prev) => [...prev, { id: makeId(), role: 'user', content: openingMsg, timestamp: Date.now() }]);

    if (cid) {
      setAwaitingFirstReply(true);
      try {
        const { agentName, agentAvatarUrl } = await setCategoryAgent(cfg, cid, category).catch(() => setCategoryAgent(cfg, cid, category));
        const resolvedName = agentName ?? 'Support Agent';
        const resolvedAvatar = resolveUrl(agentAvatarUrl, cfg.apiUrl);
        setBotName(resolvedName);
        setBotAvatarUrl(resolvedAvatar);
        await storeSessionBotInfo(storage, resolvedName, resolvedAvatar);
        setTimeout(() => {
          if (category !== 'other') {
            const intro = lang === 'th'
              ? `สวัสดีค่ะ ดิฉันชื่อ ${resolvedName} เป็น AI ผู้ช่วยฝ่ายสนับสนุนค่ะ 🤖`
              : `Hi! I'm ${resolvedName}, your AI support assistant. 🤖 I'll gladly help you.`;
            setMessages((prev) => [...prev, { id: makeId(), role: 'assistant', content: intro, timestamp: Date.now() }]);
          }
          sendRef.current?.(openingMsg, category, true);
        }, 1200 + Math.random() * 600);
      } catch {
        setEscalated(true);
        setAwaitingFirstReply(false);
      }
    } else {
      sendRef.current?.(openingMsg, category, true);
    }
  }, [convId, cfg, lang, isGuest, storage]);

  // ── selectLanguage ─────────────────────────────────────────────────────────

  const selectLanguage = useCallback(async (selected: string) => {
    setLang(selected);
    setLangSelected(true);
    await storeSessionLang(storage, selected);
    fetchAnnouncements(cfg).then((anns) => setAnnouncements(anns)).catch(() => {});

    if (cfg.guestMode) { setShowGuestForm(true); return; }

    setMessages((prev) => [...prev, {
      id: 'category-prompt', role: 'assistant',
      content: selected === 'th' ? 'กรุณาเลือกประเภทปัญหาที่ต้องการความช่วยเหลือ:' : 'Please select the type of issue you need help with:',
      timestamp: Date.now(), senderName: 'Bitazza Support',
    }]);

    const cid = convIdRef.current;
    if (!isGuest && await getStoredCustomerId(storage)) {
      fetchOpenTicket(cfg).then(async (ticket) => {
        if (!ticket || ticket.id === cid) return;
        const { messages: history } = await fetchHistory(cfg, ticket.id);
        if (history.length > 0) { setOpenTicket(ticket); setShowOpenTicketBanner(true); }
      }).catch(() => {});
    }
  }, [cfg, storage, isGuest]);

  // ── submitCsat ─────────────────────────────────────────────────────────────

  const submitCsat = useCallback(async (score: 1 | 2 | 3 | 4 | 5) => {
    const cid = convIdRef.current;
    if (!cid) return;
    await apiSubmitCsat(cfg, cid, score);
    setCsatSubmitted(true);
    setCsatPending(false);
    cfg.onCsatComplete?.();
  }, [cfg]);

  // ── declineResolution ──────────────────────────────────────────────────────

  const declineResolution = useCallback(() => {
    setResolutionRejections((n) => n + 1);
  }, []);

  // ── resumeTicket ───────────────────────────────────────────────────────────

  const resumeTicket = useCallback(async (ticketId: string) => {
    const { messages: history, humanHandling, ticketStatus: status } = await fetchHistory(cfg, ticketId);
    setConvId(ticketId);
    await storeSession(storage, ticketId, { lang, category: selectedCategory ?? undefined, isGuest });
    setTicketStatus(status);
    setMessages(mapHistory(history, cfg.apiUrl));
    if (history.some((m) => m.role === 'agent') || humanHandling) setEscalated(true);
    setShowOpenTicketBanner(false);
    setOpenTicket(null);
  }, [cfg, storage, lang, selectedCategory, isGuest]);

  // ── startGuestSession ──────────────────────────────────────────────────────

  const startGuestSession = useCallback(async (name: string, email: string) => {
    setShowGuestForm(false);
    setAwaitingFirstReply(true);
    try {
      const id = await startConversation(cfg, storage, { guestName: name || undefined, guestEmail: email || undefined });
      setConvId(id);
      try {
        const { agentName, agentAvatarUrl } = await setCategoryAgent(cfg, id, 'other');
        const resolvedName = agentName ?? 'Aria';
        const resolvedAvatar = resolveUrl(agentAvatarUrl, cfg.apiUrl);
        setBotName(resolvedName);
        setBotAvatarUrl(resolvedAvatar);
        await storeSessionBotInfo(storage, resolvedName, resolvedAvatar);
        setTimeout(() => {
          const greeting = lang === 'th'
            ? `สวัสดีค่ะ ดิฉันชื่อ ${resolvedName} เป็น AI ผู้ช่วยฝ่ายสนับสนุนค่ะ 🤖`
            : `Hi! I'm ${resolvedName}, your AI support assistant. 🤖 I'll gladly help you.`;
          setMessages((prev) => [...prev, { id: 'aria-intro', role: 'assistant', content: greeting, timestamp: Date.now() }]);
          setAwaitingFirstReply(false);
        }, 1200 + Math.random() * 600);
      } catch {
        setTimeout(() => {
          setMessages((prev) => [...prev, { id: 'ploy-intro', role: 'assistant', content: lang === 'th' ? 'สวัสดีค่ะ! 😊' : 'Hi there! 😊 How can I help?', timestamp: Date.now() }]);
          setAwaitingFirstReply(false);
        }, 1000);
      }
    } catch {
      setAwaitingFirstReply(false);
      setError('Could not connect. Please refresh.');
    }
  }, [cfg, storage, lang]);

  // ── handleFiles ────────────────────────────────────────────────────────────

  const handleFiles = useCallback(async (files: File[]) => {
    const cid = convIdRef.current;
    if (!cid) return;
    const valid = files.slice(0, 5).filter((f) => ALLOWED_MIME.includes(f.type) && f.size <= MAX_FILE_SIZE);
    if (!valid.length) return;
    setUploadingFiles(true);
    try {
      const uploaded = await Promise.all(valid.map((f) => uploadAttachment(cfg, f)));
      setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, 5));
    } catch { /* fail silently — user can retry */ }
    finally { setUploadingFiles(false); }
  }, [cfg]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── reset ──────────────────────────────────────────────────────────────────

  const reset = useCallback(async () => {
    await clearStoredSession(storage);
    setMessages([]);
    setConvId(null);
    setLang(cfg.lang ?? 'en');
    setLangSelected(!!cfg.lang);
    setSelectedCategory(null);
    setEscalated(false);
    setEscalatedAgent(null);
    setBotName(null);
    setBotAvatarUrl(null);
    setCsatPending(false);
    setCsatSubmitted(false);
    setPrevTickets([]);
    setShowPrevTickets(false);
    setOpenTicket(null);
    setShowOpenTicketBanner(false);
    setIsGuest(cfg.guestMode ?? false);
    setShowGuestForm(false);
    setPendingAttachments([]);
    setAnnouncements([]);
    setError(null);
    setTicketStatus(null);
    setConsecutiveLow(0);
    setResolutionRejections(0);
    socketRef.current.disconnect();
  }, [cfg, storage]);

  return {
    // State
    messages, loading, convId, lang, langSelected, selectedCategory,
    escalated, escalatedAgent, agentConnectedBanner, botName, botAvatarUrl,
    csatPending, csatSubmitted, prevTickets, openTicket, showPrevTickets,
    showOpenTicketBanner, isGuest, showGuestForm, pendingAttachments,
    uploadingFiles, announcements, wsState, error, awaitingFirstReply,
    // Actions
    send, selectCategory, selectLanguage, submitCsat,
    declineResolution, resumeTicket, startGuestSession,
    handleFiles, removePendingAttachment, reset,
  };
}
