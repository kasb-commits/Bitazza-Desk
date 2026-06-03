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
  try { return (JSON.parse(localStorage.getItem('auth_user') || '{}') as { token?: string }).token || ''; }
  catch { return ''; }
}

function apiBase(): string {
  return (import.meta.env.VITE_API_URL as string | undefined) || '';
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
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  background: 'rgba(255,255,255,0.75)',
  border: '1px solid rgba(255,255,255,0.6)',
  borderRadius: 16,
  backdropFilter: 'blur(16px)',
  border: '1px solid #EDEDF8',
};

const INNER_CARD: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #f0f2f5',
  borderRadius: 12,
  border: '1px solid #EDEDF8',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: 0,
};

const T_PRIMARY   = '#1a1d2e';
const T_SECONDARY = '#6b7280';
const T_MUTED     = '#9ca3af';
const BORDER      = '#f0f2f5';

// ── Badge configs ─────────────────────────────────────────────────────────────

const KYC_BADGE: Record<string, { bg: string; color: string }> = {
  approved:            { bg: 'rgba(16,185,129,0.10)',  color: '#059669' },
  rejected:            { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626' },
  pending_information: { bg: 'rgba(245,158,11,0.10)',  color: '#d97706' },
  pending_review:      { bg: 'rgba(59,130,246,0.10)',  color: '#2563eb' },
  not_started:         { bg: 'rgba(0,0,0,0.05)',       color: '#9ca3af' },
  suspended:           { bg: 'rgba(239,68,68,0.12)',   color: '#b91c1c' },
  expired:             { bg: 'rgba(249,115,22,0.10)',  color: '#ea580c' },
};

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  completed:           { bg: 'rgba(16,185,129,0.10)',  color: '#059669' },
  pending:             { bg: 'rgba(245,158,11,0.10)',  color: '#d97706' },
  failed:              { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626' },
  cancelled:           { bg: 'rgba(0,0,0,0.05)',       color: '#9ca3af' },
  filled:              { bg: 'rgba(16,185,129,0.10)',  color: '#059669' },
  partially_filled:    { bg: 'rgba(59,130,246,0.10)',  color: '#2563eb' },
  open:                { bg: 'rgba(59,130,246,0.10)',  color: '#2563eb' },
  closed:              { bg: 'rgba(0,0,0,0.05)',       color: '#6b7280' },
  liquidated:          { bg: 'rgba(239,68,68,0.12)',   color: '#b91c1c' },
  Open_Live:           { bg: 'rgba(34,197,94,0.10)',   color: '#16a34a' },
  In_Progress:         { bg: 'rgba(59,130,246,0.10)',  color: '#2563eb' },
  Escalated:           { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626' },
  Pending_Customer:    { bg: 'rgba(245,158,11,0.10)',  color: '#d97706' },
  Closed_Resolved:     { bg: 'rgba(16,185,129,0.10)',  color: '#059669' },
  Closed_Unresponsive: { bg: 'rgba(0,0,0,0.05)',       color: '#9ca3af' },
};

const TIER_BADGE: Record<string, { bg: string; color: string }> = {
  VIP:              { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626' },
  EA:               { bg: 'rgba(99,102,241,0.10)',  color: '#6366f1' },
  'High net worth': { bg: 'rgba(139,92,246,0.10)',  color: '#7c3aed' },
  regular:          { bg: 'rgba(0,0,0,0.05)',       color: '#9ca3af' },
  Standard:         { bg: 'rgba(0,0,0,0.05)',       color: '#9ca3af' },
};

const KYC_TIER_BADGE: Record<number, { bg: string; color: string }> = {
  0: { bg: 'rgba(0,0,0,0.05)',        color: '#9ca3af' },
  1: { bg: 'rgba(16,185,129,0.10)',   color: '#059669' },
  2: { bg: 'rgba(59,130,246,0.10)',   color: '#2563eb' },
  3: { bg: 'rgba(139,92,246,0.10)',   color: '#7c3aed' },
};

// ── Badge component ───────────────────────────────────────────────────────────

function Badge({ label, cfg }: { label: string; cfg?: { bg: string; color: string } }) {
  const c = cfg ?? { bg: 'rgba(0,0,0,0.05)', color: '#9ca3af' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 20,
      fontSize: 10, fontWeight: 600,
      background: c.bg, color: c.color,
    }}>
      {label}
    </span>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="animate-pulse"
          style={{ height: 36, borderRadius: 8, background: '#f0f2f5', opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function Empty({ message }: { message: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', color: T_MUTED }}>
      <svg width="36" height="36" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ opacity: 0.3, marginBottom: 10 }}>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0H4" />
      </svg>
      <p style={{ fontSize: 13, color: T_MUTED }}>{message}</p>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function Pagination({ page, total, pageSize, onChange }: {
  page: number; total: number; pageSize: number; onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: `1px solid ${BORDER}`, fontSize: 11, color: T_MUTED }}>
      <span>{total} records · page {page} of {totalPages}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {[{ label: '←', target: page - 1, disabled: page === 1 }, { label: '→', target: page + 1, disabled: page === totalPages }].map(btn => (
          <button key={btn.label} disabled={btn.disabled} onClick={() => onChange(btn.target)}
            style={{
              padding: '4px 10px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, cursor: btn.disabled ? 'not-allowed' : 'pointer',
              background: btn.disabled ? '#f9fafb' : '#fff', color: btn.disabled ? T_MUTED : T_SECONDARY, transition: 'all 0.1s',
            }}>{btn.label}</button>
        ))}
      </div>
    </div>
  );
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}`, background: 'rgba(0,0,0,0.018)' }}>
            {headers.map(h => (
              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', whiteSpace: 'nowrap', ...SECTION_LABEL }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TR({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return (
    <tr onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ borderBottom: `1px solid ${BORDER}`, background: hov ? 'rgba(99,102,241,0.03)' : 'transparent', cursor: onClick ? 'pointer' : 'default', transition: 'background 0.1s' }}>
      {children}
    </tr>
  );
}

function TD({ children, mono, muted, right }: { children: React.ReactNode; mono?: boolean; muted?: boolean; right?: boolean }) {
  return (
    <td style={{ padding: '10px 16px', color: muted ? T_MUTED : T_SECONDARY, fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 11 : 12, textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap', fontVariantNumeric: right ? 'tabular-nums' : undefined }}>
      {children}
    </td>
  );
}

// ── PropRow ───────────────────────────────────────────────────────────────────

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ fontSize: 11, color: T_MUTED, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, color: T_PRIMARY, fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

// ── Portfolio Chart ───────────────────────────────────────────────────────────

const PORTFOLIO_COLORS = ['#6366f1','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316'];
const THB_RATES: Record<string, number> = {
  THB: 1, USDT: 34.5, BTC: 1_800_000, ETH: 92_000, XRP: 17, SOL: 4_200, BNB: 13_800, ADA: 16,
};

function toTHB(currency: string, amount: number) { return amount * (THB_RATES[currency] ?? 0); }
function fmtTHB(n: number) {
  if (n >= 1_000_000) return '฿' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '฿' + (n / 1_000).toFixed(1) + 'K';
  return '฿' + n.toFixed(0);
}

interface DonutSlice { currency: string; available: number; locked: number; thbValue: number; pct: number; color: string; }

function buildDonut(cx: number, cy: number, r: number, ir: number, slices: DonutSlice[]) {
  const total = slices.reduce((s, x) => s + x.thbValue, 0);
  if (total === 0) return [];
  const paths: { d: string; color: string; slice: DonutSlice }[] = [];
  let start = -Math.PI / 2;
  for (const slice of slices) {
    const angle = (slice.thbValue / total) * 2 * Math.PI;
    const end = start + angle;
    const gap = 0.025;
    const s = start + gap / 2, e = end - gap / 2;
    const x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
    const ix1 = cx + ir * Math.cos(e), iy1 = cy + ir * Math.sin(e);
    const ix2 = cx + ir * Math.cos(s), iy2 = cy + ir * Math.sin(s);
    const large = angle > Math.PI ? 1 : 0;
    paths.push({ d: [`M ${x1} ${y1}`, `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`, `L ${ix1} ${iy1}`, `A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2}`, 'Z'].join(' '), color: slice.color, slice });
    start = end;
  }
  return paths;
}

function PortfolioChart({ balances, loading }: { balances: Balance[] | null; loading: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (loading) {
    return (
      <div style={{ ...INNER_CARD, padding: 20 }}>
        <div style={{ ...SECTION_LABEL, marginBottom: 14 }}>Portfolio</div>
        <div className="animate-pulse" style={{ height: 180, borderRadius: 8, background: '#f0f2f5' }} />
      </div>
    );
  }

  const nonZero = (balances ?? []).filter(b => b.available + b.locked > 0);
  if (nonZero.length === 0) {
    return (
      <div style={{ ...INNER_CARD, padding: 20 }}>
        <div style={{ ...SECTION_LABEL, marginBottom: 12 }}>Portfolio</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80, color: T_MUTED, fontSize: 12 }}>No holdings</div>
      </div>
    );
  }

  const totalTHB = nonZero.reduce((s, b) => s + toTHB(b.currency, b.available + b.locked), 0);
  const slices: DonutSlice[] = nonZero
    .map((b, i) => ({
      currency: b.currency, available: b.available, locked: b.locked,
      thbValue: toTHB(b.currency, b.available + b.locked),
      pct: totalTHB > 0 ? (toTHB(b.currency, b.available + b.locked) / totalTHB) * 100 : 0,
      color: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length],
    }))
    .sort((a, b) => b.thbValue - a.thbValue);

  const cx = 90, cy = 90, r = 72, ir = 46;
  const paths = buildDonut(cx, cy, r, ir, slices);
  const activeSlice = hovered ? slices.find(s => s.currency === hovered) : null;

  return (
    <div style={{ ...INNER_CARD, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={SECTION_LABEL}>Portfolio</span>
        <span style={{ fontSize: 11, color: T_MUTED }}>
          Est. total: <span style={{ fontWeight: 700, color: T_PRIMARY }}>{fmtTHB(totalTHB)}</span>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ flexShrink: 0 }}>
          <svg width="180" height="180" viewBox="0 0 180 180">
            {paths.map(({ d, color, slice }) => (
              <path key={slice.currency} d={d} fill={color}
                opacity={hovered && hovered !== slice.currency ? 0.25 : 1}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                onMouseEnter={() => setHovered(slice.currency)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            <text x={cx} y={cy - 7} textAnchor="middle" style={{ fontSize: 10, fill: T_MUTED }}>
              {activeSlice ? activeSlice.currency : 'Total'}
            </text>
            <text x={cx} y={cy + 9} textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: T_PRIMARY }}>
              {activeSlice ? fmtTHB(activeSlice.thbValue) : fmtTHB(totalTHB)}
            </text>
            <text x={cx} y={cy + 24} textAnchor="middle" style={{ fontSize: 10, fill: T_MUTED }}>
              {activeSlice ? activeSlice.pct.toFixed(1) + '%' : `${slices.length} assets`}
            </text>
          </svg>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {slices.map(s => (
            <div key={s.currency}
              style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: hovered && hovered !== s.currency ? 0.3 : 1, transition: 'opacity 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHovered(s.currency)} onMouseLeave={() => setHovered(null)}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: T_PRIMARY, width: 44, flexShrink: 0 }}>{s.currency}</span>
              <div style={{ flex: 1, height: 3, borderRadius: 99, background: '#f0f2f5', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 99, background: s.color, width: `${s.pct}%` }} />
              </div>
              <span style={{ fontSize: 11, color: T_MUTED, width: 58, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtTHB(s.thbValue)}</span>
              <span style={{ fontSize: 10, color: T_MUTED, width: 34, textAlign: 'right' }}>{s.pct.toFixed(1)}%</span>
            </div>
          ))}
          {slices.some(s => s.locked > 0) && (
            <p style={{ fontSize: 10, color: T_MUTED, marginTop: 4 }}>* includes locked amounts in open orders</p>
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
  const [searchBy, setSearchBy]       = useState<SearchBy>('uid');
  const [searching, setSearching]     = useState(false);
  const [searchError, setSearchError] = useState('');
  const [user, setUser]               = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab]     = useState<Tab>('overview');

  const [txData, setTxData]               = useState<Page<Transaction> | null>(null);
  const [txLoading, setTxLoading]         = useState(false);
  const [txPage, setTxPage]               = useState(1);
  const [spotData, setSpotData]           = useState<Page<SpotTrade> | null>(null);
  const [spotLoading, setSpotLoading]     = useState(false);
  const [spotPage, setSpotPage]           = useState(1);
  const [futData, setFutData]             = useState<Page<FuturesTrade> | null>(null);
  const [futLoading, setFutLoading]       = useState(false);
  const [futPage, setFutPage]             = useState(1);
  const [tickets, setTickets]             = useState<TicketRow[] | null>(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [balances, setBalances]           = useState<Balance[] | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [custList, setCustList]           = useState<Page<CustomerRow> | null>(null);
  const [custPage, setCustPage]           = useState(1);
  const [custLoading, setCustLoading]     = useState(false);
  const [custError, setCustError]         = useState('');

  const loadCustomers = useCallback(async (page: number) => {
    setCustLoading(true); setCustError('');
    try { const data = await apiFetch(`/api/users?page=${page}&page_size=25`); setCustList(data); setCustPage(page); }
    catch (err) { setCustError(err instanceof Error ? err.message : 'Failed to load customers'); }
    finally { setCustLoading(false); }
  }, []);

  useEffect(() => { loadCustomers(1); }, [loadCustomers]);

  const openUser = useCallback(async (uid: string, pushUrl = true) => {
    if (pushUrl) setSearchParams({ uid });
    setSearching(true); setSearchError(''); setUser(null); setActiveTab('overview');
    setTxData(null); setSpotData(null); setFutData(null); setTickets(null); setBalances(null);
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
    } catch (err) { setSearchError(err instanceof Error ? err.message : 'User not found'); }
    finally { setSearching(false); }
  }, [hasPerm, setSearchParams]);

  useEffect(() => {
    const uid = searchParams.get('uid');
    if (uid) openUser(uid, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('uid')]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true); setSearchError(''); setUser(null); setActiveTab('overview');
    setTxData(null); setSpotData(null); setFutData(null); setTickets(null); setBalances(null);
    try {
      const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(searchQuery.trim())}&by=${searchBy}`);
      setUser(data); setSearchParams({ uid: data.user_id });
      if (hasPerm('user360.financials')) {
        setBalancesLoading(true);
        apiFetch(`/api/users/${data.user_id}/balances`)
          .then(b => setBalances(b.balances ?? []))
          .catch(() => setBalances([]))
          .finally(() => setBalancesLoading(false));
      }
    } catch (err) { setSearchError(err instanceof Error ? err.message : 'User not found'); }
    finally { setSearching(false); }
  };

  const loadTab = useCallback(async (tab: Tab, uid: string, page = 1) => {
    setActiveTab(tab);
    if (tab === 'transactions') {
      setTxPage(page); setTxLoading(true);
      try { setTxData(await apiFetch(`/api/users/${uid}/transactions?page=${page}&page_size=20`)); }
      catch { setTxData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setTxLoading(false); }
    } else if (tab === 'spot') {
      setSpotPage(page); setSpotLoading(true);
      try { setSpotData(await apiFetch(`/api/users/${uid}/spot-trades?page=${page}&page_size=20`)); }
      catch { setSpotData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setSpotLoading(false); }
    } else if (tab === 'futures') {
      setFutPage(page); setFutLoading(true);
      try { setFutData(await apiFetch(`/api/users/${uid}/futures-trades?page=${page}&page_size=20`)); }
      catch { setFutData({ total: 0, page, page_size: 20, items: [] }); }
      finally { setFutLoading(false); }
    } else if (tab === 'tickets') {
      setTicketsLoading(true);
      try { setTickets(await apiFetch(`/api/users/${uid}/tickets`)); }
      catch { setTickets([]); }
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
      { id: 'spot' as Tab,         label: 'Spot Trades'  },
      { id: 'futures' as Tab,      label: 'Futures'      },
    ] : []),
    ...(hasPerm('user360.tickets') ? [{ id: 'tickets' as Tab, label: 'Ticket History' }] : []),
  ];

  const initials = user ? `${user.first_name[0] ?? ''}${user.last_name[0] ?? ''}` : '';

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#eef2f7' }}>

      {/* ── Search bar ── */}
      <div style={{
        padding: '16px 24px', borderBottom: '1px solid rgba(180,195,220,0.3)',
        background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(16px)', flexShrink: 0,
      }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 640 }}>

          {/* Search-by toggle */}
          <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: '1px solid #e5e7eb', flexShrink: 0 }}>
            {(['uid', 'email', 'phone'] as SearchBy[]).map(opt => (
              <button key={opt} type="button" onClick={() => setSearchBy(opt)}
                style={{
                  padding: '7px 14px', fontSize: 12, fontWeight: 500, cursor: 'pointer', border: 'none',
                  background: searchBy === opt ? '#6366f1' : '#f9fafb',
                  color: searchBy === opt ? '#fff' : T_SECONDARY,
                  transition: 'all 0.15s',
                }}
              >
                {opt === 'uid' ? 'User ID' : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>

          {/* Input */}
          <div style={{ flex: 1, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: T_MUTED, pointerEvents: 'none' }}
              width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
            </svg>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={searchBy === 'uid' ? 'USR-000001' : searchBy === 'email' ? 'user@example.com' : '+66812345601'}
              style={{
                width: '100%', padding: '8px 12px 8px 32px', fontSize: 13,
                border: '1px solid #e5e7eb', borderRadius: 10, outline: 'none',
                background: '#fff', color: T_PRIMARY, transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.target.style.borderColor = '#6366f1'; }}
              onBlur={e => { e.target.style.borderColor = '#e5e7eb'; }}
            />
          </div>

          <button type="submit" disabled={searching}
            style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 600, borderRadius: 10, border: 'none', cursor: searching ? 'not-allowed' : 'pointer',
              background: 'linear-gradient(135deg, #6366f1, #818cf8)', color: '#fff',
              border: '1px solid #D3FCEA', opacity: searching ? 0.6 : 1, flexShrink: 0, transition: 'all 0.15s',
            }}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {searchError && <p style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>{searchError}</p>}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        {!user ? (

          /* ── Customer list ── */
          <div style={{ padding: 24 }}>
            <div style={CARD}>
              <div style={{ padding: '16px 20px', borderBottom: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: T_PRIMARY, letterSpacing: 0 }}>All Customers</span>
                {custList && <span style={{ fontSize: 11, color: T_MUTED }}>{custList.total} total</span>}
              </div>

              {custLoading && !custList ? (
                <Skeleton rows={10} />
              ) : custError ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px', gap: 8 }}>
                  <p style={{ fontSize: 12, color: '#ef4444' }}>{custError}</p>
                  <button onClick={() => loadCustomers(custPage)}
                    style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    Retry
                  </button>
                </div>
              ) : custList && custList.items.length > 0 ? (
                <>
                  <Table headers={['Name', 'Email', 'User ID', 'KYC', 'KYC Tier', 'Account Tier', 'Joined']}>
                    {custList.items.map(c => {
                      const uid = c.bitazza_uid || c.external_id || '';
                      return (
                        <TR key={c.id} onClick={uid ? () => openUser(uid) : undefined}>
                          <TD><span style={{ fontWeight: 600, color: T_PRIMARY }}>{c.name || <span style={{ color: T_MUTED, fontStyle: 'italic' }}>—</span>}</span></TD>
                          <TD muted>{c.email || '—'}</TD>
                          <TD mono muted>{uid || '—'}</TD>
                          <TD>
                            {c.kyc_status
                              ? <Badge label={c.kyc_status.replace(/_/g, ' ')} cfg={KYC_BADGE[c.kyc_status]} />
                              : <span style={{ color: T_MUTED }}>—</span>}
                          </TD>
                          <TD>
                            {c.kyc_tier != null
                              ? <Badge label={`Tier ${c.kyc_tier}`} cfg={KYC_TIER_BADGE[c.kyc_tier] ?? KYC_TIER_BADGE[0]} />
                              : <span style={{ color: T_MUTED }}>—</span>}
                          </TD>
                          <TD>
                            {c.tier
                              ? <Badge label={c.tier} cfg={TIER_BADGE[c.tier]} />
                              : <span style={{ color: T_MUTED }}>—</span>}
                          </TD>
                          <TD muted>{new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</TD>
                        </TR>
                      );
                    })}
                  </Table>
                  <Pagination page={custPage} total={custList.total} pageSize={25} onChange={p => loadCustomers(p)} />
                </>
              ) : (
                <Empty message="No customers found" />
              )}
            </div>
          </div>

        ) : (

          /* ── User profile ── */
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Back */}
            <button
              onClick={() => { setUser(null); setSearchParams({}); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T_MUTED, background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: 'fit-content', transition: 'color 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.color = T_PRIMARY; }}
              onMouseLeave={e => { e.currentTarget.style.color = T_MUTED; }}
            >
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
              </svg>
              All Customers
            </button>

            {/* ── User header card ── */}
            <div style={CARD}>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>

                  {/* Avatar */}
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: 'linear-gradient(135deg, #6366f1, #818cf8)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18, fontWeight: 700, color: '#fff', flexShrink: 0,
                    border: '1px solid #D3FCEA',
                  }}>
                    {initials}
                  </div>

                  {/* Identity */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <h2 style={{ fontSize: 18, fontWeight: 700, color: T_PRIMARY, margin: 0, letterSpacing: 0 }}>
                        {user.first_name} {user.last_name}
                      </h2>
                      <Badge label={user.tier} cfg={TIER_BADGE[user.tier] ?? TIER_BADGE.Standard} />
                      <Badge label={user.kyc.status.replace(/_/g, ' ')} cfg={KYC_BADGE[user.kyc.status]} />
                      {user.kyc.kyc_tier != null && (
                        <Badge label={`KYC T${user.kyc.kyc_tier}`} cfg={KYC_TIER_BADGE[user.kyc.kyc_tier] ?? KYC_TIER_BADGE[0]} />
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px', fontSize: 12, color: T_MUTED }}>
                      <span><span style={{ color: T_SECONDARY, fontWeight: 500 }}>ID</span> {user.user_id}</span>
                      <span><span style={{ color: T_SECONDARY, fontWeight: 500 }}>Email</span> {user.email}</span>
                      <span><span style={{ color: T_SECONDARY, fontWeight: 500 }}>Phone</span> {user.phone}</span>
                    </div>
                  </div>

                  {/* Trading status */}
                  <div style={{
                    flexShrink: 0, padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    background: user.restrictions.trading_available ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
                    color: user.restrictions.trading_available ? '#059669' : '#dc2626',
                    border: `1px solid ${user.restrictions.trading_available ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}>
                    {user.restrictions.trading_available ? '✓ Trading Active' : '✕ Trading Blocked'}
                  </div>
                </div>

                {/* Restrictions banner */}
                {user.restrictions.has_restrictions && (
                  <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 12, background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <svg width="14" height="14" fill="none" stroke="#ef4444" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                      </svg>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626' }}>
                        {user.restrictions.restrictions.length} active restriction{user.restrictions.restrictions.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {user.restrictions.restrictions.map(r => (
                        <div key={r.restriction_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 11 }}>
                          <Badge label={r.type.replace(/_/g, ' ')} cfg={{ bg: 'rgba(239,68,68,0.10)', color: '#dc2626' }} />
                          <div style={{ color: T_SECONDARY }}>
                            {r.reason}
                            {r.expected_lift_at && <span style={{ color: T_MUTED, marginLeft: 6 }}>· lifts {fmtDate(r.expected_lift_at)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Tab bar ── */}
            <div style={{
              display: 'flex', gap: 2, padding: 4, borderRadius: 12, width: 'fit-content',
              background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.6)',
              backdropFilter: 'blur(8px)',
            }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => handleTabClick(t.id)}
                  style={{
                    padding: '6px 16px', fontSize: 12, fontWeight: 500, borderRadius: 8,
                    border: 'none', cursor: 'pointer', transition: 'all 0.15s',
                    background: activeTab === t.id ? '#fff' : 'transparent',
                    color: activeTab === t.id ? '#6366f1' : T_MUTED,
                    boxShadow: activeTab === t.id ? '0 1px 6px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── Tab content card ── */}
            <div style={CARD}>

              {/* Overview */}
              {activeTab === 'overview' && (
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                    {/* KYC card */}
                    <div style={{ ...INNER_CARD, padding: 16 }}>
                      <div style={{ ...SECTION_LABEL, marginBottom: 12 }}>KYC Details</div>
                      <PropRow label="Status">
                        <Badge label={user.kyc.status.replace(/_/g, ' ')} cfg={KYC_BADGE[user.kyc.status]} />
                      </PropRow>
                      {user.kyc.kyc_tier != null && (
                        <PropRow label="KYC Tier">
                          <Badge label={`Tier ${user.kyc.kyc_tier}`} cfg={KYC_TIER_BADGE[user.kyc.kyc_tier] ?? KYC_TIER_BADGE[0]} />
                        </PropRow>
                      )}
                      {hasPerm('user360.kyc') && user.kyc.rejection_reason && (
                        <PropRow label="Rejection reason">
                          <span style={{ color: '#dc2626', fontSize: 11 }}>{user.kyc.rejection_reason}</span>
                        </PropRow>
                      )}
                      {hasPerm('user360.kyc') && user.kyc.reviewed_at && (
                        <PropRow label="Reviewed at">{fmtDate(user.kyc.reviewed_at)}</PropRow>
                      )}
                    </div>

                    {/* Account status card */}
                    <div style={{ ...INNER_CARD, padding: 16 }}>
                      <div style={{ ...SECTION_LABEL, marginBottom: 12 }}>Account Status</div>
                      <PropRow label="Tier">
                        <Badge label={user.tier} cfg={TIER_BADGE[user.tier] ?? TIER_BADGE.Standard} />
                      </PropRow>
                      <PropRow label="Trading">
                        <span style={{ color: user.restrictions.trading_available ? '#059669' : '#dc2626', fontWeight: 600 }}>
                          {user.restrictions.trading_available ? 'Available' : 'Blocked'}
                        </span>
                      </PropRow>
                      <PropRow label="Active restrictions">
                        <span style={{ color: user.restrictions.has_restrictions ? '#dc2626' : '#059669', fontWeight: 600 }}>
                          {user.restrictions.restrictions.length}
                        </span>
                      </PropRow>
                      {user.restrictions.trading_block_reason && (
                        <PropRow label="Block reason">
                          <span style={{ color: '#dc2626', fontSize: 11 }}>{user.restrictions.trading_block_reason}</span>
                        </PropRow>
                      )}
                    </div>
                  </div>

                  {hasPerm('user360.financials') && (
                    <PortfolioChart balances={balances} loading={balancesLoading} />
                  )}
                </div>
              )}

              {/* Transactions */}
              {activeTab === 'transactions' && (
                txLoading ? <Skeleton /> : !txData || txData.items.length === 0 ? <Empty message="No transaction history" /> : <>
                  <Table headers={['ID', 'Type', 'Status', 'Currency', 'Amount', 'Fee', 'Network / Ref', 'Date']}>
                    {txData.items.map(tx => (
                      <TR key={tx.transaction_id}>
                        <TD mono muted>{tx.transaction_id}</TD>
                        <TD><Badge label={tx.type} cfg={tx.type === 'deposit' ? { bg: 'rgba(16,185,129,0.10)', color: '#059669' } : { bg: 'rgba(245,158,11,0.10)', color: '#d97706' }} /></TD>
                        <TD><Badge label={tx.status} cfg={STATUS_BADGE[tx.status]} /></TD>
                        <TD><span style={{ fontWeight: 600, color: T_PRIMARY }}>{tx.currency}</span></TD>
                        <TD right>{fmt(tx.amount, tx.currency === 'THB' ? 2 : 8)}</TD>
                        <TD right muted>{fmt(tx.fee, tx.currency === 'THB' ? 2 : 8)}</TD>
                        <TD mono muted>{tx.tx_hash ? tx.tx_hash.slice(0, 12) + '…' : tx.bank_ref ?? tx.network ?? '—'}</TD>
                        <TD muted>{fmtDate(tx.created_at)}</TD>
                      </TR>
                    ))}
                  </Table>
                  <Pagination page={txPage} total={txData.total} pageSize={txData.page_size} onChange={p => { if (user) loadTab('transactions', user.user_id, p); }} />
                </>
              )}

              {/* Spot trades */}
              {activeTab === 'spot' && (
                spotLoading ? <Skeleton /> : !spotData || spotData.items.length === 0 ? <Empty message="No spot trade history" /> : <>
                  <Table headers={['Order ID', 'Symbol', 'Side', 'Type', 'Status', 'Price', 'Qty', 'Filled', 'Fee', 'Date']}>
                    {spotData.items.map(s => (
                      <TR key={s.order_id}>
                        <TD mono muted>{s.order_id}</TD>
                        <TD><span style={{ fontWeight: 600, color: T_PRIMARY }}>{s.symbol}</span></TD>
                        <TD><Badge label={s.side} cfg={s.side === 'buy' ? { bg: 'rgba(16,185,129,0.10)', color: '#059669' } : { bg: 'rgba(239,68,68,0.10)', color: '#dc2626' }} /></TD>
                        <TD muted>{s.order_type}</TD>
                        <TD><Badge label={s.status.replace(/_/g, ' ')} cfg={STATUS_BADGE[s.status]} /></TD>
                        <TD right>{fmt(s.price, 2)}</TD>
                        <TD right muted>{fmt(s.quantity, 6)}</TD>
                        <TD right muted>{fmt(s.filled_qty, 6)}</TD>
                        <TD right muted>{fmt(s.fee, 4)} {s.fee_currency}</TD>
                        <TD muted>{fmtDate(s.created_at)}</TD>
                      </TR>
                    ))}
                  </Table>
                  <Pagination page={spotPage} total={spotData.total} pageSize={spotData.page_size} onChange={p => { if (user) loadTab('spot', user.user_id, p); }} />
                </>
              )}

              {/* Futures trades */}
              {activeTab === 'futures' && (
                futLoading ? <Skeleton /> : !futData || futData.items.length === 0 ? <Empty message="No futures trade history" /> : <>
                  <Table headers={['Position ID', 'Symbol', 'Side', 'Status', 'Lev.', 'Entry', 'Exit', 'Qty', 'PnL', 'Fee', 'Date']}>
                    {futData.items.map(f => (
                      <TR key={f.position_id}>
                        <TD mono muted>{f.position_id}</TD>
                        <TD><span style={{ fontWeight: 600, color: T_PRIMARY }}>{f.symbol}</span></TD>
                        <TD><Badge label={f.side} cfg={f.side === 'long' ? { bg: 'rgba(16,185,129,0.10)', color: '#059669' } : { bg: 'rgba(239,68,68,0.10)', color: '#dc2626' }} /></TD>
                        <TD><Badge label={f.status} cfg={STATUS_BADGE[f.status]} /></TD>
                        <TD><span style={{ fontWeight: 600, color: T_SECONDARY }}>{f.leverage}×</span></TD>
                        <TD right>{fmt(f.entry_price, 2)}</TD>
                        <TD right muted>{f.exit_price != null ? fmt(f.exit_price, 2) : '—'}</TD>
                        <TD right muted>{fmt(f.quantity, 4)}</TD>
                        <TD right>
                          <span style={{ fontWeight: 600, color: f.pnl == null ? T_MUTED : f.pnl >= 0 ? '#059669' : '#dc2626' }}>
                            {f.pnl == null ? '—' : (f.pnl >= 0 ? '+' : '') + fmt(f.pnl, 2)}
                          </span>
                        </TD>
                        <TD right muted>{fmt(f.fee, 4)}</TD>
                        <TD muted>{fmtDate(f.created_at)}</TD>
                      </TR>
                    ))}
                  </Table>
                  <Pagination page={futPage} total={futData.total} pageSize={futData.page_size} onChange={p => { if (user) loadTab('futures', user.user_id, p); }} />
                </>
              )}

              {/* Ticket history */}
              {activeTab === 'tickets' && (
                ticketsLoading ? <Skeleton /> : !tickets || tickets.length === 0 ? <Empty message="No ticket history" /> :
                  <Table headers={['Ticket ID', 'Status', 'Priority', 'Channel', 'Category', 'Assigned To', 'Last Message', 'Created']}>
                    {tickets.map(t => (
                      <TR key={t.id} onClick={() => navigate(`/inbox?ticket=${t.id}`)}>
                        <TD mono><span style={{ color: '#6366f1', fontWeight: 600 }}>{t.id.slice(0, 8)}…</span></TD>
                        <TD><Badge label={t.status.replace(/_/g, ' ')} cfg={STATUS_BADGE[t.status]} /></TD>
                        <TD muted>{t.priority === 1 ? 'VIP' : t.priority === 2 ? 'EA' : 'Standard'}</TD>
                        <TD muted>{t.channel}</TD>
                        <TD muted>{t.category?.replace(/_/g, ' ') ?? '—'}</TD>
                        <TD muted>{t.assigned_to_name ?? 'Unassigned'}</TD>
                        <td style={{ padding: '10px 16px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: T_MUTED }}>
                          {t.last_message ?? '—'}
                        </td>
                        <TD muted>{fmtDate(t.created_at)}</TD>
                      </TR>
                    ))}
                  </Table>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
