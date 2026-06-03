import { useState, useRef, useCallback, useEffect } from 'react';
import type { CSBotConfig } from './types';
import type { PastTicket } from './api';
import { fetchPaginatedHistory } from './api';
import MessageBubble from './MessageBubble';

interface HistoryMsg {
  id: string;
  role: 'user' | 'assistant' | 'agent';
  content: string;
  timestamp: number;
  agentName?: string;
  agentAvatar?: string;
  agentAvatarUrl?: string;
}

// Bitazza semantic palette status badges
const STATUS_BADGE: Record<string, { label: { en: string; th: string }; bg: string; color: string }> = {
  Open_Live:           { label: { en: 'Open',        th: 'เปิด' },             bg: '#EEF3FE', color: '#32579D' },
  In_Progress:         { label: { en: 'In Progress',  th: 'กำลังดำเนินการ' },  bg: '#FEF8EA', color: '#705514' },
  Escalated:           { label: { en: 'Escalated',    th: 'ส่งต่อเจ้าหน้าที่' }, bg: '#FEF8EA', color: '#705514' },
  Pending_Customer:    { label: { en: 'Pending',      th: 'รอลูกค้า' },         bg: '#EDEDF8', color: 'rgba(27,26,24,0.5)' },
  Closed_Resolved:     { label: { en: 'Resolved',     th: 'แก้ไขแล้ว' },        bg: '#F0FEF8', color: '#056639' },
  Closed_Unresponsive: { label: { en: 'Closed',       th: 'ปิดแล้ว' },          bg: '#F0FEF8', color: '#056639' },
};

const CATEGORY_LABEL: Record<string, { en: string; th: string }> = {
  kyc_verification:    { en: 'KYC / Verification',   th: 'ยืนยันตัวตน (KYC)' },
  account_restriction: { en: 'Account Restricted',    th: 'บัญชีถูกระงับ' },
  password_2fa_reset:  { en: 'Password / 2FA Reset',  th: 'รีเซ็ตรหัสผ่าน / 2FA' },
  fraud_security:      { en: 'Fraud / Security',       th: 'การฉ้อโกง / ความปลอดภัย' },
  withdrawal_issue:    { en: 'Withdrawal Issue',        th: 'ปัญหาการถอนเงิน' },
  other:               { en: 'Other',                   th: 'อื่นๆ' },
};

function relativeDate(unixTs: number, lang: 'en' | 'th'): string {
  const diff = Math.floor((Date.now() / 1000 - unixTs) / 86400);
  if (lang === 'th') {
    if (diff === 0) return 'วันนี้';
    if (diff === 1) return 'เมื่อวาน';
    return `${diff} วันที่แล้ว`;
  }
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${diff} days ago`;
}

function SkeletonMsg() {
  return (
    <div data-testid="history-skeleton" className="flex flex-col gap-2 py-2 animate-pulse">
      <div className="h-3 rounded w-3/4" style={{ background: '#EDEDF8' }} />
      <div className="h-3 rounded w-1/2 self-end" style={{ background: '#EDEDF8' }} />
      <div className="h-3 rounded w-2/3" style={{ background: '#EDEDF8' }} />
    </div>
  );
}

interface TicketThreadProps {
  ticket: PastTicket;
  cfg: CSBotConfig;
  lang: 'en' | 'th';
  primaryColor: string;
}

function TicketThread({ ticket, cfg, lang, primaryColor }: TicketThreadProps) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<HistoryMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const messagesRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const pageRef = useRef(1);
  const LIMIT = 10;

  const loadPage = useCallback(async (p: number) => {
    loadingRef.current = true;
    setLoading(true);
    const { messages: msgs } = await fetchPaginatedHistory(cfg, ticket.id, p, LIMIT);
    loadingRef.current = false;
    setLoading(false);
    if (msgs.length < LIMIT) { hasMoreRef.current = false; setHasMore(false); }
    const mapped: HistoryMsg[] = msgs.map((m, i) => ({
      id: `${ticket.id}-p${p}-${i}`,
      role: m.role as HistoryMsg['role'],
      content: m.content,
      timestamp: m.created_at * 1000,
      agentName: m.agent_name,
      agentAvatar: m.agent_avatar,
      agentAvatarUrl: m.agent_avatar_url,
    }));
    if (p === 1) {
      setMessages(mapped);
    } else {
      setMessages((prev) => [...mapped, ...prev]);
    }
  }, [cfg, ticket.id]);

  const handleExpand = useCallback(() => {
    if (!expanded) {
      setExpanded(true);
      loadPage(1);
    } else {
      setExpanded(false);
    }
  }, [expanded, loadPage]);

  // Scroll-up to load older messages (oldest shown at top, newest at bottom)
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (!el || loadingRef.current || !hasMoreRef.current) return;
      if (el.scrollTop <= 40) {
        const nextPage = pageRef.current + 1;
        pageRef.current = nextPage;
        setPage(nextPage);
        loadPage(nextPage);
      }
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadPage, expanded]);

  const catLabel = CATEGORY_LABEL[ticket.category]?.[lang] ?? ticket.category;
  const dateLabel = relativeDate(ticket.created_at, lang);

  return (
    <div className="overflow-hidden mb-2" style={{ border: '1px solid #EDEDF8', borderRadius: 12 }}>
      {/* Ticket header — click to expand */}
      <button
        data-testid="prev-ticket-header"
        onClick={handleExpand}
        className="w-full flex items-center justify-between px-3 py-2.5 transition-colors text-left"
        style={{ background: '#FCFCFE' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#EDEDF8')}
        onMouseLeave={e => (e.currentTarget.style.background = '#FCFCFE')}
      >
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold" style={{ color: '#1B1A18' }}>{catLabel}</span>
            {(() => {
              const badge = STATUS_BADGE[ticket.status];
              if (!badge) return null;
              return (
                <span
                  className="text-[9px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: badge.bg, color: badge.color }}
                >
                  {badge.label[lang]}
                </span>
              );
            })()}
          </div>
          <span className="text-[10px]" style={{ color: 'rgba(27,26,24,0.5)' }}>{dateLabel}</span>
          {ticket.last_message && (
            <span className="text-[11px] truncate max-w-[240px]" style={{ color: 'rgba(27,26,24,0.75)' }}>
              {ticket.last_message}
            </span>
          )}
        </div>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth={2.5}
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          style={{ color: 'rgba(27,26,24,0.5)' }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Messages */}
      {expanded && (
        <div
          data-testid="prev-ticket-messages"
          ref={messagesRef}
          className="max-h-[200px] overflow-y-auto px-3 py-2 space-y-1 bg-white"
        >
          {loading && page === 1 && <SkeletonMsg />}
          {loading && page > 1 && (
            <div data-testid="history-skeleton" className="py-1">
              <SkeletonMsg />
            </div>
          )}
          {!loading && messages.length === 0 && (
            <p className="text-xs text-center py-2" style={{ color: 'rgba(27,26,24,0.5)' }}>
              {lang === 'th' ? 'ไม่มีข้อความ' : 'No messages'}
            </p>
          )}
          {!hasMore && messages.length > 0 && (
            <p className="text-[10px] text-center py-1" style={{ color: 'rgba(27,26,24,0.4)' }}>
              {lang === 'th' ? '— เริ่มต้นการสนทนา —' : '— Start of conversation —'}
            </p>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              primaryColor={primaryColor}
              botName={m.agentName ?? null}
              botAvatarUrl={m.agentAvatarUrl ?? null}
              escalatedAgent={null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  tickets: PastTicket[];
  cfg: CSBotConfig;
  lang: 'en' | 'th';
  primaryColor: string;
}

export default function PrevConversations({ tickets, cfg, lang, primaryColor }: Props) {
  if (tickets.length === 0) return null;

  const label = lang === 'th' ? 'การสนทนาก่อนหน้า' : 'Previous conversations';

  return (
    <div data-testid="prev-conversations" className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
        <span className="text-[10px] font-medium" style={{ color: 'rgba(27,26,24,0.5)' }}>{label}</span>
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
      </div>
      {[...tickets].reverse().map((t) => (
        <TicketThread key={t.id} ticket={t} cfg={cfg} lang={lang} primaryColor={primaryColor} />
      ))}
      <div className="flex items-center gap-2 mt-2 mb-3">
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
        <span className="text-[10px] font-medium" style={{ color: 'rgba(27,26,24,0.5)' }}>
          {lang === 'th' ? 'การสนทนาใหม่' : 'New conversation'}
        </span>
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
      </div>
    </div>
  );
}
