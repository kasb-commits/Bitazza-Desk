// ── Avatar ────────────────────────────────────────────────────────────────────
// Auto-generates a consistent color from the name hash so each agent/customer
// gets their own color instead of everyone being the same brand red.

const COLORS = [
  '#E63946', '#3B82F6', '#22C55E', '#F59E0B',
  '#8B5CF6', '#EC4899', '#14B8A6', '#F97316',
  '#6366F1', '#0EA5E9',
];

export function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const SIZE = {
  xs: { outer: 'w-5 h-5',   text: 'text-[8px]'  },
  sm: { outer: 'w-7 h-7',   text: 'text-[10px]' },
  md: { outer: 'w-9 h-9',   text: 'text-xs'     },
  lg: { outer: 'w-11 h-11', text: 'text-sm'     },
};

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Show a small status dot */
  statusColor?: string;
  className?: string;
}

export function Avatar({ name, src, size = 'sm', statusColor, className = '' }: AvatarProps) {
  const sz = SIZE[size];
  const color = nameToColor(name);

  return (
    <div className={`relative shrink-0 ${className}`}>
      <div
        className={`${sz.outer} rounded-full flex items-center justify-center font-bold text-white`}
        style={{ backgroundColor: color, boxShadow: `0 0 0 2px ${color}30` }}
      >
        {src ? (
          <img src={src} alt={name} className="w-full h-full rounded-full object-cover" />
        ) : (
          <span className={sz.text}>{initials(name)}</span>
        )}
      </div>
      {statusColor && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: statusColor, boxShadow: '0 0 0 2px #ffffff' }}
        />
      )}
    </div>
  );
}
