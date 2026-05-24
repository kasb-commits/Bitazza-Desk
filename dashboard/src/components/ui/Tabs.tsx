import { useState, useRef, useEffect } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
}

interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
  /** 'underline' = bottom border indicator | 'pill' = filled pill background */
  variant?: 'underline' | 'pill';
}

export function Tabs({ tabs, activeId, onChange, className = '', variant = 'underline' }: TabsProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useEffect(() => {
    if (variant !== 'underline' || !activeRef.current) return;
    const el = activeRef.current;
    setIndicatorStyle({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeId, variant]);

  if (variant === 'pill') {
    return (
      <div
        className={`flex items-center gap-0.5 rounded-lg p-0.5 ${className}`}
        style={{ background: '#f3f4f6' }}
      >
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-150"
            style={tab.id === activeId
              ? { background: '#ffffff', color: '#1a1d2e', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
              : { color: '#4b5563' }
            }
          >
            {tab.icon}
            {tab.label}
            {tab.badge != null && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                style={{ background: 'rgba(99,102,241,0.12)', color: '#6366f1' }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  // Underline variant with animated indicator
  return (
    <div className={`relative ${className}`} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <div className="flex items-end gap-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            ref={tab.id === activeId ? activeRef : undefined}
            onClick={() => onChange(tab.id)}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors duration-100 whitespace-nowrap"
            style={{ color: tab.id === activeId ? '#1a1d2e' : '#4b5563' }}
          >
            {tab.icon}
            {tab.label}
            {tab.badge != null && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                style={tab.id === activeId
                  ? { background: 'rgba(99,102,241,0.12)', color: '#6366f1' }
                  : { background: '#e5e7eb', color: '#9ca3af' }
                }
              >
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* Sliding underline indicator */}
      <div
        className="absolute bottom-0 h-0.5 rounded-full transition-all duration-200 ease-out-expo"
        style={{ left: indicatorStyle.left, width: indicatorStyle.width, background: '#6366f1' }}
      />
    </div>
  );
}
