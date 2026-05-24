import React from 'react';
import { Spinner } from './Spinner';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const VARIANT_CLS: Record<string, string> = {
  primary:   'hover:opacity-90 text-white',
  secondary: 'hover:opacity-80',
  ghost:     'hover:opacity-80',
  danger:    'hover:opacity-90',
};

const VARIANT_STY: Record<string, React.CSSProperties> = {
  primary:   { background: '#6366f1', color: '#ffffff' },
  secondary: { background: '#f3f4f6', border: '1px solid rgba(0,0,0,0.08)', color: '#1a1d2e' },
  ghost:     { background: 'transparent', color: '#4b5563' },
  danger:    { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' },
};

const SIZE = {
  sm: 'h-7 px-3 text-xs gap-1.5 rounded',
  md: 'h-9 px-4 text-sm gap-2 rounded-md',
  lg: 'h-10 px-5 text-sm gap-2 rounded-md',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  children,
  disabled,
  className = '',
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      style={{ ...VARIANT_STY[variant], ...style }}
      className={`
        inline-flex items-center justify-center font-medium transition-all duration-100
        active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed
        ${VARIANT_CLS[variant]} ${SIZE[size]} ${className}
      `.trim()}
    >
      {loading ? <Spinner size="xs" className="text-current" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}
