import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TicketDetail, TicketStatus, Message } from '../types';
import { api } from '../api';
import { usePerm } from '../PermissionContext';
import { StatusBadge } from './ui/Badge';
import { Avatar } from './ui/Avatar';
import { SLATimer } from './ui/SLATimer';
import { Spinner } from './ui/Spinner';

// ─── Constants ──────────────────────────────────────────────────────────────

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

// ─── Timestamp grouping ───────────────────────────────────────────────────────

function shouldShowTimestamp(msgs: Message[], index: number): boolean {
  if (index === 0) return true;
  const prev = msgs[index - 1];
  const curr = msgs[index];
  return curr.created_at - prev.created_at > 5 * 60; // 5 min gap
}

function formatTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
          <div className="bg-accent-blue/8 ring-1 ring-accent-blue/25 rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-accent-blue/20">
              <svg className="w-3.5 h-3.5 text-accent-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <div className="bg-accent-amber/10 ring-1 ring-accent-amber/30 rounded-lg px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <svg className="w-3 h-3 text-accent-amber" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <div className="bg-surface-3 ring-1 ring-accent-amber/20 rounded-lg px-3 py-2.5 border-l-2 border-accent-amber">
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
  const isRight    = !isCustomer; // agents and bots on the right
  const label      = isCustomer ? (msg.agent_name || 'Customer') : isBot ? 'Bot' : (msg.agent_name || 'Agent');

  return (
    <div className={`flex flex-col max-w-[72%] ${isRight ? 'self-end items-end' : 'self-start items-start'}`}>
      {showTs && (
        <span className="text-[10px] text-text-muted mb-1 mx-1">{label} · {ts}</span>
      )}
      <div className={`
        px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed
        ${isCustomer
          ? 'bg-surface-3 text-text-primary rounded-xl rounded-tl-sm ring-1 ring-surface-5'
          : isBot
          ? 'bg-surface-2 text-text-secondary italic ring-1 ring-surface-5 rounded-xl rounded-tr-sm'
          : 'bg-brand/8 text-text-primary ring-1 ring-brand/15 rounded-xl rounded-tr-sm'
        }
      `}>
        {isBot && <span className="font-semibold not-italic text-text-muted text-xs mr-1.5">Bot</span>}
        {msg.content}
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages: Message[] = useMemo(() => ticket?.history ?? [], [ticket]);
  const virtualRange = useVirtualRange(messages.length, scrollRef);

  // Reset per-ticket state when the selected ticket changes
  useEffect(() => {
    setTicket(null);
    setReply('');
    setIsAiDraft(false);
    setIsNote(false);
    setLoading(true);
    setTypingAgents([]);
    setCannedMatches([]);
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
        // Use the stable ticketId prop — ticket state may still be null on first mount
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

  const send = async () => {
    if (!reply.trim() || sending || !ticket) return;
    setSending(true);
    try {
      await api.reply(ticket.id, reply.trim(), isNote, replyChannel);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-0">
        <Spinner size="md" className="text-text-muted" />
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
    <div className="flex flex-col h-full bg-surface-0">

      {/* ── Thread Header ── */}
      <div className="px-4 py-2.5 bg-surface-2 border-b border-surface-5 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar name={ticket.customer?.name ?? '?'} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary truncate">
                {ticket.customer?.name || ticket.customer?.user_id || ticket.id.slice(0, 8)}
              </span>
              <StatusBadge status={ticket.status} dot size="xs" />
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-mono text-text-muted"># {ticket.id.slice(0, 10)}</span>
              {ticket.category && (
                <span className="text-[10px] text-text-muted">{ticket.category.replace(/_/g, ' ')}</span>
              )}
              {slaBreachAt && <SLATimer deadline={slaBreachAt} showLabel />}
              {isVirtual && (
                <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded">
                  {messages.length} msgs
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Status buttons */}
        <div className="flex items-center gap-1 flex-wrap justify-end shrink-0">
{STATUS_OPTIONS
            .filter(s => s === 'Escalated' ? canEscalate : canClose)
            .map(s => (
              <button key={s} onClick={() => changeStatus(s)} disabled={ticket.status === s}
                className={`text-xs px-2.5 py-1 rounded ring-1 whitespace-nowrap transition-colors active:scale-[0.98] ${
                  ticket.status === s
                    ? 'bg-surface-4 ring-surface-5 text-text-primary font-medium cursor-default'
                    : 'ring-surface-5 text-text-secondary hover:text-text-primary hover:bg-surface-3'
                } disabled:cursor-default`}>
                {s.replace(/_/g, ' ')}
              </button>
            ))}
        </div>
      </div>

      {/* ── Message list ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
        {isVirtual && <div style={{ height: topPad }} />}

        {visibleMessages.map((msg, i) => {
          const globalIdx = isVirtual ? virtualRange.start + i : i;
          const showTs = shouldShowTimestamp(messages, globalIdx);
          return (
            <MessageBubble
              key={globalIdx}
              msg={msg}
              showTs={showTs}
            />
          );
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
        <div className="mx-4 mb-1 bg-surface-3 ring-1 ring-surface-5 rounded-lg overflow-hidden shadow-panel animate-slide-in-up">
          {cannedMatches.map(c => (
            <button key={c.id} onClick={() => applyCanned(c.body)}
              className="w-full text-left px-3 py-2.5 text-sm hover:bg-surface-4 border-b border-surface-5 last:border-0 transition-colors">
              <span className="font-medium text-brand">/{c.shortcut}</span>
              <span className="text-text-muted ml-2 text-xs">{c.body.slice(0, 60)}…</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Reply composer ── */}
      {(canReply || canInternalNote) && (
        <div className={`px-4 py-3 border-t border-surface-5 shrink-0 ${isNote ? 'bg-accent-amber/8' : 'bg-surface-2'}`}>

          {/* Mode + channel row */}
          <div className="flex items-center gap-2 mb-2.5 flex-wrap">
            {/* Mode toggle */}
            <div className="flex bg-surface-3 ring-1 ring-surface-5 rounded-md overflow-hidden">
              {canReply && (
                <button onClick={() => setIsNote(false)}
                  className={`text-xs px-3 py-1.5 transition-colors ${!isNote ? 'bg-surface-2 text-text-primary font-medium shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>
                  Reply
                </button>
              )}
              {canInternalNote && (
                <button onClick={() => setIsNote(true)}
                  className={`text-xs px-3 py-1.5 transition-colors ${isNote ? 'bg-accent-amber/20 text-accent-amber font-medium' : 'text-text-secondary hover:text-text-primary'}`}>
                  Internal Note
                </button>
              )}
            </div>

            {/* Request Closure chip */}
            {canReply && !['Closed_Resolved', 'Closed_Unresponsive'].includes(ticket.status) && (
              <>
                <div className="w-px h-4 bg-surface-5" />
                <button
                  onClick={requestResolution}
                  className="text-xs px-2.5 py-1.5 rounded-md ring-1 ring-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 whitespace-nowrap transition-colors active:scale-[0.98]"
                >
                  ✓ Request Closure
                </button>
              </>
            )}

            {/* Channel pills — only in Reply mode */}
            {!isNote && (
              <div className="flex items-center gap-1 ml-auto">
                {REPLY_CHANNELS.map(ch => {
                  const fbLocked = ch === 'facebook' && isFbWindowClosed(messages);
                  return (
                    <button key={ch}
                      onClick={() => !fbLocked && setReplyChannel(ch)}
                      disabled={fbLocked}
                      title={fbLocked ? 'Facebook 24h window closed' : ch}
                      className={`text-[10px] px-2 py-1 rounded capitalize transition-colors ${
                        replyChannel === ch && !isNote
                          ? 'bg-brand text-white'
                          : fbLocked
                          ? 'text-text-muted cursor-not-allowed opacity-40'
                          : 'text-text-secondary hover:text-text-primary hover:bg-surface-4'
                      }`}>
                      {ch}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Facebook 24h warning */}
          {!isNote && replyChannel === 'facebook' && isFbWindowClosed(messages) && (
            <div className="mb-2 flex items-center gap-2 text-xs text-brand bg-brand/10 ring-1 ring-brand/20 px-3 py-2 rounded-md">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
              </svg>
              Facebook 24h messaging window has closed.
            </div>
          )}

          {/* AI Draft label */}
          {isAiDraft && !isNote && (
            <div className="mb-2 flex items-center gap-1.5">
              <svg className="w-3 h-3 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
              </svg>
              <span className="text-[10px] font-semibold text-indigo-400">AI Draft</span>
              <span className="text-[10px] text-text-muted">Review before sending</span>
            </div>
          )}

          {/* Compose area */}
          <div className={`ring-1 rounded-lg overflow-hidden transition-colors ${
            isNote ? 'ring-accent-amber/30' : 'ring-surface-5 focus-within:ring-brand'
          }`}>
            <textarea
              ref={textareaRef}
              value={reply}
              onChange={e => handleReplyChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={isNote ? 'Internal note… (↵ to send, ⇧↵ for newline)' : `Reply via ${replyChannel}… (/ for canned responses, ↵ to send, ⇧↵ for newline)`}
              className={`w-full text-sm px-3.5 py-3 resize-none outline-none leading-relaxed min-h-[80px] ${
                isNote ? 'bg-accent-amber/8 text-text-primary placeholder:text-text-muted' : 'bg-surface-2 text-text-primary placeholder:text-text-muted'
              }`}
              rows={3}
            />
            <div className={`flex items-center justify-end gap-2 px-3 py-2 border-t ${isNote ? 'border-accent-amber/20 bg-accent-amber/5' : 'border-surface-5 bg-surface-3'}`}>
              <span className="text-[10px] text-text-muted">{reply.length > 0 ? `${reply.length} chars` : '⌘↵ to send'}</span>
              <button
                onClick={send}
                disabled={!reply.trim() || sending}
                className="flex items-center gap-1.5 bg-brand hover:bg-brand-dim text-white text-xs px-3 py-1.5 rounded font-medium disabled:opacity-30 transition-colors active:scale-[0.98]"
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
