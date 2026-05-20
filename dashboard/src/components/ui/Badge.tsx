import type { TicketStatus, Priority, Channel, TicketCategory } from '../../types';
type TicketPriority = Priority;
type TicketChannel = Channel;

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TicketStatus, { label: string; dot: string; bg: string; color: string }> = {
  Open_Live:           { label: 'Open',       dot: '#22c55e', bg: '#f0fdf4', color: '#15803d' },
  In_Progress:         { label: 'Active',     dot: '#8b5cf6', bg: '#f5f3ff', color: '#6d28d9' },
  Pending_Customer:    { label: 'Pending',    dot: '#f59e0b', bg: '#fffbeb', color: '#92400e' },
  Escalated:           { label: 'Escalated',  dot: '#ef4444', bg: '#fef2f2', color: '#b91c1c' },
  Closed_Resolved:     { label: 'Resolved',   dot: '#22c55e', bg: '#f0fdf4', color: '#15803d' },
  Closed_Unresponsive: { label: 'Closed',     dot: '#9ca3af', bg: '#f9fafb', color: '#6b7280' },
  Orphaned:            { label: 'Orphaned',   dot: '#9ca3af', bg: '#f3f4f6', color: '#6b7280' },
};

const PRIORITY_CONFIG: Record<TicketPriority, { label: string; bg: string; color: string }> = {
  1: { label: 'VIP',      bg: '#fef2f2', color: '#b91c1c' },
  2: { label: 'High',     bg: '#fffbeb', color: '#92400e' },
  3: { label: 'Standard', bg: '#f3f4f6', color: '#6b7280' },
};

const CHANNEL_CONFIG: Record<TicketChannel, { label: string; bg: string; color: string }> = {
  web:      { label: 'Web',      bg: '#eff6ff', color: '#1d4ed8' },
  line:     { label: 'LINE',     bg: '#dcfce7', color: '#166534' },
  facebook: { label: 'Facebook', bg: '#dbeafe', color: '#1e40af' },
  email:    { label: 'Email',    bg: '#f3f4f6', color: '#374151' },
};

// icon: heroicons micro path (viewBox 0 0 16 16)
const CATEGORY_CONFIG: Record<TicketCategory, { label: string; bg: string; color: string; icon: string }> = {
  kyc_verification: {
    label: 'KYC Verification',
    bg: '#fce7f3', color: '#9d174d',
    icon: 'M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm3 1.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0ZM5 9a3 3 0 0 1 6 0H5Zm6-4.5h-1.5v1H11v-1Z',
  },
  account_restriction: {
    label: 'Account Restriction',
    bg: '#fef3c7', color: '#92400e',
    icon: 'M8 1a4 4 0 1 0 0 8A4 4 0 0 0 8 1ZM2 11a6 6 0 0 1 10.472-4H3.528A6 6 0 0 1 2 11Zm-.5 2a.5.5 0 0 0 0 1h13a.5.5 0 0 0 0-1H1.5Z',
  },
  password_2fa_reset: {
    label: 'Password / 2FA',
    bg: '#dbeafe', color: '#1e40af',
    icon: 'M11 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM4 8.5A3.5 3.5 0 0 0 .5 12v.5A1.5 1.5 0 0 0 2 14h12a1.5 1.5 0 0 0 1.5-1.5V12A3.5 3.5 0 0 0 12 8.5H4Z',
  },
  fraud_security: {
    label: 'Fraud & Security',
    bg: '#fee2e2', color: '#991b1b',
    icon: 'M8 1 2 3.5V8c0 3.3 2.5 5.6 6 7 3.5-1.4 6-3.7 6-7V3.5L8 1Zm3.28 5.78-3.75 3.75a.75.75 0 0 1-1.06 0l-1.5-1.5a.75.75 0 1 1 1.06-1.06l.97.97 3.22-3.22a.75.75 0 1 1 1.06 1.06Z',
  },
  withdrawal_issue: {
    label: 'Withdrawal Issue',
    bg: '#ecfdf5', color: '#065f46',
    icon: 'M8 14V5.414l2.293 2.293a1 1 0 0 0 1.414-1.414l-3-3a1 1 0 0 0-1.414 0l-3 3a1 1 0 0 0 1.414 1.414L7 5.414V14a1 1 0 0 0 2 0ZM3 2a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H3Z',
  },
  unclassified: {
    label: 'Unclassified',
    bg: '#f3f4f6', color: '#6b7280',
    icon: 'M9.5 1.5 8 5l-3.5 1.5L8 8l1.5 3.5L11 8l3.5-1.5L11 5 9.5 1.5ZM3 9.5 2 12l2.5 1L2 14.5 3 17l1-2.5 2.5-1L4 12l-1-2.5Z',
  },
};

// ── Badge component ───────────────────────────────────────────────────────────

interface StatusBadgeProps {
  status: TicketStatus;
  dot?: boolean;
  size?: 'xs' | 'sm';
}

export function StatusBadge({ status, dot = false, size = 'sm' }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, dot: '#9ca3af', bg: '#f3f4f6', color: '#6b7280' };
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${px}`}
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cfg.dot }} />}
      {cfg.label}
    </span>
  );
}

interface PriorityBadgeProps {
  priority: TicketPriority;
  size?: 'xs' | 'sm';
}

export function PriorityBadge({ priority, size = 'sm' }: PriorityBadgeProps) {
  const cfg = PRIORITY_CONFIG[priority] ?? { label: String(priority), bg: '#f3f4f6', color: '#6b7280' };
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded font-medium ${px}`}
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

interface ChannelBadgeProps {
  channel: TicketChannel;
  size?: 'xs' | 'sm';
}

export function ChannelBadge({ channel, size = 'sm' }: ChannelBadgeProps) {
  const cfg = CHANNEL_CONFIG[channel] ?? { label: channel, bg: '#f3f4f6', color: '#374151' };
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded font-medium ${px}`}
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

interface CategoryBadgeProps {
  category: TicketCategory;
  size?: 'xs' | 'sm';
}

export function CategoryBadge({ category, size = 'sm' }: CategoryBadgeProps) {
  const cfg = CATEGORY_CONFIG[category] ?? { label: category, bg: '#f3f4f6', color: '#6b7280', icon: '' };
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${px}`}
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {cfg.icon && (
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d={cfg.icon} />
        </svg>
      )}
      {cfg.label}
    </span>
  );
}

interface TagBadgeProps {
  label: string;
  onRemove?: () => void;
  size?: 'xs' | 'sm';
}

export function TagBadge({ label, onRemove, size = 'sm' }: TagBadgeProps) {
  const px = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${px}`}
      style={{ background: '#f3f4f6', color: '#4b5563' }}
    >
      {label}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70 transition-opacity ml-0.5" style={{ color: 'inherit' }}>
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      )}
    </span>
  );
}
