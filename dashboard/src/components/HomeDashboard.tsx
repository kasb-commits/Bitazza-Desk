import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { Ticket, Priority, Agent, InboxView, StatusFilter } from '../types';
import { api } from '../api';
import { KpiCard } from './ui/KpiCard';
import { Avatar } from './ui/Avatar';
import { ChannelBadge, PriorityBadge } from './ui/Badge';
import { KpiCardSkeleton } from './ui/Skeleton';
import { EmptyState } from './ui/EmptyState';
import { stripTags } from '../utils/richText';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: string | number | null | undefined): string {
  if (!ts) return '—';
  const asNum = typeof ts === 'number' ? ts : /^\d+$/.test(String(ts)) ? Number(ts) : NaN;
  const d = isNaN(asNum) ? new Date(ts as string) : new Date(asNum * 1000);
  if (isNaN(d.getTime())) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function getUrgencyLevel(ticket: Ticket): 'normal' | 'warning' | 'critical' {
  if (ticket.sla_breached) return 'critical';
  const ts = ticket.sla_deadline ?? ticket.sla_breach_at;
  if (ts) {
    const deadline = new Date(ts).getTime();
    const minsLeft = (deadline - Date.now()) / 60000;
    if (minsLeft < 0) return 'critical';
    if (minsLeft < 60) return 'warning';
    return 'normal';
  }
  const created = ticket.created_at;
  if (!created) return 'normal';
  const epochMs = typeof created === 'number' ? created * 1000
    : /^\d+$/.test(String(created)) ? Number(created) * 1000
    : new Date(created).getTime();
  if (isNaN(epochMs)) return 'normal';
  const ageH = (Date.now() - epochMs) / 3600000;
  if (ageH > 24) return 'critical';
  if (ageH > 4) return 'warning';
  return 'normal';
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const CHANNEL_LABELS: Record<string, string> = {
  web: 'Web', line: 'LINE', facebook: 'Facebook', email: 'Email',
};
const CHANNEL_PIE_COLORS: Record<string, string> = {
  web: '#3b82f6', line: '#22c55e', facebook: '#6366f1', email: '#f59e0b',
};
const CHANNEL_PIE_FALLBACK = '#6b7280';

// ── KPI Icons ─────────────────────────────────────────────────────────────────

const IconTicket = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
    <rect x="9" y="3" width="6" height="4" rx="1"/>
  </svg>
);
const IconChat = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const IconBolt = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const IconStar = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
  </svg>
);
const IconClock = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
);

// ── Ticket Row ────────────────────────────────────────────────────────────────

function TicketRow({ ticket, onClick }: { ticket: Ticket; onClick: () => void }) {
  const name = ticket.customer?.name ?? 'Unknown';
  const urgency = getUrgencyLevel(ticket);
  const urgencyBorder = urgency === 'critical' ? 'border-l-2 border-l-red-400' : urgency === 'warning' ? 'border-l-2 border-l-amber-400' : '';
  const urgencyTime = urgency === 'critical' ? 'text-red-500 font-semibold' : urgency === 'warning' ? 'text-amber-500 font-semibold' : 'text-gray-400';

  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-3 px-4 py-3 border-b border-gray-100 glass-row cursor-pointer transition-colors duration-100 ${urgencyBorder}`}
    >
      <Avatar name={name} size="sm" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-gray-900 truncate">{name}</div>
        <div className="text-xs text-gray-500 truncate mt-0.5">{ticket.last_message ? stripTags(ticket.last_message).trim() || '—' : '—'}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <ChannelBadge channel={ticket.channel as any} size="xs" />
        {ticket.priority !== 3 && <PriorityBadge priority={ticket.priority as Priority} size="xs" />}
        <span className={`text-[10px] w-8 text-right tabular-nums ${urgencyTime}`}>
          {relativeTime(ticket.last_message_at ?? ticket.created_at)}
        </span>
      </div>
    </div>
  );
}

// ── Ticket Table ──────────────────────────────────────────────────────────────

function TicketTable({
  title, badge, tickets, loading, onTicketClick,
}: {
  title: string; badge?: React.ReactNode; tickets: Ticket[];
  loading: boolean; onTicketClick: (id: string) => void;
}) {
  return (
    <div className="glass-table">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{title}</span>
          {badge}
        </div>
        <span className="text-xs text-gray-400">{tickets.length} tickets</span>
      </div>
      <div className="overflow-y-auto flex-1">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                <div className="w-7 h-7 rounded-full bg-gray-200 animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 bg-gray-200 rounded animate-pulse w-2/3" />
                  <div className="h-2 bg-gray-100 rounded animate-pulse w-1/2" />
                </div>
              </div>
            ))
          : tickets.length === 0
            ? <EmptyState title="No tickets" className="h-32" />
            : tickets.map(t => <TicketRow key={t.id} ticket={t} onClick={() => onTicketClick(t.id)} />)
        }
      </div>
    </div>
  );
}

// ── Escalated Strip ───────────────────────────────────────────────────────────

function EscalatedStrip({ tickets, onTicketClick }: { tickets: Ticket[]; onTicketClick: (id: string) => void }) {
  if (tickets.length === 0) return null;
  const shown = tickets.slice(0, 3);
  return (
    <div className="rounded-xl border border-red-200 px-4 py-3 flex flex-col gap-2" style={{ background: 'rgba(239,68,68,0.06)' }}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        <span className="text-xs font-semibold text-red-500 uppercase tracking-wide">
          {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} need immediate attention
        </span>
      </div>
      {shown.map(t => (
        <div key={t.id} onClick={() => onTicketClick(t.id)}
          className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity">
          <Avatar name={t.customer?.name ?? 'Unknown'} size="xs" className="shrink-0" />
          <span className="text-xs font-medium text-gray-800 truncate flex-1">
            {t.customer?.name ?? 'Unknown'}
          </span>
          <ChannelBadge channel={t.channel as any} size="xs" />
          <span className="text-[10px] text-red-400 tabular-nums w-8 text-right shrink-0">
            {relativeTime(t.last_message_at ?? t.created_at)}
          </span>
        </div>
      ))}
      {tickets.length > 3 && (
        <span className="text-[10px] text-gray-400 mt-0.5">+{tickets.length - 3} more — go to Inbox</span>
      )}
    </div>
  );
}

// ── Resolution Card ───────────────────────────────────────────────────────────

function ResolutionCard({ total, resolved }: { total: number; resolved: number }) {
  const rate = total > 0 ? Math.round((resolved / total) * 100) : null;
  const color = rate == null ? 'text-gray-400' : rate >= 70 ? 'text-emerald-600' : rate >= 40 ? 'text-amber-600' : 'text-red-500';
  const barColor = rate == null ? '' : rate >= 70 ? 'bg-emerald-500' : rate >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="glass-card flex flex-col gap-2">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resolution Today</span>
      <div className={`text-3xl font-bold tabular-nums ${color}`}>
        {rate != null ? `${rate}%` : '—'}
      </div>
      <span className="text-xs text-gray-500">
        {resolved} resolved / {total} opened
      </span>
      {rate != null && (
        <div className="mt-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${rate}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Channel Pie Chart ─────────────────────────────────────────────────────────

function ChannelPie({ data }: { data: { channel: string; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const sorted = [...data].sort((a, b) => b.count - a.count);

  if (sorted.length === 0) {
    return (
      <div className="glass-card flex flex-col gap-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Channels Today</span>
        <span className="text-xs text-gray-400">No data yet</span>
      </div>
    );
  }

  const pieData = sorted.map(d => ({
    name: CHANNEL_LABELS[d.channel] ?? d.channel,
    value: d.count,
    color: CHANNEL_PIE_COLORS[d.channel] ?? CHANNEL_PIE_FALLBACK,
  }));

  return (
    <div className="glass-card flex flex-col gap-3">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Channels Today</span>
      <div className="flex items-center gap-4">
        <div className="w-24 h-24 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pieData} dataKey="value" innerRadius="55%" outerRadius="80%" paddingAngle={2} startAngle={90} endAngle={-270} strokeWidth={0}>
                {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 10, border: '1px solid #EDEDF8' }}
                formatter={(v: number, name: string) => [`${v} (${Math.round(v / total * 100)}%)`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          {pieData.map(d => (
            <div key={d.name} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
              <span className="text-xs text-gray-600 truncate flex-1">{d.name}</span>
              <span className="text-xs tabular-nums text-gray-900 font-medium shrink-0">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Today's Summary ───────────────────────────────────────────────────────────

function TodaySummary({ opened, resolved, pending, escalated }: {
  opened: number; resolved: number; pending: number; escalated: number;
}) {
  const rows = [
    { label: 'Opened today',   value: opened,   color: 'text-blue-600'   },
    { label: 'Resolved today', value: resolved,  color: 'text-emerald-600'},
    { label: 'Pending reply',  value: pending,   color: 'text-purple-600' },
    { label: 'Escalated',      value: escalated, color: 'text-red-500'    },
  ];
  return (
    <div className="glass-card flex flex-col gap-3">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Today's Summary</span>
      <div className="flex flex-col gap-2.5">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between">
            <span className="text-xs text-gray-600">{r.label}</span>
            <span className={`text-sm font-bold tabular-nums ${r.color}`}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Agent Activity ────────────────────────────────────────────────────────────

const AGENT_DOT: Record<string, string> = {
  Available:       'bg-emerald-500',
  Busy:            'bg-amber-500',
  Break:           'bg-gray-400',
  after_call_work: 'bg-gray-400',
  Offline:         'bg-gray-300',
  away:            'bg-gray-300',
};

function AgentActivity({ agents }: { agents: Agent[] }) {
  const active = agents.filter(a => a.active !== false && (a.state ?? a.status) !== 'Offline' && (a.state ?? a.status) !== 'away');
  if (active.length === 0) return null;
  return (
    <div className="glass-card-sm" style={{ padding: '14px 16px' }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold text-gray-900">Agent Activity</span>
        <span className="text-[10px] text-gray-400">{active.length} online</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {active.map(a => {
          const state = a.state ?? a.status ?? 'Offline';
          const tickets = Number(a.active_chats ?? a.active_conversation_count ?? 0);
          const max = a.max_chats ?? a.max_capacity ?? 0;
          const dotClass = AGENT_DOT[state] ?? 'bg-gray-300';
          return (
            <div key={a.id} className="flex items-center gap-2 rounded-xl px-3 py-1.5 flex-1 min-w-0" style={{ background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.7)' }}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
              <span className="text-xs font-medium text-gray-800 truncate flex-1">{a.name}</span>
              <span className="text-[10px] tabular-nums text-gray-400 shrink-0">
                {tickets}{max > 0 ? `/${max}` : ''} tickets
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Home Dashboard ────────────────────────────────────────────────────────────

interface HomeDashboardProps {
  onSelectTicket: (id: string) => void;
  onNavigateInbox: (view: InboxView, filter: StatusFilter) => void;
}

export default function HomeDashboard({ onSelectTicket, onNavigateInbox }: HomeDashboardProps) {
  const navigate = useNavigate();
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);
  const [stats, setStats] = useState({ open: 0, active: 0, escalated: 0, pending: 0, resolved: 0, closed: 0 });
  const [analytics, setAnalytics] = useState<{ volume: { total: number; resolved: number; by_channel: { channel: string; count: number }[] } } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const loadRef = useRef<() => void>(() => {});

  const authUser = (() => {
    try { return JSON.parse(localStorage.getItem('auth_user') ?? '{}'); } catch { return {}; }
  })();
  const userName: string = authUser.name ?? '';
  const isSupervisorPlus = ['supervisor', 'admin', 'super_admin'].includes(authUser.role);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const calls: Promise<any>[] = [
          api.getTickets('all_open', ''),
          api.getTicketStats(),
          api.getAnalytics({ date_range: 'today' }),
        ];
        if (isSupervisorPlus) calls.push(api.getAgents());

        const [raw, statsData, analyticsData, agentsData] = await Promise.all(calls);
        const data: Ticket[] = Array.isArray(raw) ? raw : (raw as { tickets: Ticket[] }).tickets ?? [];
        setAllTickets(data);
        setStats(statsData);
        setAnalytics(analyticsData as any);
        if (isSupervisorPlus && agentsData) setAgents(agentsData);
        setLastUpdated(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load. Check your connection.');
      } finally {
        setLoading(false);
      }
    };
    loadRef.current = load;
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = setInterval(() => setSecondsAgo(Math.floor((Date.now() - lastUpdated) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  const handleTicketClick = (id: string) => { onSelectTicket(id); navigate('/inbox'); };

  const toEpoch = (ts: string | number): number => {
    if (typeof ts === 'number') return ts;
    if (/^\d+$/.test(ts)) return Number(ts);
    return new Date(ts).getTime() / 1000;
  };
  const sortByCreated = (a: Ticket, b: Ticket) => toEpoch(b.created_at) - toEpoch(a.created_at);

  const vipTickets = useMemo(() =>
    [...allTickets].filter(t => t.priority === 1).sort(sortByCreated).slice(0, 15), [allTickets]);
  const latestTickets = useMemo(() =>
    [...allTickets].filter(t => t.priority !== 1).sort(sortByCreated).slice(0, 15), [allTickets]);
  const escalatedTickets = useMemo(() =>
    allTickets.filter(t => t.status === 'escalated').sort(sortByCreated), [allTickets]);

  const openCount      = stats.open;
  const activeCount    = stats.active;
  const escalatedCount = stats.escalated;
  const pendingCount   = stats.pending;
  const vipCount       = allTickets.filter(t => t.priority === 1).length;

  const updatedLabel = lastUpdated
    ? secondsAgo < 5 ? 'Just updated' : `Updated ${secondsAgo}s ago`
    : null;

  const firstLoad = loading && allTickets.length === 0;

  return (
    <div className="glass-page flex-1 overflow-y-auto relative">

      <div className="relative max-w-7xl mx-auto p-6 space-y-5" style={{ zIndex: 1 }}>

        {/* Error banner */}
        {error && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 px-4 py-3" style={{ background: 'rgba(239,68,68,0.06)' }}>
            <span className="text-sm text-red-500">{error}</span>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={() => loadRef.current()} className="text-xs font-semibold text-red-500 hover:text-red-400 transition-colors">Retry</button>
              <button onClick={() => setError(null)} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Dismiss</button>
            </div>
          </div>
        )}

        {/* Greeting header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900" style={{ letterSpacing: 0 }}>
              {getGreeting()}{userName ? `, ${userName.split(' ')[0]}` : ''}.
            </h2>
            {escalatedCount === 0 && (
              <p className="text-sm text-gray-500 mt-0.5">Here's what's happening today.</p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0 pt-0.5">
            {updatedLabel && <span className="text-[10px] text-gray-400 tabular-nums">{updatedLabel}</span>}
            <button
              onClick={() => loadRef.current()} disabled={loading} title="Refresh"
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-150 disabled:opacity-40"
              style={{ background: 'rgba(255,255,255,0.75)', border: '1px solid rgba(255,255,255,0.6)', backdropFilter: 'blur(12px)', color: '#6b7280' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#6366f1')}
              onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={loading ? 'animate-spin' : ''}>
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
          </div>
        </div>

        {/* Escalated strip */}
        <EscalatedStrip tickets={escalatedTickets} onTicketClick={handleTicketClick} />

        {/* KPI row */}
        {firstLoad ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <KpiCardSkeleton key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <KpiCard glass icon={<IconTicket />} label="Open Tickets" value={openCount} sub="currently open" accent="blue"
              onClick={() => onNavigateInbox('all_open', 'Open_Live')} />
            <KpiCard glass icon={<IconChat />} label="Active Chats" value={activeCount} sub="in progress" accent="green"
              onClick={() => onNavigateInbox('all_open', 'In_Progress')} />
            <KpiCard glass icon={<IconBolt />} label="Escalated" value={escalatedCount} sub="need attention" accent="red"
              pulse={escalatedCount > 0} onClick={() => onNavigateInbox('all_open', 'Escalated')} />
            <KpiCard glass icon={<IconStar />} label="VIP Tickets" value={vipCount} sub="priority 1" accent="amber"
              onClick={() => onNavigateInbox('by_priority', 'all')} />
            <KpiCard glass icon={<IconClock />} label="Pending" value={pendingCount} sub="awaiting customer" accent="purple"
              onClick={() => onNavigateInbox('all_open', 'Pending_Customer')} />
          </div>
        )}

        {/* Insights row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ResolutionCard
            total={analytics?.volume.total ?? 0}
            resolved={analytics?.volume.resolved ?? 0}
          />
          <ChannelPie data={analytics?.volume.by_channel ?? []} />
          <TodaySummary
            opened={analytics?.volume.total ?? 0}
            resolved={analytics?.volume.resolved ?? 0}
            pending={pendingCount}
            escalated={escalatedCount}
          />
        </div>

        {/* Agent activity — supervisor / admin / super_admin only */}
        {isSupervisorPlus && agents.length > 0 && <AgentActivity agents={agents} />}

        {/* Ticket tables */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5"
          style={{ height: 'calc(100vh - 320px)', minHeight: 300 }}>
          <TicketTable
            title="VIP Tickets"
            badge={
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.1)', color: '#6366f1' }}>
                VIP
              </span>
            }
            tickets={vipTickets} loading={firstLoad} onTicketClick={handleTicketClick}
          />
          <TicketTable title="Latest Tickets" tickets={latestTickets} loading={firstLoad} onTicketClick={handleTicketClick} />
        </div>

      </div>
    </div>
  );
}
