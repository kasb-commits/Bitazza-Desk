import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Ticket, InboxView, StatusFilter, ChannelFilter, TicketStatus, TicketCategory } from '../types';
import { api } from '../api';
import { Avatar } from './ui/Avatar';
import { ConversationRowSkeleton } from './ui/Skeleton';
import { EmptyState } from './ui/EmptyState';
import { stripTags } from '../utils/richText';

// ── View options ───────────────────────────────────────────────────────────────

const VIEWS: { id: InboxView; label: string }[] = [
  { id: 'all_open',    label: 'All Open'    },
  { id: 'mine',        label: 'Mine'        },
  { id: 'unassigned',  label: 'Unassigned'  },
  { id: 'sla_risk',    label: 'SLA Risk'    },
  { id: 'waiting',     label: 'Waiting'     },
  { id: 'by_priority', label: 'Priority'    },
];

// Status filter options
const STATUS_FILTERS: { id: StatusFilter; label: string; dot: string }[] = [
  { id: 'all',                  label: 'Any Status',  dot: '' },
  { id: 'Open_Live',            label: 'Open',        dot: '#00CE80' },
  { id: 'In_Progress',          label: 'Active',      dot: '#528AF1' },
  { id: 'Pending_Customer',     label: 'Pending',     dot: '#F4B72A' },
  { id: 'Escalated',            label: 'Escalated',   dot: '#EF4150' },
  { id: 'Closed_Resolved',      label: 'Resolved',    dot: '#9CA3AF' },
  { id: 'Closed_Unresponsive',  label: 'Closed',      dot: '#EDEDF8' },
];

// Channel filter options
const CHANNEL_FILTERS: { id: ChannelFilter; label: string; icon: string }[] = [
  { id: 'all',   label: 'All Sources', icon: '⊙' },
  { id: 'email', label: 'Email',       icon: '✉' },
  { id: 'web',   label: 'Web',         icon: '⬡' },
  { id: 'app',   label: 'App',         icon: '⊡' },
];

type SortOption = 'newest' | 'oldest' | 'priority' | 'sla';
const SORT_OPTIONS: { id: SortOption; label: string }[] = [
  { id: 'newest',   label: 'Newest first'   },
  { id: 'oldest',   label: 'Oldest first'   },
  { id: 'priority', label: 'Priority'        },
  { id: 'sla',      label: 'SLA deadline'   },
];

// Left accent bar color per status

// Category display config (explicit light-mode colors)
const CATEGORY_LABEL: Partial<Record<TicketCategory, { label: string; bg: string; color: string }>> = {
  kyc_verification:    { label: 'KYC',          bg: '#fce7f3', color: '#9d174d' },
  account_restriction: { label: 'Account',      bg: '#fef3c7', color: '#92400e' },
  password_2fa_reset:  { label: 'Password/2FA', bg: '#dbeafe', color: '#1e40af' },
  fraud_security:      { label: 'Fraud',        bg: '#fee2e2', color: '#991b1b' },
  withdrawal_issue:    { label: 'Withdrawal',   bg: '#ecfdf5', color: '#065f46' },
  unclassified:        { label: 'Unclassified', bg: '#f3f4f6', color: '#6b7280' },
};

// Channel display config
const CHANNEL_LABEL: Record<string, { label: string; bg: string; color: string }> = {
  web:      { label: 'Web',      bg: '#ede9fe', color: '#5b21b6' },
  line:     { label: 'LINE',     bg: '#dcfce7', color: '#166534' },
  facebook: { label: 'Facebook', bg: '#dbeafe', color: '#1e40af' },
  email:    { label: 'Email',    bg: '#f3f4f6', color: '#374151' },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(ts: string | number | null | undefined): string {
  if (!ts) return '';
  const numeric = typeof ts === 'number' ? ts : (typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : NaN);
  const epoch = Number.isFinite(numeric) ? numeric : Math.floor(new Date(ts).getTime() / 1000);
  const s = Math.floor(Date.now() / 1000) - epoch;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(epoch * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isSlaRisk(ticket: Ticket): boolean {
  const dl = ticket.sla_deadline ?? ticket.sla_breach_at;
  if (!dl) return false;
  const diff = new Date(dl).getTime() - Date.now();
  return diff > 0 && diff < 30 * 60 * 1000;
}

// ── Generic portal dropdown ───────────────────────────────────────────────────

function PortalDropdown<T extends string>({
  trigger,
  options,
  value,
  onChange,
}: {
  trigger: (open: boolean, ref: React.RefObject<HTMLButtonElement | null>) => React.ReactNode;
  options: { id: T; label: string; dot?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 176 });
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
      const dropW = Math.max(176, r.width);
      const left  = Math.min(r.left, window.innerWidth - dropW - 8);
      setPos({ top: r.bottom + 4, left: Math.max(8, left), width: dropW });
    }
    setOpen(o => !o);
  };

  // Intercept clicks on the trigger element
  return (
    <>
      <div onClick={handleToggle} style={{ display: 'contents' }}>
        {trigger(open, btnRef)}
      </div>

      {open && createPortal(
        <div
          ref={dropRef}
          className="ds-dropdown animate-slide-in-up"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
        >
          {options.map(opt => (
            <button
              key={opt.id}
              onClick={() => { onChange(opt.id); setOpen(false); }}
              className="ds-dropdown-item"
              style={opt.id === value ? { background: '#F0FEF8', color: '#00CE80', fontWeight: 600 } : {}}
            >
              {opt.dot && (
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: opt.dot }} />
              )}
              <span className="flex-1">{opt.label}</span>
              {opt.id === value && (
                <svg className="w-3.5 h-3.5 shrink-0" style={{ color: '#00CE80' }} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                </svg>
              )}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Stat pill ──────────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-sm font-bold tabular-nums" style={{ color: color ?? '#1f2937' }}>{value}</div>
      <div className="text-[9px] text-gray-400 uppercase tracking-wide leading-tight">{label}</div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  tickets: Ticket[];
  ticketStats: { open: number; active: number; escalated: number };
  selectedId: string | null;
  view: InboxView;
  search: string;
  statusFilter: StatusFilter;
  channelFilter: ChannelFilter;
  onSelect: (id: string) => void;
  onViewChange: (v: InboxView) => void;
  onSearchChange: (s: string) => void;
  onStatusFilterChange: (f: StatusFilter) => void;
  onChannelFilterChange: (f: ChannelFilter) => void;
  onRefresh: () => void;
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ConversationList({
  tickets, ticketStats, selectedId, view, search, statusFilter, channelFilter,
  onSelect, onViewChange, onSearchChange, onStatusFilterChange, onChannelFilterChange, onRefresh,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusMenuPos, setStatusMenuPos] = useState({ top: 0, left: 0 });
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const statusDropRef = useRef<HTMLDivElement>(null);
  const [loading] = useState(false);
  const [sort, setSort] = useState<SortOption>('newest');

  const sortedTickets = [...tickets].sort((a, b) => {
    if (sort === 'priority') return (a.priority ?? 3) - (b.priority ?? 3);
    if (sort === 'sla') {
      const da = a.sla_deadline ?? a.sla_breach_at;
      const db = b.sla_deadline ?? b.sla_breach_at;
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return new Date(da).getTime() - new Date(db).getTime();
    }
    const ta = Number(a.last_message_at ?? a.updated_at ?? a.created_at) || 0;
    const tb = Number(b.last_message_at ?? b.updated_at ?? b.created_at) || 0;
    return sort === 'newest' ? tb - ta : ta - tb;
  });

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const handleBulkStatus = async (status: TicketStatus) => {
    setStatusMenuOpen(false);
    setBulkLoading(true);
    try {
      await Promise.all([...selected].map(id => api.setStatus(id, status)));
      setSelected(new Set());
      onRefresh();
    } catch { /* silent — individual failures don't block the refresh */ } finally {
      setBulkLoading(false);
    }
  };

  const openStatusMenu = () => {
    if (statusBtnRef.current) {
      const r = statusBtnRef.current.getBoundingClientRect();
      setStatusMenuPos({ top: r.bottom + 4, left: r.left });
    }
    setStatusMenuOpen(o => !o);
  };

  // Close status menu on outside click — must exclude both the trigger button AND the dropdown div
  useEffect(() => {
    if (!statusMenuOpen) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideBtn  = statusBtnRef.current?.contains(target) ?? false;
      const insideDrop = statusDropRef.current?.contains(target) ?? false;
      if (!insideBtn && !insideDrop) setStatusMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [statusMenuOpen]);

  const isAllSelected = sortedTickets.length > 0 && sortedTickets.every(t => selected.has(t.id));
  const isPartialSelected = !isAllSelected && sortedTickets.some(t => selected.has(t.id));

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedTickets.map(t => t.id)));
    }
  };

  const BULK_STATUS_OPTIONS: { status: TicketStatus; label: string; dot: string }[] = [
    { status: 'Open_Live',           label: 'Open',            dot: '#00CE80' },
    { status: 'In_Progress',         label: 'In Progress',     dot: '#528AF1' },
    { status: 'Pending_Customer',    label: 'Pending Customer', dot: '#F4B72A' },
    { status: 'Escalated',           label: 'Escalated',       dot: '#EF4150' },
    { status: 'Closed_Resolved',     label: 'Resolved',        dot: '#9CA3AF' },
    { status: 'Closed_Unresponsive', label: 'Closed',          dot: '#EDEDF8' },
  ];

  const currentFilter = STATUS_FILTERS.find(f => f.id === statusFilter) ?? STATUS_FILTERS[0];

  return (
    <aside
      className="w-[320px] shrink-0 flex flex-col"
      style={{
        background: 'var(--surface-1)',
        borderRight: '1px solid var(--surface-5)',
        position: 'relative',
        zIndex: 1,
      }}
    >
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid rgba(180,195,220,0.25)' }}>

        {/* Row 1: stats + refresh */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            <StatPill label="Open"      value={ticketStats.open} />
            <StatPill label="Active"    value={ticketStats.active} color="#528AF1" />
            <StatPill label="Escalated" value={ticketStats.escalated} color={ticketStats.escalated > 0 ? '#EF4150' : undefined} />
          </div>
          <button
            onClick={onRefresh}
            title="Refresh"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
            </svg>
          </button>
        </div>

        {/* Row 2: view | status | sort — three aligned control buttons */}
        <div className="flex items-center gap-1.5">

          {/* View dropdown */}
          <PortalDropdown
            trigger={(open, ref) => (
              <button
                ref={ref}
                className="flex items-center gap-1 text-xs font-medium text-text-secondary px-2 py-1.5 rounded-lg bg-surface-2 ring-1 ring-surface-5 hover:bg-surface-3 transition-all shrink-0"
              >
                <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                </svg>
                <span className="truncate">{VIEWS.find(v => v.id === view)?.label ?? 'View'}</span>
                <svg className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
            )}
            options={VIEWS}
            value={view}
            onChange={onViewChange}
          />

          {/* Status filter dropdown */}
          <PortalDropdown
            trigger={(open, ref) => (
              <button
                ref={ref}
                className="flex items-center gap-1.5 text-xs font-medium text-text-secondary px-2 py-1.5 rounded-lg bg-surface-2 ring-1 ring-surface-5 hover:bg-surface-3 transition-all flex-1 min-w-0"
              >
                {currentFilter.dot
                  ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: currentFilter.dot }} />
                  : <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707l-6.414 6.414A1 1 0 0014 13.828V19a1 1 0 01-.553.894l-4 2A1 1 0 018 21v-7.172a1 1 0 00-.293-.707L1.293 6.707A1 1 0 011 6V4z"/>
                    </svg>
                }
                <span className="truncate">{currentFilter.label}</span>
                <svg className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
            )}
            options={STATUS_FILTERS.map(f => ({ id: f.id, label: f.label, dot: f.dot || undefined }))}
            value={statusFilter}
            onChange={onStatusFilterChange}
          />

          {/* Sort dropdown */}
          <PortalDropdown
            trigger={(open, ref) => (
              <button
                ref={ref}
                className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg ring-1 transition-all shrink-0"
                style={{
                  background: sort !== 'newest' ? '#F0FEF8' : 'var(--surface-2)',
                  color: sort !== 'newest' ? '#00CE80' : 'var(--text-secondary)',
                  border: `1px solid ${sort !== 'newest' ? '#c7d2fe' : 'var(--surface-5)'}`,
                }}
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"/>
                </svg>
              </button>
            )}
            options={SORT_OPTIONS}
            value={sort}
            onChange={v => setSort(v as typeof sort)}
          />

        </div>

        {/* Row 3: Source filter chips */}
        <div className="flex items-center gap-1 mt-2">
          {CHANNEL_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => onChannelFilterChange(f.id)}
              className="flex-1 text-[10px] font-medium py-1 rounded-md transition-all"
              style={channelFilter === f.id
                ? { background: 'var(--surface-4)', color: 'var(--text-primary)', border: '1px solid var(--surface-5)' }
                : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--surface-5)' }
              }
            >
              {f.label}
            </button>
          ))}
        </div>

      </div>

      {/* ── Search ── */}
      <div className="px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid rgba(180,195,220,0.25)' }}>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
          </svg>
          <input
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search conversations…"
            className="w-full bg-gray-50 text-gray-800 text-xs pl-9 pr-3 py-2 rounded-lg outline-none transition-all placeholder:text-gray-400"
            style={{ border: '1px solid rgba(180,195,220,0.4)' }}
            onFocus={e => (e.target.style.borderColor = '#818cf8')}
            onBlur={e => (e.target.style.borderColor = 'rgba(180,195,220,0.4)')}
          />
          {search && (
            <button onClick={() => onSearchChange('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="px-3 py-2 flex items-center gap-2 shrink-0" style={{ background: '#F0FEF8', borderBottom: '1px solid #D3FCEA' }}>
          {/* Select-all checkbox */}
          <button
            onClick={toggleSelectAll}
            className="w-4 h-4 rounded flex items-center justify-center shrink-0"
            style={{ border: `1.5px solid ${isAllSelected ? '#00CE80' : isPartialSelected ? '#00CE80' : '#d1d5db'}`, background: isAllSelected ? '#00CE80' : '#fff', transition: 'all 0.1s' }}
            title={isAllSelected ? 'Deselect all' : 'Select all'}
          >
            {isAllSelected
              ? <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              : isPartialSelected
              ? <span style={{ width: 8, height: 2, background: '#00CE80', borderRadius: 1, display: 'block' }} />
              : null
            }
          </button>

          <span className="text-xs font-medium" style={{ color: '#00CE80' }}>{selected.size} selected</span>

          {/* Select all label */}
          {!isAllSelected && (
            <button onClick={toggleSelectAll} className="text-[10px] underline underline-offset-2" style={{ color: '#00CE80' }}>
              Select all {sortedTickets.length}
            </button>
          )}

          {/* Change Status dropdown trigger */}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              ref={statusBtnRef}
              onClick={openStatusMenu}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full transition-colors disabled:opacity-40"
              style={{ background: '#00CE80', color: '#fff', border: 'none' }}
            >
              {bulkLoading ? 'Updating…' : 'Change status'}
              <svg className={`w-3 h-3 transition-transform ${statusMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
              </svg>
            </button>
            <button onClick={() => setSelected(new Set())} className="transition-colors" style={{ color: '#9CA3AF' }}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Bulk status portal dropdown ── */}
      {statusMenuOpen && createPortal(
        <div
          ref={statusDropRef}
          style={{
            position: 'fixed', top: statusMenuPos.top, left: statusMenuPos.left, zIndex: 9999,
            background: 'var(--surface-2)', border: '1px solid var(--surface-5)',
            borderRadius: 12, boxShadow: 'none',
            minWidth: 180, padding: '4px 0', overflow: 'hidden',
          }}
        >
          <div style={{ padding: '6px 14px 4px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
            Set status for {selected.size} ticket{selected.size > 1 ? 's' : ''}
          </div>
          {BULK_STATUS_OPTIONS.map(opt => (
            <button
              key={opt.status}
              onClick={() => handleBulkStatus(opt.status)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 14px', fontSize: 12, color: 'var(--text-secondary)', border: 'none',
                background: 'transparent', cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-3)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: opt.dot, flexShrink: 0 }} />
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* ── Ticket list ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <ConversationRowSkeleton key={i} />)
        ) : tickets.length === 0 ? (
          <EmptyState
            title="No conversations"
            description={search ? `No results for "${search}"` : 'Nothing here right now.'}
            className="h-48"
          />
        ) : sortedTickets.map(ticket => {
          const risk = isSlaRisk(ticket);
          const lastTs = ticket.last_message_at ?? ticket.updated_at ?? ticket.created_at;
          const isSelected = selectedId === ticket.id;
          const isChecked = selected.has(ticket.id);
          const preview = ticket.last_message ? stripTags(ticket.last_message).trim() || '—' : '—';
          const catCfg = ticket.category ? CATEGORY_LABEL[ticket.category as TicketCategory] : null;
          const chCfg = ticket.channel ? (CHANNEL_LABEL[ticket.channel.toLowerCase()] ?? CHANNEL_LABEL.web) : null;

          return (
            <div
              key={ticket.id}
              onClick={() => onSelect(ticket.id)}
              className="group flex items-start gap-2.5 px-3 py-3.5 cursor-pointer transition-all duration-100"
              style={{
                borderBottom: '1px solid var(--surface-5)',
                background: isSelected ? 'var(--surface-3)' : undefined,
                boxShadow: isSelected ? 'inset 3px 0 0 #00CE80' : undefined,
              }}
              onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-2)'; }}
              onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = ''; }}
            >
              {/* Checkbox — left of avatar, shown on hover or when any selected */}
              <div
                className={`mt-1 shrink-0 transition-opacity duration-100 ${isChecked || selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
                onClick={e => toggleSelect(ticket.id, e)}
              >
                <div
                  className="w-4 h-4 rounded flex items-center justify-center"
                  style={{ border: `1.5px solid ${isChecked ? '#00CE80' : '#d1d5db'}`, background: isChecked ? '#00CE80' : '#fff', transition: 'all 0.1s' }}
                >
                  {isChecked && <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>}
                </div>
              </div>

              {/* Avatar */}
              <Avatar
                name={ticket.customer?.name ?? '?'}
                size="sm"
                className="mt-0.5 shrink-0"
              />

              {/* Content */}
              <div className="flex-1 min-w-0">
                {/* Row 1: name + time */}
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {ticket.customer?.name ?? 'Unknown'}
                    </span>
                    {ticket.customer?.tier === 'VIP' && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: '#FBECEA', color: '#EF4150' }}>VIP</span>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">{timeAgo(lastTs)}</span>
                </div>

                {/* Row 2: last message preview */}
                <p className="text-[12px] truncate leading-relaxed mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  {preview}
                </p>

                {/* Row 3: category + channel + SLA */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {catCfg && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md" style={{ background: catCfg.bg, color: catCfg.color }}>
                      {catCfg.label}
                    </span>
                  )}
                  {chCfg && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md" style={{ background: chCfg.bg, color: chCfg.color }}>
                      {chCfg.label}
                    </span>
                  )}
                  {(risk || ticket.sla_breached) && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md" style={{
                      background: ticket.sla_breached ? '#fef2f2' : '#fffbeb',
                      color: ticket.sla_breached ? '#EF4150' : '#705514',
                    }}>
                      {ticket.sla_breached ? '⚠ SLA Breached' : '⏱ SLA Risk'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
