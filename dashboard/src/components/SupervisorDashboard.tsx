import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Agent, QueueItem, SLARiskTicket, SupervisorStats, ChannelHealth, PendingStale, Ticket } from '../types';
import { api } from '../api';
import { usePerm } from '../PermissionContext';
import { Avatar } from './ui/Avatar';
import { SLATimer } from './ui/SLATimer';
import { AgentCardSkeleton } from './ui/Skeleton';
import { EmptyState } from './ui/EmptyState';

// ── Design tokens ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  background: 'rgba(255,255,255,0.75)',
  border: '1px solid rgba(255,255,255,0.6)',
  borderRadius: 16,
  backdropFilter: 'blur(16px)',
  boxShadow: '0 2px 16px rgba(80,100,160,0.10)',
};

const CARD_HEADER: React.CSSProperties = {
  padding: '14px 20px',
  borderBottom: '1px solid rgba(0,0,0,0.06)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: 1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMins(mins: number | string | null | undefined): string {
  const n = Number(mins);
  if (!n || isNaN(n) || n < 0) return '—';
  const w = Math.floor(n / 10080);
  const d = Math.floor((n % 10080) / 1440);
  const h = Math.floor((n % 1440) / 60);
  const m = Math.round(n % 60);
  if (w > 0) return `${w}w ${d}d`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtSeconds(s: number | string | null | undefined): string {
  const n = Number(s);
  if (!n || isNaN(n)) return '—';
  if (n < 60) return `${Math.round(n)}s`;
  return fmtMins(n / 60);
}

function minutesAgo(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

function fmtAgo(iso: string | null | undefined): string {
  const m = minutesAgo(iso);
  if (m === Infinity) return '—';
  if (m < 1) return 'just now';
  return `${fmtMins(m)} ago`;
}

const STATE_COLOR: Record<string, string> = {
  Available: '#10b981',
  Busy:      '#f59e0b',
  Break:     '#9ca3af',
  Offline:   '#d1d5db',
};

const PRIORITY_LABEL: Record<number, string> = { 1: 'VIP', 2: 'High', 3: 'Normal' };
const PRIORITY_BG: Record<number, string>    = { 1: 'rgba(99,102,241,0.10)', 2: 'rgba(245,158,11,0.10)', 3: 'rgba(0,0,0,0.05)' };
const PRIORITY_FG: Record<number, string>    = { 1: '#6366f1', 2: '#f59e0b', 3: '#9ca3af' };

const AGENT_ROLES = new Set(['agent', 'kyc_agent', 'finance_agent']);

const ROLE_LABEL: Record<string, string> = {
  agent: 'CS', kyc_agent: 'KYC', finance_agent: 'Finance',
  supervisor: 'Supervisor', admin: 'Admin', super_admin: 'Super Admin',
};

const TEAM_SLA_WARN_MINS: Record<string, number> = {
  kyc: 240, withdrawals: 60, cs: 30, default: 30,
};

function agentStatusLine(
  active: number, longestMins: number, idleMins: number,
  breachedCount: number, atRiskCount: number, state: string, team: string,
): { text: string; color: string } {
  if (active === 0 && state === 'Available') {
    const idle = idleMins !== Infinity && idleMins > 10;
    return idle
      ? { text: `Idle ${fmtMins(idleMins)}`, color: '#f59e0b' }
      : { text: 'Available · no open tickets', color: '#9ca3af' };
  }
  if (active === 0) return { text: 'No open tickets', color: '#9ca3af' };

  const parts: string[] = [`${active} open`];
  if (breachedCount > 0) parts.push(`${breachedCount} breached`);
  else if (atRiskCount > 0) parts.push(`${atRiskCount} at risk`);

  const slaWarn = TEAM_SLA_WARN_MINS[team] ?? TEAM_SLA_WARN_MINS.default;
  if (longestMins > slaWarn) parts.push(`oldest ${fmtMins(longestMins)}`);

  const color = breachedCount > 0 ? '#ef4444'
    : atRiskCount > 0 || longestMins > slaWarn ? '#f59e0b'
    : '#9ca3af';

  return { text: parts.join('  ·  '), color };
}

// ── Icons (inline SVG) ────────────────────────────────────────────────────────

function IconRefresh() {
  return (
    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  );
}

// ── Attention Card ────────────────────────────────────────────────────────────

type AttentionColor = 'red' | 'amber' | 'brand' | 'muted';

const ATTENTION_PALETTE: Record<AttentionColor, {
  bg: string; border: string; iconBg: string; iconColor: string;
  numColor: string; btnBg: string; btnColor: string;
}> = {
  red: {
    bg: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)',
    iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
    numColor: '#ef4444', btnBg: 'rgba(239,68,68,0.10)', btnColor: '#ef4444',
  },
  amber: {
    bg: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)',
    iconBg: 'rgba(245,158,11,0.12)', iconColor: '#f59e0b',
    numColor: '#f59e0b', btnBg: 'rgba(245,158,11,0.10)', btnColor: '#f59e0b',
  },
  brand: {
    bg: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)',
    iconBg: 'rgba(99,102,241,0.12)', iconColor: '#6366f1',
    numColor: '#6366f1', btnBg: 'rgba(99,102,241,0.10)', btnColor: '#6366f1',
  },
  muted: {
    bg: 'rgba(255,255,255,0.75)', border: '1px solid rgba(255,255,255,0.6)',
    iconBg: 'rgba(0,0,0,0.05)', iconColor: '#9ca3af',
    numColor: '#1a1d2e', btnBg: 'rgba(0,0,0,0.05)', btnColor: '#6b7280',
  },
};

function AttentionCard({
  count, label, sublabel, color, icon, onFix,
}: {
  count: number;
  label: string;
  sublabel?: string;
  color: AttentionColor;
  icon: React.ReactNode;
  onFix?: () => void;
}) {
  const p = ATTENTION_PALETTE[color];
  return (
    <div style={{
      ...CARD,
      background: p.bg,
      border: p.border,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: p.iconBg, color: p.iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {icon}
        </div>
        {onFix && count > 0 && (
          <button
            onClick={onFix}
            style={{
              fontSize: 11, fontWeight: 600, padding: '4px 10px',
              borderRadius: 8, border: 'none', cursor: 'pointer',
              background: p.btnBg, color: p.btnColor, transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Fix →
          </button>
        )}
      </div>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: p.numColor, lineHeight: 1, letterSpacing: '-0.5px' }}>{count}</div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1d2e', marginTop: 4 }}>{label}</div>
        {sublabel && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sublabel}</div>}
      </div>
    </div>
  );
}

// ── Agent Row ─────────────────────────────────────────────────────────────────

function AgentRow({
  agent, breachedCount, atRiskCount, onClick,
}: {
  agent: Agent; breachedCount: number; atRiskCount: number; onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const state       = agent.state ?? agent.status ?? 'Offline';
  const active      = Number(agent.open_ticket_count ?? 0);
  const longestMins = Number(agent.longest_open_mins ?? 0);
  const idleMins    = minutesAgo(agent.last_activity_at);
  const team        = agent.team ?? 'cs';

  const dotColor = STATE_COLOR[state] ?? '#d1d5db';
  const barColor = breachedCount > 0 ? '#ef4444'
    : atRiskCount > 0 ? '#f59e0b'
    : active === 0 ? '#e5e7eb'
    : '#10b981';

  const pct = active === 0 ? 0 : Math.min(100, (active / 10) * 100);

  const { text: statusText, color: statusColor } = agentStatusLine(
    active, longestMins, idleMins, breachedCount, atRiskCount, state, team
  );

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', textAlign: 'left',
        background: hovered ? 'rgba(99,102,241,0.04)' : 'transparent',
        border: 'none', cursor: 'pointer', transition: 'background 0.15s',
      }}
    >
      {/* Avatar + state dot */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Avatar name={agent.name} size="sm" />
        <span style={{
          position: 'absolute', bottom: -1, right: -1,
          width: 9, height: 9, borderRadius: '50%',
          background: dotColor,
          border: '2px solid rgba(255,255,255,0.9)',
          boxShadow: state === 'Available' ? `0 0 0 2px rgba(16,185,129,0.25)` : undefined,
        }} />
      </div>

      {/* Name + status line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1d2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {agent.name}
          </span>
          <span style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>
            {state} · {ROLE_LABEL[agent.role ?? ''] ?? agent.role ?? ''}
            {agent.shift ? ` · ${agent.shift}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 3, background: '#f0f2f5', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 99, background: barColor, width: `${pct}%`, transition: 'width 0.5s ease' }} />
          </div>
          <span style={{ fontSize: 10, color: statusColor, flexShrink: 0, fontWeight: 500 }}>{statusText}</span>
        </div>
      </div>

      {/* Chevron */}
      <svg width="14" height="14" fill="none" stroke="#d1d5db" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.25 4.5l7.5 7.5-7.5 7.5" />
      </svg>
    </button>
  );
}

// ── Intervention Panel ────────────────────────────────────────────────────────

function InterventionPanel({
  title, count, badgeColor, children,
}: {
  title: string; count: number; badgeColor: 'red' | 'amber' | 'brand'; children: React.ReactNode;
}) {
  const badge = {
    red:   { bg: 'rgba(239,68,68,0.12)', color: '#ef4444' },
    amber: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' },
    brand: { bg: 'rgba(99,102,241,0.12)', color: '#6366f1' },
  }[badgeColor];

  return (
    <div style={CARD}>
      <div style={CARD_HEADER}>
        <span style={SECTION_LABEL}>{title}</span>
        {count > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
            background: badge.bg, color: badge.color,
          }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Assign Dropdown ───────────────────────────────────────────────────────────

function AssignDropdown({ ticketId, agents, onAssigned }: { ticketId: string; agents: Agent[]; onAssigned: () => void }) {
  const available = agents.filter(a => (a.state ?? a.status) === 'Available');
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      const el = document.getElementById('assign-dropdown-' + ticketId);
      if (el && !el.contains(e.target as Node) && e.target !== btnRef.current) setOpen(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, ticketId]);

  function openDropdown() {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(o => !o);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={openDropdown}
        style={{
          fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
          color: '#6366f1', transition: 'all 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
      >
        Assign
      </button>
      {open && createPortal(
        <div
          id={'assign-dropdown-' + ticketId}
          style={{
            position: 'fixed', top: pos.top, right: pos.right, zIndex: 9999,
            background: '#ffffff', border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 10, boxShadow: '0 8px 32px rgba(80,100,160,0.18)',
            minWidth: 160, padding: '4px 0', overflow: 'hidden',
          }}
        >
          {available.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: 12, color: '#9ca3af' }}>No available agents</div>
          ) : available.map(a => (
            <button
              key={a.id}
              onClick={async () => {
                setOpen(false);
                await api.assignTicket(ticketId, a.id).catch(() => null);
                onAssigned();
              }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', fontSize: 12, color: '#374151', border: 'none',
                background: 'transparent', cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Avatar name={a.name} size="xs" />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              {Number(a.active_chats ?? 0) >= Number(a.max_chats ?? 3) && (
                <span style={{ fontSize: 9, color: '#6366f1', fontWeight: 700 }}>Full</span>
              )}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Agent Slide-Over ──────────────────────────────────────────────────────────

function AgentSlideOver({ agent, agents, onClose, onReassign }: {
  agent: Agent; agents: Agent[]; onClose: () => void; onReassign: () => void;
}) {
  const [tickets, setTickets]         = useState<Ticket[]>([]);
  const [loading, setLoading]         = useState(true);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const navigate    = useNavigate();
  const canReassign = usePerm('supervisor.reassign');

  useEffect(() => {
    api.getAgentTickets(agent.id)
      .then(d => setTickets(d ?? []))
      .catch(() => setTickets([]))
      .finally(() => setLoading(false));
  }, [agent.id]);

  const otherAgents = agents.filter(a => a.id !== agent.id && AGENT_ROLES.has(a.role ?? ''));
  const state  = agent.state ?? agent.status ?? 'Offline';
  const active = agent.active_chats ?? agent.active_conversation_count ?? 0;
  const max    = agent.max_chats ?? agent.max_capacity ?? 3;
  const dotColor = STATE_COLOR[state] ?? '#d1d5db';

  async function handleReassign(ticketId: string, agentId: string) {
    setReassigning(null);
    await api.assignTicket(ticketId, agentId).catch(() => null);
    const [updated] = await Promise.all([
      api.getAgentTickets(agent.id).catch(() => tickets),
      onReassign(),
    ]);
    setTickets(updated ?? []);
  }

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9000, backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute', top: 0, right: 0, height: '100%', width: 400,
          background: '#ffffff', boxShadow: '-8px 0 40px rgba(0,0,0,0.14)',
          display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid #f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <Avatar name={agent.name} size="md" />
              <span style={{
                position: 'absolute', bottom: -1, right: -1,
                width: 10, height: 10, borderRadius: '50%',
                background: dotColor, border: '2px solid #fff',
              }} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1d2e' }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {state} · {active}/{max} chats{agent.shift ? ` · ${agent.shift}` : ''}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: '#f9fafb', color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f0f2f5'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; }}
          >
            <IconClose />
          </button>
        </div>

        {/* Last activity */}
        {agent.last_activity_at && (
          <div style={{ padding: '10px 20px', borderBottom: '1px solid #f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>Last message sent</span>
            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{fmtAgo(agent.last_activity_at)}</span>
          </div>
        )}

        {/* Section label */}
        <div style={{ padding: '12px 20px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ ...SECTION_LABEL, fontSize: 10 }}>Open Tickets</span>
          {!loading && tickets.length > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
              background: 'rgba(99,102,241,0.1)', color: '#6366f1',
            }}>{tickets.length}</span>
          )}
        </div>

        {/* Ticket list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '20px', fontSize: 12, color: '#9ca3af' }}>Loading…</div>
          ) : tickets.length === 0 ? (
            <EmptyState title="No active tickets" className="py-10" />
          ) : (
            <div>
              {tickets.map(t => (
                <div
                  key={t.id}
                  style={{ padding: '12px 20px', borderBottom: '1px solid #f9fafb' }}
                >
                  {/* Top row */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6,
                        background: PRIORITY_BG[t.priority], color: PRIORITY_FG[t.priority],
                      }}>{PRIORITY_LABEL[t.priority]}</span>
                      <span style={{ fontSize: 10, color: '#9ca3af', textTransform: 'capitalize' }}>{t.channel}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <SLATimer deadline={t.sla_deadline ?? ''} />
                      {canReassign && (
                        <div style={{ position: 'relative' }}>
                          <button
                            onClick={() => setReassigning(reassigning === t.id ? null : t.id)}
                            style={{
                              fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
                              background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.08)',
                              color: '#6b7280', transition: 'all 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.08)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
                          >
                            Reassign
                          </button>
                          {reassigning === t.id && (
                            <div style={{
                              position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 30,
                              background: '#ffffff', border: '1px solid rgba(0,0,0,0.1)',
                              borderRadius: 10, boxShadow: '0 8px 32px rgba(80,100,160,0.18)',
                              minWidth: 170, padding: '4px 0', overflow: 'hidden',
                            }}>
                              {otherAgents.length === 0 ? (
                                <div style={{ padding: '10px 14px', fontSize: 12, color: '#9ca3af' }}>No other agents</div>
                              ) : otherAgents.map(a => (
                                <button
                                  key={a.id}
                                  onClick={() => handleReassign(t.id, a.id)}
                                  style={{
                                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '8px 14px', fontSize: 12, color: '#374151', border: 'none',
                                    background: 'transparent', cursor: 'pointer', textAlign: 'left',
                                    transition: 'background 0.1s',
                                  }}
                                  onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <Avatar name={a.name} size="xs" />
                                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                                  <span style={{
                                    fontSize: 9, fontWeight: 700,
                                    color: Number(a.active_chats ?? 0) >= Number(a.max_chats ?? 3) ? '#ef4444' : '#9ca3af',
                                  }}>
                                    {a.active_chats ?? 0}/{a.max_chats ?? 3}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Customer + last message */}
                  <button
                    style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={() => { onClose(); navigate(`/inbox?ticket=${t.id}`); }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1d2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.customer_name ?? t.customer?.name ?? t.id.slice(0, 12) + '…'}
                    </div>
                    {t.last_message && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.last_message}
                      </div>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SupervisorDashboard() {
  const [agents, setAgents]               = useState<Agent[]>([]);
  const [queues, setQueues]               = useState<QueueItem[]>([]);
  const [slaRisk, setSlaRisk]             = useState<SLARiskTicket[]>([]);
  const [slaBreachedCount, setSlaBreachedCount] = useState(0);
  const [slaAtRiskCount, setSlaAtRiskCount]     = useState(0);
  const [stats, setStats]                 = useState<SupervisorStats | null>(null);
  const [channelHealth, setChannelHealth] = useState<ChannelHealth[]>([]);
  const [pendingStale, setPendingStale]   = useState<PendingStale[]>([]);
  const [lastUpdated, setLastUpdated]     = useState<Date | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [drillAgent, setDrillAgent]       = useState<Agent | null>(null);

  const slaRef    = useRef<HTMLDivElement>(null);
  const queueRef  = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getSupervisorLive();
      setAgents(data.agents ?? []);
      setQueues(data.queues ?? []);
      setSlaRisk(data.sla_risk ?? []);
      setSlaBreachedCount(data.sla_breached_count ?? 0);
      setSlaAtRiskCount(data.sla_at_risk_count ?? 0);
      setStats(data.stats ?? null);
      setChannelHealth(data.channel_health ?? []);
      setPendingStale(data.pending_stale ?? []);
      setLastUpdated(new Date());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Derived
  const breached      = slaRisk.filter(t => t.sla_breached);
  const vipWaiting    = slaRisk.filter(t => t.tier === 'VIP' || t.tier === 'EA');
  const unassignedQ   = queues.reduce((s, q) => s + Number(q.count), 0);
  const idleAgents    = agents.filter(a => (a.state ?? a.status) === 'Available' && minutesAgo(a.last_activity_at) > 10);
  const stuckAgents   = agents.filter(a => Number(a.longest_open_mins ?? 0) > 45 && (a.active_chats ?? 0) > 0);
  const totalActive   = agents.reduce((s, a) => s + (a.active_chats ?? a.active_conversation_count ?? 0), 0);
  const totalCap      = agents.reduce((s, a) => s + (a.max_chats ?? a.max_capacity ?? 3), 0);
  const teamUtil      = totalCap ? Math.round((totalActive / totalCap) * 100) : 0;
  const botPct        = (() => {
    const c = Number(stats?.bot_contained ?? 0), t = Number(stats?.bot_total ?? 0);
    return t > 0 ? Math.round((c / t) * 100) : null;
  })();
  const oldestQueueMins = queues.reduce((oldest, q) => {
    const m = minutesAgo(q.oldest_at);
    return m < oldest ? m : oldest;
  }, Infinity);
  const needsAttention = slaBreachedCount + slaAtRiskCount + vipWaiting.length + pendingStale.length + idleAgents.length + stuckAgents.length;

  const teamUtilColor = teamUtil > 80 ? '#ef4444' : teamUtil > 50 ? '#f59e0b' : '#10b981';

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: '#eef2f7' }}>
      <div style={{ maxWidth: 1152, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1a1d2e', letterSpacing: '-0.3px', margin: 0 }}>Supervisor</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>Live operations · auto-refreshes every 30s</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {lastUpdated && (
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Updated {lastUpdated.toLocaleTimeString()}</span>
            )}
            <button
              onClick={load}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500,
                padding: '8px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.6)',
                background: 'rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)',
                boxShadow: '0 2px 16px rgba(80,100,160,0.10)', color: '#6b7280',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = '#6366f1'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.75)'; e.currentTarget.style.color = '#6b7280'; }}
            >
              <IconRefresh />
              Refresh
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderRadius: 10,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
            fontSize: 12, color: '#ef4444',
          }}>
            <IconAlert />
            {error}
          </div>
        )}

        {/* ── Attention Strip ── */}
        {!loading && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={SECTION_LABEL}>Needs your attention</span>
              {needsAttention === 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#10b981', fontWeight: 600 }}>
                  <IconCheck /> All clear
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <AttentionCard
                count={slaBreachedCount}
                label="SLA Breached"
                sublabel={slaBreachedCount > 0 ? `Oldest: ${breached[0]?.customer_name ?? 'ticket'}` : 'None right now'}
                color={slaBreachedCount > 0 ? 'red' : 'muted'}
                icon={<IconClock />}
                onFix={() => slaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
              <AttentionCard
                count={slaAtRiskCount}
                label="SLA At Risk"
                sublabel={slaAtRiskCount > 0 ? `${slaAtRiskCount} approaching deadline` : 'All SLAs healthy'}
                color={slaAtRiskCount > 0 ? 'amber' : 'muted'}
                icon={<IconAlert />}
                onFix={() => slaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
              <AttentionCard
                count={vipWaiting.length}
                label="VIP / EA Waiting"
                sublabel={vipWaiting.length > 0 ? vipWaiting.map(t => t.customer_name).filter(Boolean).join(', ') : 'No VIPs waiting'}
                color={vipWaiting.length > 0 ? 'amber' : 'muted'}
                icon={<IconStar />}
                onFix={() => slaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
              <AttentionCard
                count={stuckAgents.length + idleAgents.length}
                label="Agents Need Check"
                sublabel={
                  stuckAgents.length > 0 ? `${stuckAgents.length} agent${stuckAgents.length > 1 ? 's' : ''} stuck 45m+`
                  : idleAgents.length > 0 ? `${idleAgents.length} idle 10m+`
                  : 'Team flowing well'
                }
                color={(stuckAgents.length + idleAgents.length) > 0 ? 'amber' : 'muted'}
                icon={<IconUsers />}
                onFix={() => agentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
            </div>
          </div>
        )}

        {/* ── Today's Performance ── */}
        {stats && !loading && (
          <div style={CARD}>
            <div style={CARD_HEADER}>
              <span style={SECTION_LABEL}>Today's Performance</span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Since midnight Bangkok time</span>
            </div>
            <div style={{ padding: '0 20px', display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
              {[
                { label: 'Opened today',     val: String(stats.opened_today ?? '—') },
                { label: 'Resolved today',   val: String(stats.resolved_today ?? '—'),   sub: stats.resolved_yesterday != null ? `${stats.resolved_yesterday} yesterday` : undefined },
                { label: 'Avg first reply',  val: fmtSeconds(stats.avg_first_response_s ?? stats.avg_first_response_seconds) },
                { label: 'Avg resolution',   val: fmtSeconds(stats.avg_resolution_s ?? stats.avg_resolution_seconds) },
                { label: 'CSAT (7d)',         val: stats.csat_avg != null ? `${Number(stats.csat_avg).toFixed(1)} ★` : '—' },
                { label: 'Bot contained',    val: botPct != null ? `${botPct}%` : '—',   sub: `${stats.bot_active ?? 0} active` },
                { label: 'Team load',        val: `${teamUtil}%`,                         sub: `${totalActive}/${totalCap} chats`, accent: teamUtilColor },
              ].map(({ label, val, sub, accent }, i) => (
                <div
                  key={label}
                  style={{
                    padding: '16px 0',
                    paddingLeft: i === 0 ? 0 : 16,
                    paddingRight: i === 6 ? 0 : 16,
                    borderRight: i < 6 ? '1px solid rgba(0,0,0,0.06)' : undefined,
                  }}
                >
                  <div style={{ fontSize: 22, fontWeight: 700, color: accent ?? '#1a1d2e', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{label}</div>
                  {sub && <div style={{ fontSize: 10, color: '#9ca3af' }}>{sub}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Main 2-col ── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Left — Team (3/5) */}
          <div className="lg:col-span-3" ref={agentsRef}>
            <div style={CARD}>
              <div style={CARD_HEADER}>
                <span style={SECTION_LABEL}>Team</span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  Load{' '}
                  <span style={{ fontWeight: 700, color: teamUtilColor }}>{teamUtil}%</span>
                  <span style={{ color: '#9ca3af' }}> · chats / max · oldest open</span>
                </span>
              </div>

              {loading ? (
                <div style={{ padding: '8px 0' }}>
                  {Array.from({ length: 5 }).map((_, i) => <AgentCardSkeleton key={i} />)}
                </div>
              ) : agents.length === 0 ? (
                <EmptyState title="No agents online" className="py-8" />
              ) : (
                <div>
                  {agents.map(a => {
                    const agentTickets = slaRisk.filter(t =>
                      (t.assigned_to_name === a.name) || (t.assigned_agent_name === a.name)
                    );
                    return (
                      <div key={a.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                        <AgentRow
                          agent={a}
                          breachedCount={agentTickets.filter(t => t.sla_breached).length}
                          atRiskCount={agentTickets.filter(t => !t.sla_breached).length}
                          onClick={() => setDrillAgent(a)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Channel health */}
              {!loading && channelHealth.length > 0 && (
                <>
                  <div style={{ padding: '10px 20px 6px', borderTop: '1px solid rgba(0,0,0,0.06)', background: 'rgba(0,0,0,0.015)' }}>
                    <span style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>By Channel</span>
                  </div>
                  {channelHealth.map(ch => (
                    <div
                      key={ch.channel}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)',
                        fontSize: 12,
                      }}
                    >
                      <span style={{ color: '#6b7280', width: 64, flexShrink: 0, textTransform: 'capitalize' }}>{ch.channel}</span>
                      <span style={{ color: '#1a1d2e', fontWeight: 700, fontVariantNumeric: 'tabular-nums', width: 24 }}>{ch.open_count}</span>
                      <span style={{ color: '#9ca3af' }}>open</span>
                      <span style={{ color: '#1a1d2e', fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginLeft: 8 }}>{ch.queued}</span>
                      <span style={{ color: '#9ca3af' }}>queued</span>
                      {ch.oldest_queued_at && minutesAgo(ch.oldest_queued_at) > 0 && (
                        <span style={{ fontSize: 10, color: minutesAgo(ch.oldest_queued_at) > 15 ? '#ef4444' : '#9ca3af' }}>
                          · oldest {fmtAgo(ch.oldest_queued_at)}
                        </span>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                        {ch.sla_breached_count > 0 && (
                          <span style={{ color: '#ef4444', fontWeight: 700 }}>{ch.sla_breached_count} breached</span>
                        )}
                        {ch.sla_met_pct != null && (
                          <span style={{ color: ch.sla_met_pct >= 90 ? '#10b981' : '#f59e0b', fontWeight: 700 }}>
                            {ch.sla_met_pct}% SLA
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Right — Action panels (2/5) */}
          <div
            className="lg:col-span-2"
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >

            {/* Queue */}
            <div ref={queueRef}>
              <InterventionPanel
                title="Unassigned Queue"
                count={unassignedQ}
                badgeColor={oldestQueueMins > 15 ? 'red' : oldestQueueMins > 5 ? 'amber' : 'brand'}
              >
                {queues.length === 0 ? (
                  <div style={{ padding: '12px 20px', fontSize: 12, color: '#9ca3af' }}>Queue is empty</div>
                ) : (
                  <div>
                    {queues.map((q, i) => {
                      const mins = minutesAgo(q.oldest_at);
                      const urgent = mins !== Infinity && mins > 15;
                      return (
                        <div
                          key={i}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)',
                          }}
                        >
                          <div style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: q.priority === 1 ? '#6366f1' : q.priority === 2 ? '#f59e0b' : '#d1d5db',
                          }} />
                          <span style={{ fontSize: 12, color: '#6b7280', flex: 1, textTransform: 'capitalize' }}>{q.channel}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: urgent ? '#ef4444' : '#1a1d2e', fontVariantNumeric: 'tabular-nums' }}>
                            {q.count}
                          </span>
                          {q.oldest_at && mins !== Infinity && (
                            <span style={{ fontSize: 10, color: urgent ? '#ef4444' : '#9ca3af' }}>
                              oldest {fmtAgo(q.oldest_at)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </InterventionPanel>
            </div>

            {/* SLA at risk + breached */}
            <div ref={slaRef}>
              <InterventionPanel
                title="SLA At Risk"
                count={slaRisk.length}
                badgeColor={breached.length > 0 ? 'red' : 'amber'}
              >
                {slaRisk.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 20px', fontSize: 12, color: '#10b981' }}>
                    <IconCheck /> All SLAs healthy
                  </div>
                ) : (
                  <div style={{ overflowY: 'auto', maxHeight: 280 }}>
                    {slaRisk.map(t => (
                      <div
                        key={t.id}
                        style={{
                          padding: '12px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)',
                          background: t.sla_breached ? 'rgba(239,68,68,0.03)' : 'transparent',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                              {(t.tier === 'VIP' || t.tier === 'EA') && (
                                <span style={{
                                  fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                                  background: 'rgba(99,102,241,0.1)', color: '#6366f1', flexShrink: 0,
                                }}>{t.tier}</span>
                              )}
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#1a1d2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.customer_name ?? <span style={{ fontFamily: 'monospace', color: '#9ca3af' }}>{t.id.slice(0, 10)}…</span>}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af' }}>
                              {t.assigned_to_name ?? t.assigned_agent_name ?? 'Unassigned'}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            {t.sla_deadline
                              ? <SLATimer deadline={t.sla_deadline} />
                              : <span style={{ fontSize: 11, color: '#9ca3af' }}>open {fmtAgo(t.created_at)}</span>
                            }
                            <AssignDropdown ticketId={t.id} agents={agents} onAssigned={load} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </InterventionPanel>
            </div>

            {/* Waiting on customer */}
            {pendingStale.length > 0 && (
              <InterventionPanel title="Waiting on Customer" count={pendingStale.length} badgeColor="amber">
                <div style={{ overflowY: 'auto', maxHeight: 220 }}>
                  {pendingStale.map(t => {
                    const waitMins = minutesAgo(t.last_customer_msg_at ?? t.created_at);
                    const waitLabel = waitMins === Infinity ? '—' : fmtMins(waitMins);
                    return (
                      <div
                        key={t.id}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 20px', borderBottom: '1px solid rgba(0,0,0,0.04)', gap: 8,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {(t.tier === 'VIP' || t.tier === 'EA') && (
                              <span style={{
                                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                                background: 'rgba(99,102,241,0.1)', color: '#6366f1', flexShrink: 0,
                              }}>{t.tier}</span>
                            )}
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#1a1d2e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.customer_name ?? 'Unknown'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.assigned_to_name ?? 'Unassigned'}
                          </div>
                        </div>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600, flexShrink: 0 }}>
                          no reply: {waitLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </InterventionPanel>
            )}

          </div>
        </div>
      </div>

      {drillAgent && (
        <AgentSlideOver
          agent={drillAgent}
          agents={agents}
          onClose={() => setDrillAgent(null)}
          onReassign={load}
        />
      )}
    </div>
  );
}
