import { useEffect, useRef, useState } from 'react';
import type { Notification, NotificationPriority } from '../types';
import { api } from '../api';

interface NotificationPanelProps {
  notifications: Notification[];
  onClose: () => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onMarkAllRead: () => void;
  onBulkMark: (ids: string[], read: boolean) => void;
  onOpenTicket: (ticketId: string) => void;
}

const PRIORITY_BORDER: Record<NotificationPriority, string> = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-400',
  medium: 'border-l-brand',
  info: 'border-l-surface-5',
};

const PRIORITY_DOT: Record<NotificationPriority, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-400',
  medium: 'bg-brand',
  info: 'bg-text-muted',
};

const PRIORITY_BADGE: Record<NotificationPriority, string> = {
  critical: 'bg-red-500/15 text-red-400 ring-red-500/30',
  high:     'bg-orange-400/15 text-orange-400 ring-orange-400/30',
  medium:   'bg-brand/15 text-brand ring-brand/30',
  info:     'bg-surface-5/40 text-text-muted ring-surface-5/30',
};

const PRIORITY_LABEL: Record<NotificationPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  info: 'Info',
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function NotificationPanel({
  notifications,
  onClose,
  onMarkRead,
  onMarkUnread,
  onMarkAllRead,
  onBulkMark,
  onOpenTicket,
}: NotificationPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);


  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectMode) { setSelectMode(false); setSelected(new Set()); }
      else onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, selectMode]);


  const unreadCount = notifications.filter(n => !n.read).length;

  const sorted = [...notifications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  };

  const handleItemClick = async (n: Notification) => {
    if (selectMode) {
      toggleSelect(n.id);
      return;
    }
    if (!n.read) {
      onMarkRead(n.id);
      await api.markNotificationRead(n.id).catch(err => console.error('[notifications] mark-read failed:', err));
    }
    if (n.ticket_id) {
      onOpenTicket(n.ticket_id);
      onClose();
    }
  };

  const handleMarkAllRead = async () => {
    onMarkAllRead();
    await api.markAllNotificationsRead().catch(err => console.error('[notifications] mark-all-read failed:', err));
  };

  const handleBulkRead = async (read: boolean) => {
    const ids = [...selected];
    onBulkMark(ids, read);
    setSelected(new Set());
    setSelectMode(false);
    await api.bulkMarkNotifications(ids, read).catch(err => console.error('[notifications] bulk mark failed:', err));
  };

  const allSelected = sorted.length > 0 && selected.size === sorted.length;

  const handleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
      setSelectMode(false);
    } else {
      setSelected(new Set(sorted.map(n => n.id)));
    }
  };

  const selectedHasUnread = [...selected].some(id => notifications.find(n => n.id === id && !n.read));
  const selectedHasRead   = [...selected].some(id => notifications.find(n => n.id === id && n.read));

  return (
    <>
      {/* Backdrop — clicking outside closes the panel */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel — stopPropagation prevents clicks bubbling to the backdrop */}
      <div
        onClick={e => e.stopPropagation()}
        className="fixed right-4 top-14 w-96 max-h-[calc(100vh-80px)] bg-surface-2 border border-surface-5 rounded-xl shadow-panel z-50 flex flex-col overflow-hidden animate-slide-in-up"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-5 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">Notifications</span>
            {unreadCount > 0 && (
              <span className="bg-brand text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {notifications.length > 0 && !selectMode && (
              <button
                onClick={() => setSelectMode(true)}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Select
              </button>
            )}
            {!selectMode && unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Mark all read
              </button>
            )}
            <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors p-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Selection toolbar */}
        {selectMode && (
          <div className="flex items-center justify-between px-4 py-2 bg-surface-3 border-b border-surface-5 shrink-0">
            <div className="flex items-center gap-2">
              {/* Select all checkbox */}
              <button
                onClick={handleSelectAll}
                className="w-4 h-4 rounded border border-surface-5 flex items-center justify-center hover:border-brand transition-colors"
                style={{ background: allSelected ? 'var(--color-brand)' : undefined }}
              >
                {allSelected && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              <span className="text-xs text-text-muted">
                {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && selectedHasUnread && (
                <button
                  onClick={() => handleBulkRead(true)}
                  className="text-xs text-brand hover:text-brand/80 transition-colors font-medium"
                >
                  Mark read
                </button>
              )}
              {selected.size > 0 && selectedHasRead && (
                <button
                  onClick={() => handleBulkRead(false)}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors"
                >
                  Mark unread
                </button>
              )}
              <button
                onClick={() => { setSelectMode(false); setSelected(new Set()); }}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="overflow-y-auto flex-1">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <svg className="w-10 h-10 text-text-muted mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
              <p className="text-sm font-medium text-text-secondary">You're all caught up</p>
              <p className="text-xs text-text-muted mt-1">No notifications yet</p>
            </div>
          ) : (
            sorted.map(n => {
              const priority = n.priority as NotificationPriority;
              const isSelected = selected.has(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() => handleItemClick(n)}
                  className={`
                    w-full text-left px-4 py-3 border-l-2 ${PRIORITY_BORDER[priority] ?? 'border-l-surface-5'}
                    border-b border-surface-5 last:border-b-0
                    hover:bg-surface-3 transition-colors
                    ${n.read && !isSelected ? 'opacity-50' : ''}
                    ${isSelected ? 'bg-brand/5' : ''}
                  `}
                >
                  <div className="flex items-start gap-2.5">
                    {/* Checkbox in select mode, unread dot otherwise */}
                    {selectMode ? (
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors ${
                          isSelected ? 'bg-brand border-brand' : 'border-surface-5'
                        }`}
                      >
                        {isSelected && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    ) : (
                      <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[priority] ?? 'bg-text-muted'} shrink-0 mt-1.5 ${n.read ? 'opacity-0' : ''}`} />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <p className="text-xs font-semibold text-text-primary truncate flex-1">{n.title}</p>
                        <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${PRIORITY_BADGE[priority] ?? PRIORITY_BADGE.info}`}>
                          {PRIORITY_LABEL[priority] ?? priority}
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">{n.body}</p>
                      <p className="text-[10px] text-text-muted mt-1">{timeAgo(n.created_at)}</p>
                    </div>

                    {!selectMode && n.ticket_id && (
                      <svg className="w-3.5 h-3.5 text-text-muted shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
