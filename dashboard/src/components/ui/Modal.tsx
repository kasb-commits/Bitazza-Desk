import { useEffect, useRef } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Don't close when clicking backdrop */
  persistent?: boolean;
}

const SIZE = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

const MODAL_STY: React.CSSProperties = {
  background: '#ffffff',
  borderRadius: 16,
  boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
  border: '1px solid rgba(0,0,0,0.06)',
};

export function Modal({ open, onClose, title, description, children, size = 'md', persistent = false }: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !persistent) onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose, persistent]);

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={persistent ? undefined : onClose}
    >
      <div
        ref={contentRef}
        style={MODAL_STY}
        className={`w-full ${SIZE[size]} animate-scale-in`}
        onClick={e => e.stopPropagation()}
      >
        {(title || description) && (
          <div className="px-6 pt-5 pb-4" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
            {title && <h2 className="text-md font-semibold" style={{ color: '#1a1d2e' }}>{title}</h2>}
            {description && <p className="text-sm mt-1" style={{ color: '#4b5563' }}>{description}</p>}
          </div>
        )}
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// Convenience confirm modal
interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function ConfirmModal({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger = false }: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <h3 className="text-md font-semibold" style={{ color: '#1a1d2e' }}>{title}</h3>
          <p className="text-sm mt-1.5 leading-relaxed" style={{ color: '#4b5563' }}>{description}</p>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded-md transition-all active:scale-[0.98] hover:opacity-80"
            style={{ background: '#f3f4f6', border: '1px solid rgba(0,0,0,0.06)', color: '#4b5563' }}
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className="px-4 py-1.5 text-sm rounded-md transition-all active:scale-[0.98] hover:opacity-90"
            style={danger
              ? { background: '#ef4444', color: '#ffffff' }
              : { background: '#6366f1', color: '#ffffff' }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
