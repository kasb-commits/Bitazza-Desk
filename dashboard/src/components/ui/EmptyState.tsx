import { Button } from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

const DefaultIcon = (
  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#9ca3af' }}>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859M3 7.5h18M3 12h18"/>
  </svg>
);

export function EmptyState({ icon = DefaultIcon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-4 text-center p-8 ${className}`}>
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center"
        style={{ background: '#f3f4f6', border: '1px solid rgba(0,0,0,0.06)' }}
      >
        {icon}
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-semibold" style={{ color: '#1a1d2e' }}>{title}</p>
        {description && <p className="text-xs max-w-xs leading-relaxed" style={{ color: '#9ca3af' }}>{description}</p>}
      </div>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
