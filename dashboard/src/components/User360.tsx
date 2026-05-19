import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePermissions } from '../PermissionContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface KYCInfo {
  status: string;
  kyc_tier?: number;
  rejection_reason?: string;
  reviewed_at?: string;
}

interface Restriction {
  restriction_id: string;
  type: string;
  status: string;
  reason: string;
  applied_at: string;
  expected_lift_at?: string;
  can_self_resolve: boolean;
  resolution_steps?: string;
}

interface UserProfile {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  tier: string;
  kyc: KYCInfo;
  restrictions: {
    has_restrictions: boolean;
    restrictions: Restriction[];
    trading_available: boolean;
    trading_block_reason?: string;
  };
}

interface Transaction {
  transaction_id: string;
  type: string;
  status: string;
  currency: string;
  amount: number;
  fee: number;
  network?: string;
  tx_hash?: string;
  bank_ref?: string;
  created_at: string;
  completed_at?: string;
}

interface Page<T> {
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

interface SpotTrade {
  order_id: string;
  symbol: string;
  side: string;
  order_type: string;
  status: string;
  price: number;
  quantity: number;
  filled_qty: number;
  fee: number;
  fee_currency: string;
  created_at: string;
  updated_at: string;
}

interface FuturesTrade {
  position_id: string;
  symbol: string;
  side: string;
  status: string;
  leverage: number;
  entry_price: number;
  exit_price?: number;
  quantity: number;
  pnl?: number;
  fee: number;
  liquidation_price?: number;
  created_at: string;
  closed_at?: string;
}

interface Balance {
  currency: string;
  available: number;
  locked: number;
}

interface TicketRow {
  id: string;
  status: string;
  priority: number;
  channel: string;
  category: string;
  tags: string[];
  created_at: string;
  assigned_to_name?: string;
  last_message?: string;
}

type Tab = 'overview' | 'transactions' | 'spot' | 'futures' | 'tickets';
type SearchBy = 'uid' | 'email' | 'phone';

interface CustomerRow {
  id: number;
  bitazza_uid?: string;
  external_id?: string;
  name: string;
  email?: string;
  phone?: string;
  tier?: string;
  kyc_status?: string;
  kyc_tier?: number;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getToken(): string {
  try {
    const u = JSON.parse(localStorage.getItem('auth_user') || '{}');
    return u.token || '';
  } catch { return ''; }
}

function apiBase(): string {
  return (import.meta.env.VITE_API_URL as string | undefined) || (window as any).__API_BASE__ || '';
}

async function apiFetch(path: string) {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Badge components ──────────────────────────────────────────────────────────

const KYC_COLORS: Record<string, string> = {
  approved:            'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40',
  rejected:            'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40',
  pending_information: 'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700/40',
  pending_review:      'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  not_started:         'bg-surface-4 text-text-muted ring-surface-5',
  suspended:           'bg-red-100 text-red-800 ring-red-300 dark:bg-red-900/60 dark:text-red-300 dark:ring-red-700/60',
  expired:             'bg-orange-100 text-orange-700 ring-orange-300 dark:bg-orange-900/40 dark:text-orange-400 dark:ring-orange-700/40',
};

const KYC_TIER_LABELS: Record<number, string> = {
  0: 'Unverified',
  1: 'Basic',
  2: 'Enhanced',
  3: 'Full',
};

const KYC_TIER_COLORS: Record<number, string> = {
  0: 'bg-surface-4 text-text-muted ring-surface-5',
  1: 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40',
  2: 'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  3: 'bg-violet-100 text-violet-700 ring-violet-300 dark:bg-violet-900/40 dark:text-violet-400 dark:ring-violet-700/40',
};

const STATUS_COLORS: Record<string, string> = {
  completed:           'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40',
  pending:             'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700/40',
  failed:              'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40',
  cancelled:           'bg-surface-4 text-text-muted ring-surface-5',
  filled:              'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40',
  partially_filled:    'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  open:                'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  closed:              'bg-surface-4 text-text-secondary ring-surface-5',
  liquidated:          'bg-red-100 text-red-800 ring-red-300 dark:bg-red-900/60 dark:text-red-300 dark:ring-red-700/60',
  Open_Live:           'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  In_Progress:         'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700/40',
  Escalated:           'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40',
  Pending_Customer:    'bg-orange-100 text-orange-700 ring-orange-300 dark:bg-orange-900/40 dark:text-orange-400 dark:ring-orange-700/40',
  Closed_Resolved:     'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40',
  Closed_Unresponsive: 'bg-surface-4 text-text-muted ring-surface-5',
};

const TIER_COLORS: Record<string, string> = {
  VIP:              'bg-red-100 text-red-700 ring-red-300 dark:bg-brand/20 dark:text-brand dark:ring-brand/30',
  EA:               'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-400 dark:ring-sky-700/40',
  'High net worth': 'bg-violet-100 text-violet-700 ring-violet-300 dark:bg-violet-900/40 dark:text-violet-400 dark:ring-violet-700/40',
  regular:          'bg-surface-4 text-text-muted ring-surface-5',
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ring-1 ${color}`}>
      {label}
    </span>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 bg-surface-4 rounded animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-muted">
      <svg className="w-10 h-10 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0H4" />
      </svg>
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-surface-5 text-xs text-text-muted">
      <span>{total} records · page {page} of {totalPages}</span>
      <div className="flex gap-1">
        <button disabled={page === 1} onClick={() => onChange(page - 1)}
          className="px-2.5 py-1 rounded ring-1 ring-surface-5 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          ←
        </button>
        <button disabled={page === totalPages} onClick={() => onChange(page + 1)}
          className="px-2.5 py-1 rounded ring-1 ring-surface-5 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          →
        </button>
      </div>
    </div>
  );
}

// ── Portfolio donut chart ─────────────────────────────────────────────────────

const PORTFOLIO_COLORS = [
  '#E63946', // brand red
  '#3B82F6', // blue
  '#22C55E', // green
  '#F59E0B', // amber
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#14B8A6', // teal
  '#F97316', // orange
];

// approximate THB rates for display valuation
const THB_RATES: Record<string, number> = {
  THB:  1,
  USDT: 34.5,
  BTC:  1_800_000,
  ETH:  92_000,
  XRP:  17,
  SOL:  4_200,
  BNB:  13_800,
  ADA:  16,
};

function toTHB(currency: string, amount: number): number {
  return amount * (THB_RATES[currency] ?? 0);
}

function fmtTHB(n: number): string {
  if (n >= 1_000_000) return '฿' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '฿' + (n / 1_000).toFixed(1) + 'K';
  return '฿' + n.toFixed(0);
}

interface DonutSlice {
  currency: string;
  available: number;
  locked: number;
  thbValue: number;
  pct: number;
  color: string;
}

function buildDonut(cx: number, cy: number, r: number, ir: number, slices: DonutSlice[]) {
  // Returns SVG path data for each slice
  const total = slices.reduce((s, x) => s + x.thbValue, 0);
  if (total === 0) return [];

  const paths: { d: string; color: string; slice: DonutSlice }[] = [];
  let startAngle = -Math.PI / 2; // start at top

  for (const slice of slices) {
    const angle = (slice.thbValue / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const gap = 0.025; // gap between slices in radians

    const s = startAngle + gap / 2;
    const e = endAngle - gap / 2;

    const x1 = cx + r * Math.cos(s);
    const y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e);
    const y2 = cy + r * Math.sin(e);
    const ix1 = cx + ir * Math.cos(e);
    const iy1 = cy + ir * Math.sin(e);
    const ix2 = cx + ir * Math.cos(s);
    const iy2 = cy + ir * Math.sin(s);

    const large = angle > Math.PI ? 1 : 0;

    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ');

    paths.push({ d, color: slice.color, slice });
    startAngle = endAngle;
  }

  return paths;
}

function PortfolioChart({ balances, loading }: { balances: Balance[] | null; loading: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">Portfolio</h3>
        <div className="h-48 bg-surface-4 rounded animate-pulse" />
      </div>
    );
  }

  const nonZero = (balances ?? []).filter(b => b.available + b.locked > 0);

  if (nonZero.length === 0) {
    return (
      <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">Portfolio</h3>
        <div className="flex items-center justify-center h-32 text-text-muted text-xs">No holdings</div>
      </div>
    );
  }

  const totalTHB = nonZero.reduce((s, b) => s + toTHB(b.currency, b.available + b.locked), 0);

  const slices: DonutSlice[] = nonZero
    .map((b, i) => ({
      currency: b.currency,
      available: b.available,
      locked: b.locked,
      thbValue: toTHB(b.currency, b.available + b.locked),
      pct: totalTHB > 0 ? (toTHB(b.currency, b.available + b.locked) / totalTHB) * 100 : 0,
      color: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length],
    }))
    .sort((a, b) => b.thbValue - a.thbValue);

  const cx = 100, cy = 100, r = 78, ir = 50;
  const paths = buildDonut(cx, cy, r, ir, slices);
  const activeSlice = hovered ? slices.find(s => s.currency === hovered) : null;

  return (
    <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Portfolio</h3>
        <span className="text-xs text-text-muted">Est. total: <span className="font-semibold text-text-primary">{fmtTHB(totalTHB)}</span></span>
      </div>

      <div className="flex items-center gap-6">
        {/* Donut */}
        <div className="shrink-0 relative">
          <svg width="200" height="200" viewBox="0 0 200 200">
            {paths.map(({ d, color, slice }) => (
              <path
                key={slice.currency}
                d={d}
                fill={color}
                opacity={hovered && hovered !== slice.currency ? 0.3 : 1}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                onMouseEnter={() => setHovered(slice.currency)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            {/* Center label */}
            <text x={cx} y={cy - 8} textAnchor="middle" className="fill-current" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>
              {activeSlice ? activeSlice.currency : 'Total'}
            </text>
            <text x={cx} y={cy + 10} textAnchor="middle" style={{ fontSize: 14, fontWeight: 600, fill: 'var(--text-primary)' }}>
              {activeSlice ? fmtTHB(activeSlice.thbValue) : fmtTHB(totalTHB)}
            </text>
            <text x={cx} y={cy + 26} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-muted)' }}>
              {activeSlice ? activeSlice.pct.toFixed(1) + '%' : `${slices.length} assets`}
            </text>
          </svg>
        </div>

        {/* Legend */}
        <div className="flex-1 space-y-2 min-w-0">
          {slices.map(s => (
            <div
              key={s.currency}
              className="flex items-center gap-2.5 cursor-pointer"
              style={{ opacity: hovered && hovered !== s.currency ? 0.4 : 1, transition: 'opacity 0.15s' }}
              onMouseEnter={() => setHovered(s.currency)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-xs font-medium text-text-primary w-12 shrink-0">{s.currency}</span>
              <div className="flex-1 h-1 rounded-full bg-surface-4 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${s.pct}%`, backgroundColor: s.color }} />
              </div>
              <span className="text-xs text-text-muted tabular-nums shrink-0 w-16 text-right">{fmtTHB(s.thbValue)}</span>
              <span className="text-xs text-text-muted shrink-0 w-10 text-right">{s.pct.toFixed(1)}%</span>
            </div>
          ))}
          {slices.some(s => s.locked > 0) && (
            <p className="text-[11px] text-text-muted pt-1">* includes locked amounts in open orders</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function User360() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const permissions = usePermissions();
  const hasPerm = (p: string) => permissions.includes(p);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBy, setSearchBy] = useState<SearchBy>('uid');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // Transactions
  const [txData, setTxData] = useState<Page<Transaction> | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txPage, setTxPage] = useState(1);

  // Spot
  const [spotData, setSpotData] = useState<Page<SpotTrade> | null>(null);
  const [spotLoading, setSpotLoading] = useState(false);
  const [spotPage, setSpotPage] = useState(1);

  // Futures
  const [futData, setFutData] = useState<Page<FuturesTrade> | null>(null);
  const [futLoading, setFutLoading] = useState(false);
  const [futPage, setFutPage] = useState(1);

  // Tickets
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);

  // Balances
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);

  // Customer list (shown when no user selected)
  const [custList, setCustList] = useState<Page<CustomerRow> | null>(null);
  const [custPage, setCustPage] = useState(1);
  const [custLoading, setCustLoading] = useState(false);
  const [custError, setCustError] = useState('');

  const loadCustomers = useCallback(async (page: number) => {
    setCustLoading(true);
    setCustError('');
    try {
      const data = await apiFetch(`/api/users?page=${page}&page_size=25`);
      setCustList(data);
      setCustPage(page);
    } catch (err) {
      setCustError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally { setCustLoading(false); }
  }, []);

  useEffect(() => { loadCustomers(1); }, [loadCustomers]);

  const openUser = useCallback(async (uid: string, pushUrl = true) => {
    if (pushUrl) setSearchParams({ uid });
    setSearching(true);
    setSearchError('');
    setUser(null);
    setActiveTab('overview');
    setTxData(null); setSpotData(null); setFutData(null); setTickets(null);
    setBalances(null);
    try {
      const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(uid)}&by=uid`);
      setUser(data);
      if (hasPerm('user360.financials')) {
        setBalancesLoading(true);
        apiFetch(`/api/users/${data.user_id}/balances`)
          .then(b => setBalances(b.balances ?? []))
          .catch(() => setBalances([]))
          .finally(() => setBalancesLoading(false));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'User not found');
    } finally {
      setSearching(false);
    }
  }, [hasPerm, setSearchParams]);

  // Load user from URL param on mount / back-forward navigation
  useEffect(() => {
    const uid = searchParams.get('uid');
    if (uid) openUser(uid, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('uid')]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError('');
    setUser(null);
    setActiveTab('overview');
    setTxData(null); setSpotData(null); setFutData(null); setTickets(null);
    setBalances(null);
    try {
      const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(searchQuery.trim())}&by=${searchBy}`);
      setUser(data);
      setSearchParams({ uid: data.user_id });
      if (hasPerm('user360.financials')) {
        setBalancesLoading(true);
        apiFetch(`/api/users/${data.user_id}/balances`)
          .then(b => setBalances(b.balances ?? []))
          .catch(() => setBalances([]))
          .finally(() => setBalancesLoading(false));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'User not found');
    } finally {
      setSearching(false);
    }
  };

  const loadTab = useCallback(async (tab: Tab, uid: string, page = 1) => {
    setActiveTab(tab);
    if (tab === 'transactions') {
      setTxPage(page);
      setTxLoading(true);
      try {
        const data = await apiFetch(`/api/users/${uid}/transactions?page=${page}&page_size=20`);
        setTxData(data);
      } catch { setTxData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setTxLoading(false); }
    } else if (tab === 'spot') {
      setSpotPage(page);
      setSpotLoading(true);
      try {
        const data = await apiFetch(`/api/users/${uid}/spot-trades?page=${page}&page_size=20`);
        setSpotData(data);
      } catch { setSpotData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setSpotLoading(false); }
    } else if (tab === 'futures') {
      setFutPage(page);
      setFutLoading(true);
      try {
        const data = await apiFetch(`/api/users/${uid}/futures-trades?page=${page}&page_size=20`);
        setFutData(data);
      } catch { setFutData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setFutLoading(false); }
    } else if (tab === 'tickets') {
      setTicketsLoading(true);
      try {
        const data = await apiFetch(`/api/users/${uid}/tickets`);
        setTickets(data);
      } catch { setTickets([]); }
      finally { setTicketsLoading(false); }
    }
  }, []);

  const handleTabClick = (tab: Tab) => {
    if (!user) return;
    if (tab === activeTab && tab !== 'overview') return;
    loadTab(tab, user.user_id);
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...(hasPerm('user360.financials') ? [
      { id: 'transactions' as Tab, label: 'Transactions' },
      { id: 'spot' as Tab, label: 'Spot Trades' },
      { id: 'futures' as Tab, label: 'Futures' },
    ] : []),
    ...(hasPerm('user360.tickets') ? [{ id: 'tickets' as Tab, label: 'Ticket History' }] : []),
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
      {/* Search bar */}
      <div className="px-6 py-4 border-b border-surface-5 bg-surface-1 shrink-0">
        <form onSubmit={handleSearch} className="flex items-center gap-3 max-w-2xl">
          {/* Search by toggle */}
          <div className="flex rounded-md ring-1 ring-surface-5 overflow-hidden shrink-0">
            {(['uid', 'email', 'phone'] as SearchBy[]).map(opt => (
              <button
                key={opt}
                type="button"
                onClick={() => setSearchBy(opt)}
                className={`px-3 py-2 text-xs font-medium transition-colors ${searchBy === opt ? 'bg-brand text-white' : 'bg-surface-3 text-text-secondary hover:bg-surface-4'}`}
              >
                {opt === 'uid' ? 'User ID' : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex-1 relative">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={searchBy === 'uid' ? 'USR-000001' : searchBy === 'email' ? 'user@example.com' : '+66812345601'}
              className="w-full bg-surface-3 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-sm rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
            />
          </div>

          <button
            type="submit"
            disabled={searching}
            className="px-4 py-2 bg-brand text-white text-sm rounded-md hover:bg-brand-dim transition-colors disabled:opacity-60 shrink-0 font-medium"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {searchError && (
          <p className="mt-2 text-xs text-red-400">{searchError}</p>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!user ? (
          <div className="p-6">
            <div className="bg-surface-1 ring-1 ring-surface-5 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">All Customers</h2>
                {custList && <span className="text-xs text-text-muted">{custList.total} total</span>}
              </div>

              {custLoading && !custList ? (
                <Skeleton rows={10} />
              ) : custError ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-muted gap-2">
                  <p className="text-sm text-red-400">{custError}</p>
                  <button onClick={() => loadCustomers(custPage)} className="text-xs text-brand hover:underline">Retry</button>
                </div>
              ) : custList && custList.items.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-5 text-xs text-text-muted uppercase tracking-wide">
                        <th className="px-5 py-2.5 text-left font-medium">Name</th>
                        <th className="px-5 py-2.5 text-left font-medium">Email</th>
                        <th className="px-5 py-2.5 text-left font-medium">User ID</th>
                        <th className="px-5 py-2.5 text-left font-medium">KYC</th>
                        <th className="px-5 py-2.5 text-left font-medium">KYC Tier</th>
                        <th className="px-5 py-2.5 text-left font-medium">Tier</th>
                        <th className="px-5 py-2.5 text-left font-medium">Joined</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-5">
                      {custList.items.map(c => {
                        const uid = c.bitazza_uid || c.external_id || '';
                        return (
                          <tr
                            key={c.id}
                            onClick={() => uid && openUser(uid)}
                            className="hover:bg-surface-3 cursor-pointer transition-colors"
                          >
                            <td className="px-5 py-3 font-medium text-text-primary whitespace-nowrap">
                              {c.name || <span className="text-text-muted italic">—</span>}
                            </td>
                            <td className="px-5 py-3 text-text-secondary">{c.email || '—'}</td>
                            <td className="px-5 py-3 text-text-muted font-mono text-xs">{uid || '—'}</td>
                            <td className="px-5 py-3">
                              {c.kyc_status
                                ? <Badge label={c.kyc_status.replace(/_/g, ' ')} color={KYC_COLORS[c.kyc_status] ?? 'bg-surface-4 text-text-muted ring-surface-5'} />
                                : <span className="text-text-muted">—</span>}
                            </td>
                            <td className="px-5 py-3">
                              {c.kyc_tier != null
                                ? <Badge label={`T${c.kyc_tier} · ${KYC_TIER_LABELS[c.kyc_tier] ?? c.kyc_tier}`} color={KYC_TIER_COLORS[c.kyc_tier] ?? KYC_TIER_COLORS[0]} />
                                : <span className="text-text-muted">—</span>}
                            </td>
                            <td className="px-5 py-3">
                              {c.tier
                                ? <Badge label={c.tier} color={TIER_COLORS[c.tier] ?? 'bg-surface-4 text-text-muted ring-surface-5'} />
                                : <span className="text-text-muted">—</span>}
                            </td>
                            <td className="px-5 py-3 text-text-muted text-xs whitespace-nowrap">
                              {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  <Pagination
                    page={custPage}
                    total={custList.total}
                    pageSize={25}
                    onChange={p => loadCustomers(p)}
                  />
                </>
              ) : (
                <Empty message="No customers found" />
              )}
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Back to list */}
            <button
              onClick={() => { setUser(null); setSearchParams({}); }}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
              </svg>
              All Customers
            </button>
            {/* User header card */}
            <div className="bg-surface-3 ring-1 ring-surface-5 rounded-xl p-5">
              <div className="flex items-start gap-4">
                {/* Avatar */}
                <div className="w-14 h-14 rounded-full bg-brand/20 ring-2 ring-brand/30 flex items-center justify-center shrink-0 text-brand text-lg font-bold">
                  {user.first_name[0]}{user.last_name[0]}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-bold text-text-primary">{user.first_name} {user.last_name}</h2>
                    <Badge label={user.tier} color={TIER_COLORS[user.tier] ?? TIER_COLORS.regular} />
                    <Badge label={user.kyc.status.replace(/_/g, ' ')} color={KYC_COLORS[user.kyc.status] ?? ''} />
                    {user.kyc.kyc_tier != null && (
                      <Badge label={`KYC T${user.kyc.kyc_tier} · ${KYC_TIER_LABELS[user.kyc.kyc_tier] ?? user.kyc.kyc_tier}`} color={KYC_TIER_COLORS[user.kyc.kyc_tier] ?? KYC_TIER_COLORS[0]} />
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
                    <span><span className="text-text-secondary font-medium">ID</span> {user.user_id}</span>
                    <span><span className="text-text-secondary font-medium">Email</span> {user.email}</span>
                    <span><span className="text-text-secondary font-medium">Phone</span> {user.phone}</span>
                  </div>
                </div>

                {/* Trading status */}
                <div className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium ring-1 ${user.restrictions.trading_available ? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-400 dark:ring-emerald-700/30' : 'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/30 dark:text-red-400 dark:ring-red-700/30'}`}>
                  {user.restrictions.trading_available ? 'Trading Active' : 'Trading Blocked'}
                </div>
              </div>
            </div>

            {/* Restrictions banner */}
            {user.restrictions.has_restrictions && (
              <div className="bg-red-50 ring-1 ring-red-200 rounded-xl p-4 dark:bg-red-950/40 dark:ring-red-800/40">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-4 h-4 text-red-500 dark:text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                  </svg>
                  <span className="text-xs font-semibold text-red-600 dark:text-red-400">{user.restrictions.restrictions.length} active restriction{user.restrictions.restrictions.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="space-y-2">
                  {user.restrictions.restrictions.map(r => (
                    <div key={r.restriction_id} className="flex items-start gap-3 text-xs">
                      <Badge label={r.type.replace(/_/g, ' ')} color="bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40" />
                      <div>
                        <span className="text-text-secondary">{r.reason}</span>
                        {r.expected_lift_at && <span className="text-text-muted ml-2">· lifts {fmtDate(r.expected_lift_at)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="border-b border-surface-5">
              <div className="flex gap-0">
                {TABS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => handleTabClick(t.id)}
                    className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === t.id ? 'border-brand text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div className="bg-surface-3 ring-1 ring-surface-5 rounded-xl overflow-hidden">

              {/* Overview */}
              {activeTab === 'overview' && (
                <div className="p-5 space-y-4">
                  {/* Top row: KYC + Account status */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* KYC card */}
                    <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4 space-y-3">
                      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">KYC Details</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Status</span>
                          <Badge label={user.kyc.status.replace(/_/g, ' ')} color={KYC_COLORS[user.kyc.status] ?? ''} />
                        </div>
                        {user.kyc.kyc_tier != null && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-text-muted">KYC Tier</span>
                            <Badge label={`Tier ${user.kyc.kyc_tier} · ${KYC_TIER_LABELS[user.kyc.kyc_tier] ?? user.kyc.kyc_tier}`} color={KYC_TIER_COLORS[user.kyc.kyc_tier] ?? KYC_TIER_COLORS[0]} />
                          </div>
                        )}
                        {hasPerm('user360.kyc') && user.kyc.rejection_reason && (
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-xs text-text-muted shrink-0">Reason</span>
                            <span className="text-xs text-red-600 dark:text-red-400 text-right">{user.kyc.rejection_reason}</span>
                          </div>
                        )}
                        {hasPerm('user360.kyc') && user.kyc.reviewed_at && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-text-muted">Reviewed at</span>
                            <span className="text-xs text-text-secondary">{fmtDate(user.kyc.reviewed_at)}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Account status card */}
                    <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4 space-y-3">
                      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Account Status</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Tier</span>
                          <Badge label={user.tier} color={TIER_COLORS[user.tier] ?? TIER_COLORS.regular} />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Trading</span>
                          <span className={`text-xs font-medium ${user.restrictions.trading_available ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                            {user.restrictions.trading_available ? 'Available' : 'Blocked'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Active restrictions</span>
                          <span className={`text-xs font-medium ${user.restrictions.has_restrictions ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {user.restrictions.restrictions.length}
                          </span>
                        </div>
                        {user.restrictions.trading_block_reason && (
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-xs text-text-muted shrink-0">Block reason</span>
                            <span className="text-xs text-red-600 dark:text-red-400 text-right">{user.restrictions.trading_block_reason}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Portfolio chart — full width */}
                  {hasPerm('user360.financials') && (
                    <PortfolioChart balances={balances} loading={balancesLoading} />
                  )}
                </div>
              )}

              {/* Transactions */}
              {activeTab === 'transactions' && (
                <>
                  {txLoading ? <Skeleton /> : !txData || txData.items.length === 0 ? (
                    <Empty message="No transaction history" />
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-surface-5 bg-surface-2">
                              {['ID', 'Type', 'Status', 'Currency', 'Amount', 'Fee', 'Network / Ref', 'Date'].map(h => (
                                <th key={h} className="px-4 py-2.5 text-left text-text-muted font-medium whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {txData.items.map(tx => (
                              <tr key={tx.transaction_id} className="border-b border-surface-5/50 hover:bg-surface-4/30 transition-colors">
                                <td className="px-4 py-2.5 font-mono text-text-muted">{tx.transaction_id}</td>
                                <td className="px-4 py-2.5">
                                  <Badge
                                    label={tx.type}
                                    color={tx.type === 'deposit' ? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40' : 'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700/40'}
                                  />
                                </td>
                                <td className="px-4 py-2.5"><Badge label={tx.status} color={STATUS_COLORS[tx.status] ?? ''} /></td>
                                <td className="px-4 py-2.5 font-medium text-text-primary">{tx.currency}</td>
                                <td className="px-4 py-2.5 text-text-primary tabular-nums">{fmt(tx.amount, tx.currency === 'THB' ? 2 : 8)}</td>
                                <td className="px-4 py-2.5 text-text-muted tabular-nums">{fmt(tx.fee, tx.currency === 'THB' ? 2 : 8)}</td>
                                <td className="px-4 py-2.5 text-text-muted font-mono text-[11px]">
                                  {tx.tx_hash ? tx.tx_hash.slice(0, 12) + '…' : tx.bank_ref ?? tx.network ?? '—'}
                                </td>
                                <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{fmtDate(tx.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pagination page={txPage} total={txData.total} pageSize={txData.page_size} onChange={p => { if (user) loadTab('transactions', user.user_id, p); }} />
                    </>
                  )}
                </>
              )}

              {/* Spot Trades */}
              {activeTab === 'spot' && (
                <>
                  {spotLoading ? <Skeleton /> : !spotData || spotData.items.length === 0 ? (
                    <Empty message="No spot trade history" />
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-surface-5 bg-surface-2">
                              {['Order ID', 'Symbol', 'Side', 'Type', 'Status', 'Price', 'Qty', 'Filled', 'Fee', 'Date'].map(h => (
                                <th key={h} className="px-4 py-2.5 text-left text-text-muted font-medium whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {spotData.items.map(s => (
                              <tr key={s.order_id} className="border-b border-surface-5/50 hover:bg-surface-4/30 transition-colors">
                                <td className="px-4 py-2.5 font-mono text-text-muted">{s.order_id}</td>
                                <td className="px-4 py-2.5 font-medium text-text-primary">{s.symbol}</td>
                                <td className="px-4 py-2.5">
                                  <Badge label={s.side} color={s.side === 'buy' ? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40' : 'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40'} />
                                </td>
                                <td className="px-4 py-2.5 text-text-muted capitalize">{s.order_type}</td>
                                <td className="px-4 py-2.5"><Badge label={s.status.replace(/_/g, ' ')} color={STATUS_COLORS[s.status] ?? ''} /></td>
                                <td className="px-4 py-2.5 tabular-nums text-text-primary">{fmt(s.price, 2)}</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-secondary">{fmt(s.quantity, 6)}</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-secondary">{fmt(s.filled_qty, 6)}</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-muted">{fmt(s.fee, 4)} {s.fee_currency}</td>
                                <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{fmtDate(s.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pagination page={spotPage} total={spotData.total} pageSize={spotData.page_size} onChange={p => { if (user) loadTab('spot', user.user_id, p); }} />
                    </>
                  )}
                </>
              )}

              {/* Futures Trades */}
              {activeTab === 'futures' && (
                <>
                  {futLoading ? <Skeleton /> : !futData || futData.items.length === 0 ? (
                    <Empty message="No futures trade history" />
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-surface-5 bg-surface-2">
                              {['Position ID', 'Symbol', 'Side', 'Status', 'Lev.', 'Entry', 'Exit', 'Qty', 'PnL', 'Fee', 'Date'].map(h => (
                                <th key={h} className="px-4 py-2.5 text-left text-text-muted font-medium whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {futData.items.map(f => (
                              <tr key={f.position_id} className="border-b border-surface-5/50 hover:bg-surface-4/30 transition-colors">
                                <td className="px-4 py-2.5 font-mono text-text-muted">{f.position_id}</td>
                                <td className="px-4 py-2.5 font-medium text-text-primary">{f.symbol}</td>
                                <td className="px-4 py-2.5">
                                  <Badge label={f.side} color={f.side === 'long' ? 'bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:ring-emerald-700/40' : 'bg-red-100 text-red-700 ring-red-300 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700/40'} />
                                </td>
                                <td className="px-4 py-2.5"><Badge label={f.status} color={STATUS_COLORS[f.status] ?? ''} /></td>
                                <td className="px-4 py-2.5 text-text-secondary font-medium">{f.leverage}×</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-primary">{fmt(f.entry_price, 2)}</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-secondary">{f.exit_price != null ? fmt(f.exit_price, 2) : '—'}</td>
                                <td className="px-4 py-2.5 tabular-nums text-text-secondary">{fmt(f.quantity, 4)}</td>
                                                <td className={`px-4 py-2.5 tabular-nums font-medium ${f.pnl == null ? 'text-text-muted' : f.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {f.pnl == null ? '—' : (f.pnl >= 0 ? '+' : '') + fmt(f.pnl, 2)}
                                </td>
                                <td className="px-4 py-2.5 tabular-nums text-text-muted">{fmt(f.fee, 4)}</td>
                                <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{fmtDate(f.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pagination page={futPage} total={futData.total} pageSize={futData.page_size} onChange={p => { if (user) loadTab('futures', user.user_id, p); }} />
                    </>
                  )}
                </>
              )}

              {/* Ticket History */}
              {activeTab === 'tickets' && (
                <>
                  {ticketsLoading ? <Skeleton /> : !tickets || tickets.length === 0 ? (
                    <Empty message="No ticket history" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-surface-5 bg-surface-2">
                            {['Ticket ID', 'Status', 'Priority', 'Channel', 'Category', 'Assigned To', 'Last Message', 'Created'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-text-muted font-medium whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tickets.map(t => (
                            <tr
                              key={t.id}
                              onClick={() => navigate(`/inbox?ticket=${t.id}`)}
                              className="border-b border-surface-5/50 hover:bg-surface-4/50 cursor-pointer transition-colors"
                            >
                              <td className="px-4 py-2.5 font-mono text-brand text-[11px]">{t.id.slice(0, 8)}…</td>
                              <td className="px-4 py-2.5"><Badge label={t.status.replace(/_/g, ' ')} color={STATUS_COLORS[t.status] ?? ''} /></td>
                              <td className="px-4 py-2.5 text-text-muted">{t.priority === 1 ? 'VIP' : t.priority === 2 ? 'EA' : 'Standard'}</td>
                              <td className="px-4 py-2.5 capitalize text-text-secondary">{t.channel}</td>
                              <td className="px-4 py-2.5 text-text-secondary">{t.category?.replace(/_/g, ' ') ?? '—'}</td>
                              <td className="px-4 py-2.5 text-text-muted">{t.assigned_to_name ?? 'Unassigned'}</td>
                              <td className="px-4 py-2.5 text-text-muted max-w-[200px] truncate">{t.last_message ?? '—'}</td>
                              <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{fmtDate(t.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
