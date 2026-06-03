import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface KpiCardProps {
  label: string;
  value: number | string;
  sub?: string;
  /** Semantic color key for left-border accent (dark mode) or chip color (glass mode) */
  accent?: 'brand' | 'blue' | 'green' | 'amber' | 'purple' | 'red';
  trend?: number; // positive = up, negative = down
  /** Whether a positive trend is good (green) or bad (red) */
  trendGoodDirection?: 'up' | 'down';
  sparkline?: number[];
  pulse?: boolean; // pulsing accent for urgent KPIs
  onClick?: () => void;
  /** Frosted glass variant for the home dashboard */
  glass?: boolean;
  /** Icon node shown in the glass chip (ignored in dark mode) */
  icon?: React.ReactNode;
}

// ── Dark mode accent ──────────────────────────────────────────────────────────
const ACCENT = {
  brand:  { border: 'border-l-brand',         text: 'text-brand'         },
  blue:   { border: 'border-l-accent-blue',   text: 'text-accent-blue'   },
  green:  { border: 'border-l-accent-green',  text: 'text-accent-green'  },
  amber:  { border: 'border-l-accent-amber',  text: 'text-accent-amber'  },
  purple: { border: 'border-l-purple-400',    text: 'text-purple-400'    },
  red:    { border: 'border-l-red-500',       text: 'text-red-500'       },
};

// ── Glass mode accent (Bitazza semantic palette) ──────────────────────────────
const GLASS_ACCENT: Record<string, { chipBg: string; color: string }> = {
  brand:  { chipBg: '#F0FEF8', color: '#056639'  },
  blue:   { chipBg: '#EEF3FE', color: '#32579D'  },
  green:  { chipBg: '#F0FEF8', color: '#056639'  },
  amber:  { chipBg: '#FEF8EA', color: '#705514'  },
  purple: { chipBg: '#EEF3FE', color: '#32579D'  },
  red:    { chipBg: '#FBECEA', color: '#EF4150'  },
};

export function KpiCard({
  label, value, sub, accent = 'blue', trend, trendGoodDirection = 'up',
  sparkline, pulse = false, onClick, glass = false, icon,
}: KpiCardProps) {

  const trendPositive = trend !== undefined && trend > 0;
  const trendIsGood = trendGoodDirection === 'up' ? trendPositive : !trendPositive;

  // ── Glass variant ───────────────────────────────────────────────────────────
  if (glass) {
    const g = GLASS_ACCENT[accent];
    return (
      <div
        onClick={onClick}
        className={`glass-card glass-card-interactive relative overflow-hidden flex flex-col gap-3 ${pulse ? 'ring-1 ring-[#EF4150]/30' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          {icon && (
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: g.chipBg, color: g.color }}>
              {icon}
            </div>
          )}
          {trend !== undefined && trend !== 0 && (
            <span className="ml-auto flex items-center gap-0.5 text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: trendIsGood ? '#F0FEF8' : '#FBECEA', color: trendIsGood ? '#056639' : '#EF4150' }}>
              <svg className={`w-3 h-3 ${trend > 0 ? '' : 'rotate-180'}`} fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd"/>
              </svg>
              {Math.abs(trend)}
            </span>
          )}
        </div>

        <div>
          <div className="text-3xl font-bold tabular-nums" style={{ color: g.color }}>{value}</div>
          {sub && <div className="text-xs mt-0.5" style={{ color: 'rgba(27,26,24,0.5)' }}>{sub}</div>}
        </div>

        <div className="text-xs font-semibold uppercase" style={{ color: 'rgba(27,26,24,0.75)' }}>{label}</div>

        {sparkline && sparkline.length > 1 && (
          <div className="absolute bottom-0 right-0 w-24 h-12 opacity-30">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline.map((v, i) => ({ i, v }))}>
                <Line type="monotone" dataKey="v" stroke={g.color} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    );
  }

  // ── Dark mode variant (default) ─────────────────────────────────────────────
  const accentCfg = ACCENT[accent];
  return (
    <div
      onClick={onClick}
      className={`
        bg-surface-2 ring-1 ring-surface-5 rounded-lg p-5 border-l-2
        ${accentCfg.border}
        ${pulse ? 'animate-pulse-border' : ''}
        ${onClick ? 'cursor-pointer hover:bg-surface-3 transition-colors' : ''}
        flex flex-col gap-3
      `}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</span>
        {trend !== undefined && trend !== 0 && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${trendIsGood ? 'text-accent-green' : 'text-brand'}`}>
            <svg className={`w-3 h-3 ${trend > 0 ? '' : 'rotate-180'}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd"/>
            </svg>
            {Math.abs(trend)}
          </span>
        )}
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className={`text-xl font-bold font-inter-nums ${accentCfg.text}`}>{value}</div>
          {sub && <div className="text-xs text-text-muted mt-0.5">{sub}</div>}
        </div>

        {sparkline && sparkline.length > 1 && (
          <div className="w-20 h-10 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline.map((v, i) => ({ i, v }))}>
                <Line type="monotone" dataKey="v" stroke="currentColor" strokeWidth={1.5} dot={false} className={accentCfg.text} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
