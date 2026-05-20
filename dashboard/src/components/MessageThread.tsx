import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { TicketDetail, TicketStatus, Message, MessageAttachment } from '../types';
import { api } from '../api';
import { usePerm } from '../PermissionContext';
import { StatusBadge } from './ui/Badge';
import { Avatar } from './ui/Avatar';
import { SLATimer } from './ui/SLATimer';
import { Spinner } from './ui/Spinner';

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_OPTIONS: TicketStatus[] = [
  'Open_Live', 'In_Progress', 'Pending_Customer',
  'Closed_Resolved', 'Closed_Unresponsive', 'Escalated',
];

type SenderType = 'customer' | 'agent' | 'bot' | 'system' | 'internal_note' | 'whisper'
               | 'user' | 'ai' | 'assistant';

// ─── Virtual list ────────────────────────────────────────────────────────────

const VIRTUAL_THRESHOLD = 100;
const ITEM_HEIGHT = 72;

interface VirtualRange { start: number; end: number }

function useVirtualRange(total: number, containerRef: React.RefObject<HTMLDivElement | null>): VirtualRange {
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: Math.min(total, 40) });

  useEffect(() => {
    if (total <= VIRTUAL_THRESHOLD) {
      setRange({ start: 0, end: total });
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const overscan = 10;
      const start = Math.max(0, Math.floor(el.scrollTop / ITEM_HEIGHT) - overscan);
      const visible = Math.ceil(el.clientHeight / ITEM_HEIGHT);
      const end = Math.min(total, start + visible + overscan * 2);
      setRange({ start, end });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [total, containerRef]);

  return range;
}

// ─── Timestamp grouping ──────────────────────────────────────────────────────

function shouldShowTimestamp(msgs: Message[], index: number): boolean {
  if (index === 0) return true;
  const prev = msgs[index - 1];
  const curr = msgs[index];
  return curr.created_at - prev.created_at > 5 * 60;
}

function formatTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Status Dropdown ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  Open_Live:           { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  In_Progress:         { bg: 'bg-blue-50',    text: 'text-blue-700',    dot: 'bg-blue-500'    },
  Pending_Customer:    { bg: 'bg-amber-50',   text: 'text-amber-700',   dot: 'bg-amber-500'   },
  Escalated:           { bg: 'bg-red-50',     text: 'text-red-700',     dot: 'bg-red-500'     },
  Closed_Resolved:     { bg: 'bg-gray-100',   text: 'text-gray-600',    dot: 'bg-gray-400'    },
  Closed_Unresponsive: { bg: 'bg-gray-100',   text: 'text-gray-500',    dot: 'bg-gray-300'    },
};

function StatusDropdown({
  status, onChange, canClose, canEscalate,
}: {
  status: TicketStatus;
  onChange: (s: TicketStatus) => void;
  canClose: boolean;
  canEscalate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (
        dropRef.current && !dropRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // align dropdown right-edge to button right-edge
      setPos({ top: r.bottom + 6, left: r.right - 208 });
    }
    setOpen(o => !o);
  };

  // Status color map — explicit styles (never Tailwind vars that may not compile)
  const STATUS_STYLE: Record<string, { bg: string; color: string; dot: string }> = {
    Open_Live:           { bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
    In_Progress:         { bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
    Pending_Customer:    { bg: '#fffbeb', color: '#92400e', dot: '#f59e0b' },
    Escalated:           { bg: '#fef2f2', color: '#b91c1c', dot: '#ef4444' },
    Closed_Resolved:     { bg: '#f9fafb', color: '#6b7280', dot: '#9ca3af' },
    Closed_Unresponsive: { bg: '#f9fafb', color: '#9ca3af', dot: '#d1d5db' },
  };
  const sty = STATUS_STYLE[status] ?? { bg: '#f3f4f6', color: '#6b7280', dot: '#9ca3af' };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all"
        style={{ background: sty.bg, color: sty.color }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: sty.dot }} />
        {status.replace(/_/g, ' ')}
        <svg className={`w-3 h-3 opacity-60 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="ds-dropdown w-52 animate-slide-in-up"
          style={{ position: 'fixed', top: pos.top, left: Math.max(4, pos.left), zIndex: 9999 }}
        >
          {STATUS_OPTIONS.map(s => {
            const st = STATUS_STYLE[s] ?? { bg: '#f3f4f6', color: '#6b7280', dot: '#9ca3af' };
            const isActive = s === status;
            const isAllowed = s === 'Escalated' ? canEscalate : canClose;
            return (
              <button
                key={s}
                onClick={() => { if (isAllowed) { onChange(s); setOpen(false); } }}
                disabled={!isAllowed}
                className="ds-dropdown-item"
                style={isActive ? { background: st.bg, color: st.color } : isAllowed ? {} : { opacity: 0.35, cursor: 'not-allowed' }}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: st.dot }} />
                <span className="flex-1">{s.replace(/_/g, ' ')}</span>
                {isActive && (
                  <svg className="w-3 h-3 shrink-0" style={{ color: st.color }} fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Message bubble ──────────────────────────────────────────────────────────

function getSenderType(msg: Message): SenderType {
  const t = (msg as Message & { sender_type?: string }).sender_type ?? msg.role;
  return (t as SenderType) ?? 'system';
}

interface BubbleProps { msg: Message; showTs: boolean }

function MessageBubble({ msg, showTs }: BubbleProps) {
  const type = getSenderType(msg);
  const ts = formatTime(msg.created_at);

  // System — centered pill
  if (type === 'system') {
    return (
      <div className="flex justify-center my-1">
        <span className="text-[10px] text-text-muted bg-surface-3 ring-1 ring-surface-5 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  // Internal note / AI Summary
  if (type === 'internal_note') {
    const clean = msg.content
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^[*\-]\s+/gm, '')
      .trim();

    const summaryLines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    const isSummary = summaryLines.some(l => /^(Issue|Actions|Status|Current Status|Actions Taken):/i.test(l));

    if (isSummary) {
      const rows = summaryLines
        .map(line => { const c = line.indexOf(':'); return c === -1 ? null : { label: line.slice(0, c).trim(), text: line.slice(c + 1).trim() }; })
        .filter(Boolean) as { label: string; text: string }[];
      return (
        <div className="w-full my-1 px-1">
          <div className="bg-accent-blue/8 ring-1 ring-accent-blue/25 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-accent-blue/20">
              <svg className="w-3.5 h-3.5 text-accent-blue shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
              </svg>
              <span className="text-[10px] font-semibold text-accent-blue uppercase tracking-wide">
                AI Summary · {msg.agent_name || 'Agent'} · {ts}
              </span>
            </div>
            <div className="divide-y divide-accent-blue/15">
              {rows.map((row, i) => (
                <div key={i} className="flex gap-3 px-3 py-2">
                  <span className="shrink-0 font-semibold text-accent-blue text-xs w-16">{row.label}</span>
                  <span className="text-xs text-text-secondary leading-relaxed">{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="w-full my-1 px-1">
        <div className="bg-accent-amber/10 ring-1 ring-accent-amber/30 rounded-xl px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <svg className="w-3 h-3 text-accent-amber shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
            </svg>
            <span className="text-[10px] font-semibold text-accent-amber uppercase tracking-wide">
              Internal Note · {msg.agent_name || 'Agent'} · {ts}
            </span>
          </div>
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">{clean}</p>
        </div>
      </div>
    );
  }

  // Whisper
  if (type === 'whisper') {
    const supervisorName = (msg as Message & { supervisor_name?: string }).supervisor_name ?? 'Supervisor';
    return (
      <div className="w-full my-1 px-1">
        <div className="bg-surface-3 ring-1 ring-accent-amber/20 rounded-xl px-3 py-2.5 border-l-2 border-accent-amber">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] font-semibold text-accent-amber uppercase tracking-wide">
              Whisper from {supervisorName} · {ts}
            </span>
          </div>
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
      </div>
    );
  }

  const isCustomer = (type as string) === 'customer' || (type as string) === 'user';
  const isBot      = type === 'bot' || type === 'ai' || type === 'assistant';
  const isRight    = !isCustomer;
  const label      = isCustomer ? (msg.agent_name || 'Customer') : isBot ? 'Bot' : (msg.agent_name || 'Agent');

  // Attachments stored in metadata by the Python backend
  const attachments: MessageAttachment[] = (
    msg.attachments ??
    ((msg.metadata?.attachments as MessageAttachment[] | undefined) ?? [])
  );

  return (
    <div className={`flex flex-col max-w-[72%] ${isRight ? 'self-end items-end' : 'self-start items-start'}`}>
      {showTs && (
        <span className="text-[10px] text-text-muted mb-1 mx-1">{label} · {ts}</span>
      )}
      <div className={`
        px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed
        ${isCustomer
          /* Customer: pure white with border — distinct against the tinted chat bg */
          ? 'ds-bubble-customer rounded-xl rounded-tl-sm'
          : isBot
          /* AI Bot: blue */
          ? 'ds-bubble-bot rounded-xl rounded-tr-sm'
          /* Human agent: green */
          : 'ds-bubble-agent rounded-xl rounded-tr-sm'
        }
      `}>
        {isBot && <span className="font-semibold text-blue-500 text-xs mr-1.5">Bot</span>}
        {msg.content}

        {/* Attachment thumbnails */}
        {attachments.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${msg.content ? 'mt-2' : ''}`}>
            {attachments.map((a) => (
              a.mime_type.startsWith('image/') ? (
                <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
                  <img src={a.url} alt={a.name} className="w-20 h-20 object-cover rounded-lg border border-white/20 hover:opacity-90 transition-opacity cursor-pointer" />
                </a>
              ) : (
                <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-xs">
                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                  </svg>
                  <span className="max-w-[100px] truncate">{a.name}</span>
                </a>
              )
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Facebook window helper ──────────────────────────────────────────────────

function isFbWindowClosed(messages: Message[]): boolean {
  const lastCustomer = [...messages].reverse().find(m => {
    const t = (m as Message & { sender_type?: string }).sender_type ?? m.role;
    return (t as string) === 'customer' || (t as string) === 'user';
  });
  if (!lastCustomer) return false;
  return Date.now() / 1000 - lastCustomer.created_at > 86400;
}

// ─── Main component ──────────────────────────────────────────────────────────

const REPLY_CHANNELS = ['web', 'line', 'facebook', 'email'] as const;
type ReplyChannel = typeof REPLY_CHANNELS[number];

interface Props {
  ticketId: string;
  ws: WebSocket | null;
  onStatusChange: () => void;
  pendingDraft?: string | null;
  onDraftConsumed?: () => void;
  onReplyChange?: (value: string) => void;
}

export default function MessageThread({ ticketId, ws, onStatusChange, pendingDraft, onDraftConsumed, onReplyChange }: Props) {
  const canReply        = usePerm('inbox.reply');
  const canInternalNote = usePerm('inbox.internal_note');
  const canClose        = usePerm('inbox.close');
  const canEscalate     = usePerm('inbox.escalate');

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [reply, setReply] = useState('');
  const [isAiDraft, setIsAiDraft] = useState(false);
  const [isNote, setIsNote] = useState(false);
  const [replyChannel, setReplyChannel] = useState<ReplyChannel>('web');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typingAgents, setTypingAgents] = useState<string[]>([]);
  const [cannedMatches, setCannedMatches] = useState<{ id: string; shortcut: string; body: string }[]>([]);
  const [allCanned, setAllCanned] = useState<{ id: string; shortcut: string; body: string; title: string }[]>([]);

  // AI quick actions
  const [aiLoading, setAiLoading] = useState<'suggest' | 'summarize' | null>(null);
  const [inlineSummary, setInlineSummary] = useState('');

  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages: Message[] = useMemo(() => ticket?.history ?? [], [ticket]);
  const virtualRange = useVirtualRange(messages.length, scrollRef);

  useEffect(() => {
    setTicket(null);
    setReply('');
    setIsAiDraft(false);
    setIsNote(false);
    setLoading(true);
    setTypingAgents([]);
    setCannedMatches([]);
    setInlineSummary('');
  }, [ticketId]);

  const load = useCallback(async () => {
    try {
      const data = await api.getTicket(ticketId);
      setTicket(data);
    } finally { setLoading(false); }
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.getCannedResponses().then(setAllCanned).catch(() => {}); }, []);

  useEffect(() => {
    if (ticket?.channel && REPLY_CHANNELS.includes(ticket.channel as ReplyChannel)) {
      setReplyChannel(ticket.channel as ReplyChannel);
    }
  }, [ticket?.channel]);

  useEffect(() => {
    if (messages.length <= VIRTUAL_THRESHOLD) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  useEffect(() => {
    if (pendingDraft) {
      setReply(pendingDraft);
      setIsNote(false);
      setIsAiDraft(true);
      onDraftConsumed?.();
      textareaRef.current?.focus();
    }
  }, [pendingDraft]);

  useEffect(() => {
    if (!ws) return;
    const handler = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as Record<string, unknown>;
        const evId = (event.conversation_id ?? event.ticketId) as string | undefined;
        if (evId && evId !== ticketId) return;

        if (event.type === 'new_message') {
          setTicket(prev => prev ? { ...prev, history: [...prev.history, event.message as Message] } : prev);
        } else if (event.type === 'agent_typing') {
          const name = event.agent_name as string;
          setTypingAgents(prev => prev.includes(name) ? prev : [...prev, name]);
          setTimeout(() => setTypingAgents(prev => prev.filter(n => n !== name)), 5000);
        } else if (event.type === 'whisper') {
          const msg: Message = {
            role: 'whisper', sender_type: 'whisper',
            content: event.content as string,
            created_at: Math.floor(Date.now() / 1000),
            supervisor_name: event.supervisor_name as string,
          };
          setTicket(prev => prev ? { ...prev, history: [...prev.history, msg] } : prev);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, ticketId]);

  const emitTyping = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !ticket) return;
    ws.send(JSON.stringify({ type: 'typing', conversation_id: ticket.conversation_id }));
  };

  const handleReplyChange = (val: string) => {
    setReply(val);
    onReplyChange?.(val);
    if (isAiDraft) setIsAiDraft(false);
    emitTyping();
    const match = val.match(/\/(\w*)$/);
    if (match) {
      const q = match[1].toLowerCase();
      setCannedMatches(allCanned.filter(c => c.shortcut.startsWith(q)).slice(0, 6));
    } else {
      setCannedMatches([]);
    }
  };

  const applyCanned = (body: string) => {
    const filled = body
      .replace('{{customer_name}}', ticket?.customer?.name ?? '')
      .replace('{{ticket_id}}', ticket?.id ?? '')
      .replace('{{agent_name}}', 'Agent');
    setReply(prev => prev.replace(/\/\w*$/, filled));
    setCannedMatches([]);
  };

  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, 5);
    const valid = arr.filter(f => ALLOWED_MIME.includes(f.type) && f.size <= MAX_FILE_SIZE);
    if (!valid.length) return;
    setUploadingFiles(true);
    try {
      const uploaded = await Promise.all(valid.map(f => api.uploadAttachment(f)));
      const attachments: MessageAttachment[] = uploaded.map(u => ({
        id: u.id, url: u.url, name: u.name, mime_type: u.mime_type, size: u.size,
      }));
      setPendingAttachments(prev => [...prev, ...attachments].slice(0, 5));
    } catch { /* silent */ } finally { setUploadingFiles(false); }
  };

  const send = async () => {
    if (!reply.trim() && !pendingAttachments.length) return;
    if (sending || !ticket) return;
    setSending(true);
    const attachmentIds = pendingAttachments.map(a => a.id);
    setPendingAttachments([]);
    try {
      await api.reply(ticket.id, reply.trim(), isNote, replyChannel, attachmentIds.length ? attachmentIds : undefined);
      setReply('');
      setIsAiDraft(false);
      await load();
    } finally { setSending(false); }
  };

  const changeStatus = async (status: TicketStatus) => {
    if (!ticket) return;
    await api.setStatus(ticket.id, status);
    await load();
    onStatusChange();
  };

  const requestResolution = async () => {
    if (!ticket) return;
    await api.requestResolution(ticket.id);
    await load();
    onStatusChange();
  };

  // ── AI quick actions ──
  const handleSuggestReply = async () => {
    if (!ticket || aiLoading) return;
    setAiLoading('suggest');
    try {
      const r = await api.suggestReply(ticket.id);
      setReply(r.suggestion);
      setIsAiDraft(true);
      textareaRef.current?.focus();
    } catch { /* silent */ } finally { setAiLoading(null); }
  };

  const handleSummarize = async () => {
    if (!ticket || aiLoading) return;
    setAiLoading('summarize');
    try {
      const r = await api.summarize(ticket.id);
      setInlineSummary(r.summary);
    } catch { /* silent */ } finally { setAiLoading(null); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <Spinner size="md" className="text-gray-300" />
      </div>
    );
  }
  if (!ticket) return null;

  const isVirtual = messages.length > VIRTUAL_THRESHOLD;
  const visibleMessages = isVirtual ? messages.slice(virtualRange.start, virtualRange.end) : messages;
  const topPad = isVirtual ? virtualRange.start * ITEM_HEIGHT : 0;
  const botPad = isVirtual ? (messages.length - virtualRange.end) * ITEM_HEIGHT : 0;
  const slaBreachAt = (ticket as TicketDetail & { sla_breach_at?: string }).sla_breach_at;

  return (
    <div className="flex flex-col h-full bg-white" style={{ position: 'relative', zIndex: 1 }}>

      {/* ── Thread Header ── */}
      <div
        className="px-5 py-3.5 flex items-center justify-between gap-4 shrink-0 bg-white"
        style={{ borderBottom: '1px solid rgba(180,195,220,0.35)' }}
      >
        {/* Left: avatar + name + meta */}
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={ticket.customer?.name ?? '?'} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-gray-900 truncate">
                {ticket.customer?.name || ticket.customer?.user_id || ticket.id.slice(0, 8)}
              </span>
              {ticket.customer?.tier === 'VIP' && (
                <span className="ds-badge ds-badge-red text-[9px] shrink-0">VIP</span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] font-mono text-gray-400"># {ticket.id.slice(0, 10)}</span>
              {ticket.category && (
                <span className="text-[11px] text-gray-400 capitalize">{ticket.category.replace(/_/g, ' ')}</span>
              )}
              {slaBreachAt && <SLATimer deadline={slaBreachAt} showLabel />}
              {isVirtual && (
                <span className="text-[11px] text-gray-400">{messages.length} msgs</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: resolve + status */}
        <div className="flex items-center gap-2 shrink-0">
          {canReply && !['Closed_Resolved', 'Closed_Unresponsive'].includes(ticket.status) && (
            <button
              onClick={requestResolution}
              className="ds-btn ds-btn-sm ds-btn-success"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4.5 12.75l6 6 9-13.5"/>
              </svg>
              Resolve
            </button>
          )}
          <StatusDropdown
            status={ticket.status}
            onChange={changeStatus}
            canClose={canClose}
            canEscalate={canEscalate}
          />
        </div>
      </div>

      {/* ── Message list ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2" style={{ background: 'linear-gradient(160deg, #f0f4ff 0%, #e8f2f8 100%)' }}>
        {isVirtual && <div style={{ height: topPad }} />}

        {visibleMessages.map((msg, i) => {
          const globalIdx = isVirtual ? virtualRange.start + i : i;
          const showTs = shouldShowTimestamp(messages, globalIdx);
          return <MessageBubble key={globalIdx} msg={msg} showTs={showTs} />;
        })}

        {isVirtual && <div style={{ height: botPad }} />}

        {typingAgents.length > 0 && (
          <div className="self-start flex items-center gap-2 text-xs text-text-muted">
            <div className="flex gap-0.5">
              <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="italic">{typingAgents.join(', ')} typing…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Canned response dropdown ── */}
      {cannedMatches.length > 0 && (
        <div className="mx-3 mb-1 rounded-xl overflow-hidden animate-slide-in-up"
          style={{ background: '#fff', boxShadow: '0 4px 20px rgba(80,100,160,0.12)', border: '1px solid rgba(180,195,220,0.4)' }}>
          {cannedMatches.map(c => (
            <button key={c.id} onClick={() => applyCanned(c.body)}
              className="w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0 transition-colors">
              <span className="font-semibold text-indigo-600">/{c.shortcut}</span>
              <span className="text-text-muted ml-2 text-xs">{c.body.slice(0, 60)}…</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Composer ── */}
      {(canReply || canInternalNote) && (
        <div className="px-4 pb-4 pt-3 shrink-0 bg-white" style={{ borderTop: '1px solid rgba(180,195,220,0.35)' }}>

          {/* Inline AI summary result */}
          {inlineSummary && (
            <div className="mb-2 rounded-xl p-3 flex gap-2 items-start" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
              <svg className="w-3.5 h-3.5 text-indigo-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wide mb-1">AI Summary</div>
                <p className="text-xs text-gray-700 leading-relaxed">{inlineSummary}</p>
              </div>
              <button onClick={() => setInlineSummary('')} className="text-gray-400 hover:text-gray-600 shrink-0">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) { handleFiles(e.target.files); e.target.value = ''; } }}
          />

          {/* Glass card composer */}
          <div
            className={`rounded-xl overflow-hidden transition-all ${isDragOver ? 'ring-2 ring-indigo-400' : isNote ? 'ring-2 ring-amber-300' : 'ring-1 ring-gray-200 focus-within:ring-2 focus-within:ring-indigo-300'}`}
            style={{ background: '#ffffff', boxShadow: '0 1px 8px rgba(80,100,160,0.08)' }}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); handleFiles(e.clipboardData.files); } }}
          >
            {/* Mode + channel row */}
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 flex-wrap">
              {/* Mode toggle */}
              <div className="ds-toggle">
                {canReply && (
                  <button
                    onClick={() => setIsNote(false)}
                    className={`ds-toggle-item ${!isNote ? 'ds-toggle-reply-active' : ''}`}
                  >
                    Reply
                  </button>
                )}
                {canInternalNote && (
                  <button
                    onClick={() => setIsNote(true)}
                    className={`ds-toggle-item ${isNote ? 'ds-toggle-note-active' : ''}`}
                  >
                    Note
                  </button>
                )}
              </div>

              {/* Channel pills — Reply mode only */}
              {!isNote && (
                <div className="flex items-center gap-1">
                  {REPLY_CHANNELS.map(ch => {
                    const fbLocked = ch === 'facebook' && isFbWindowClosed(messages);
                    return (
                      <button key={ch}
                        onClick={() => !fbLocked && setReplyChannel(ch)}
                        disabled={fbLocked}
                        title={fbLocked ? 'Facebook 24h window closed' : ch}
                        className={`text-[10px] px-2 py-0.5 rounded-full capitalize transition-colors font-medium ${
                          replyChannel === ch && !isNote
                            ? 'bg-indigo-600 text-white'
                            : fbLocked
                            ? 'text-gray-300 cursor-not-allowed'
                            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                        }`}>
                        {ch}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* AI Draft label */}
              {isAiDraft && !isNote && (
                <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-indigo-500">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
                  </svg>
                  AI Draft
                </span>
              )}
            </div>

            {/* Facebook 24h warning */}
            {!isNote && replyChannel === 'facebook' && isFbWindowClosed(messages) && (
              <div className="mx-3 mb-1 flex items-center gap-2 text-xs text-amber-700 bg-amber-50 ring-1 ring-amber-200 px-3 py-2 rounded-lg">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                </svg>
                Facebook 24h messaging window has closed.
              </div>
            )}

            {/* Attachment previews */}
            {pendingAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-2">
                {pendingAttachments.map((a) => (
                  <div key={a.id} className="relative group">
                    {a.mime_type.startsWith('image/') ? (
                      <img src={a.url} alt={a.name} className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
                    ) : (
                      <div className="w-14 h-14 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-[10px] text-gray-500 text-center px-1 break-all">{a.name}</div>
                    )}
                    <button
                      className="absolute -top-1 -right-1 w-4 h-4 bg-gray-700 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setPendingAttachments(prev => prev.filter(x => x.id !== a.id))}
                    >×</button>
                  </div>
                ))}
                {uploadingFiles && <div className="w-14 h-14 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-[10px] text-gray-400">…</div>}
              </div>
            )}

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={reply}
              onChange={e => handleReplyChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={isNote ? 'Internal note… (↵ to send)' : `Reply via ${replyChannel}… (/ for canned, ↵ to send)`}
              className={`w-full text-sm px-3.5 py-2.5 resize-none outline-none leading-relaxed min-h-[72px] bg-transparent placeholder:text-gray-400 ${
                isNote ? 'text-amber-900 placeholder:text-amber-400' : 'text-gray-900'
              }`}
              rows={3}
            />

            {/* Bottom bar: AI actions + char count + send */}
            <div className="flex items-center gap-1.5 px-2.5 py-2" style={{ borderTop: '1px solid rgba(180,195,220,0.3)' }}>
              {/* AI Copilot quick actions */}
              <button
                onClick={handleSuggestReply}
                disabled={!!aiLoading}
                title="AI Suggest Reply"
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full font-medium text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-40"
              >
                {aiLoading === 'suggest' ? (
                  <Spinner size="xs" className="text-indigo-500" />
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
                  </svg>
                )}
                Suggest
              </button>

              <button
                onClick={handleSummarize}
                disabled={!!aiLoading}
                title="Summarize conversation"
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full font-medium text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40"
              >
                {aiLoading === 'summarize' ? (
                  <Spinner size="xs" className="text-blue-500" />
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"/>
                  </svg>
                )}
                Summarize
              </button>

              {/* Paperclip — reply mode only, not internal notes */}
              {!isNote && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach file"
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
              )}

              <div className="flex-1" />

              <span className="text-[10px] text-gray-400">{reply.length > 0 ? `${reply.length} chars` : '⌘↵'}</span>

              <button
                onClick={send}
                disabled={(!reply.trim() && !pendingAttachments.length) || sending}
                className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-xl font-semibold disabled:opacity-30 transition-colors active:scale-[0.98] shadow-sm"
              >
                {sending ? <Spinner size="xs" className="text-white" /> : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/>
                  </svg>
                )}
                {sending ? 'Sending' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
