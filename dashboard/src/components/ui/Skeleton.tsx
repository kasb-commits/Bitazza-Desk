interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

// Base pulsing block
export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ background: '#e5e7eb', ...style }}
    />
  );
}

// Conversation list row skeleton
export function ConversationRowSkeleton() {
  return (
    <div className="flex items-start gap-3 px-3 py-3" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <Skeleton className="w-8 h-8 rounded-full shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-2.5 w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-4 w-12 rounded" />
          <Skeleton className="h-4 w-16 rounded" />
        </div>
      </div>
    </div>
  );
}

// Message bubble skeleton (alternating left/right)
export function MessageBubbleSkeleton({ align = 'left' }: { align?: 'left' | 'right' }) {
  const widths = ['w-48', 'w-64', 'w-40', 'w-56', 'w-36', 'w-52'];
  const w = widths[Math.floor(Math.random() * widths.length)];
  return (
    <div className={`flex ${align === 'right' ? 'justify-end' : 'justify-start'} px-4`}>
      <Skeleton className={`h-12 ${w} rounded-xl`} />
    </div>
  );
}

// KPI card skeleton
export function KpiCardSkeleton() {
  return (
    <div
      className="rounded-lg p-5 space-y-3"
      style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
    >
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-2.5 w-32" />
    </div>
  );
}

// Agent card skeleton
export function AgentCardSkeleton() {
  return (
    <div
      className="rounded-lg p-4 space-y-3"
      style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.06)' }}
    >
      <div className="flex items-center gap-3">
        <Skeleton className="w-9 h-9 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  );
}

// Chart bar skeleton
export function ChartBarSkeleton({ bars = 7 }: { bars?: number }) {
  const heights = ['h-8', 'h-14', 'h-10', 'h-20', 'h-12', 'h-16', 'h-6', 'h-18'];
  return (
    <div className="flex items-end gap-2 h-24 px-2">
      {Array.from({ length: bars }).map((_, i) => (
        <Skeleton
          key={i}
          className={`flex-1 rounded-t ${heights[i % heights.length]}`}
          style={{ animationDelay: `${i * 50}ms` }}
        />
      ))}
    </div>
  );
}

// Table row skeleton
export function TableRowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === 0 ? 'w-8 h-8 rounded-full' : 'flex-1'}`} />
      ))}
    </div>
  );
}
