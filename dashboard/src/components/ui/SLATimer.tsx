import { useState, useEffect } from 'react';

interface SLATimerProps {
  deadline: string; // ISO date string
  className?: string;
  showLabel?: boolean;
}

function msRemaining(deadline: string): number {
  return new Date(deadline).getTime() - Date.now();
}

function formatMs(ms: number): string {
  if (ms <= 0) return 'Breached';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function SLATimer({ deadline, className = '', showLabel = false }: SLATimerProps) {
  const [ms, setMs] = useState(() => msRemaining(deadline));

  useEffect(() => {
    if (!deadline) return;
    const interval = setInterval(() => setMs(msRemaining(deadline)), 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline || isNaN(ms)) {
    return (
      <span className={`font-mono font-medium text-xs tabular-nums ${className}`} style={{ color: '#9ca3af' }}>
        {showLabel && <span className="font-sans mr-1">SLA</span>}
        No SLA
      </span>
    );
  }

  const breached = ms <= 0;
  const critical = ms > 0 && ms < 10 * 60 * 1000;
  const warning  = ms > 0 && ms < 30 * 60 * 1000;
  const color = breached || critical ? '#ef4444' : warning ? '#f59e0b' : '#22c55e';

  return (
    <span
      className={`font-mono font-medium text-xs tabular-nums ${breached ? 'animate-pulse' : ''} ${className}`}
      style={{ color }}
    >
      {showLabel && <span className="font-sans mr-1" style={{ color: '#9ca3af' }}>SLA</span>}
      {formatMs(ms)}
    </span>
  );
}
