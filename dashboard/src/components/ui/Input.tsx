import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
}

const BASE_STY: React.CSSProperties = { background: '#FCFCFE', border: '1.5px solid #EDEDF8', color: 'rgba(27,26,24,1)' };
const ERR_STY:  React.CSSProperties = { background: '#FBECEA', border: '1.5px solid #EF4150', color: 'rgba(27,26,24,1)' };

export function Input({ label, error, leftIcon, rightSlot, className = '', style, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium" style={{ color: '#4b5563' }}>{label}</label>
      )}
      <div className="relative">
        {leftIcon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: '#9ca3af' }}>
            {leftIcon}
          </span>
        )}
        <input
          {...props}
          style={{ ...(error ? ERR_STY : BASE_STY), ...style }}
          className={`
            w-full px-3 py-2 text-sm rounded-md outline-none
            focus:ring-1 focus:ring-[#00CE80] transition-all
            placeholder:text-[rgba(27,26,24,0.4)]
            disabled:opacity-50 disabled:cursor-not-allowed
            ${leftIcon ? 'pl-9' : ''}
            ${rightSlot ? 'pr-9' : ''}
            ${className}
          `.trim()}
        />
        {rightSlot && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: '#9ca3af' }}>
            {rightSlot}
          </span>
        )}
      </div>
      {error && <p className="text-xs" style={{ color: '#EF4150' }}>{error}</p>}
    </div>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className = '', style, ...props }: TextareaProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium" style={{ color: '#4b5563' }}>{label}</label>
      )}
      <textarea
        {...props}
        style={{ ...(error ? ERR_STY : BASE_STY), ...style }}
        className={`
          w-full px-3 py-2.5 text-sm rounded-md outline-none
          focus:ring-1 focus:ring-[#00CE80] transition-all resize-none
          placeholder:text-[rgba(27,26,24,0.4)]
          disabled:opacity-50 disabled:cursor-not-allowed
          ${className}
        `.trim()}
      />
      {error && <p className="text-xs" style={{ color: '#EF4150' }}>{error}</p>}
    </div>
  );
}
