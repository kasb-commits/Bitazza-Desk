import { useEffect } from 'react';
import type { Notification } from '../types';

export interface Toast {
  notification: Notification;
  id: string; // same as notification.id
}

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  onOpenTicket: (ticketId: string) => void;
}

const PRIORITY_STYLES = {
  critical: 'border-l-red-500 bg-red-950/80',
  high: 'border-l-orange-400 bg-orange-950/80',
  medium: 'border-l-brand bg-surface-3',
  info: 'border-l-surface-5 bg-surface-3',
} as const;

const PRIORITY_ICON_COLOR = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-brand',
  info: 'text-text-muted',
} as const;

const AUTO_DISMISS_MS = 8000;

function ToastItem({
  toast,
  onDismiss,
  onOpenTicket,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { notification } = toast;
  const priority = notification.priority as keyof typeof PRIORITY_STYLES;

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const handleClick = () => {
    if (notification.ticket_id) {
      onOpenTicket(notification.ticket_id);
    }
    onDismiss(toast.id);
  };

  return (
    <div
      className={`
        w-80 border-l-4 ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.info}
        ring-1 ring-surface-5 rounded-lg shadow-panel p-3.5
        flex items-start gap-3 animate-slide-in-up cursor-pointer
        hover:ring-surface-4 transition-all
      `}
      onClick={handleClick}
    >
      {/* Priority icon */}
      <div className={`shrink-0 mt-0.5 ${PRIORITY_ICON_COLOR[priority] ?? 'text-text-muted'}`}>
        {priority === 'critical' || priority === 'high' ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-text-primary truncate">{notification.title}</p>
        <p className="text-xs text-text-secondary mt-0.5 leading-relaxed line-clamp-2">{notification.body}</p>
        {notification.ticket_id && (
          <p className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            Click to open ticket
          </p>
        )}
      </div>

      {/* Dismiss */}
      <button
        onClick={e => { e.stopPropagation(); onDismiss(toast.id); }}
        className="shrink-0 text-text-muted hover:text-text-primary transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss, onOpenTicket }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 items-end">
      {toasts.map(toast => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={onDismiss}
          onOpenTicket={onOpenTicket}
        />
      ))}
    </div>
  );
}
