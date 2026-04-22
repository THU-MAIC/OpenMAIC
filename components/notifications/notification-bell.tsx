'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/hooks/use-auth';
import { useRouter } from 'next/navigation';
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  action_url: string | null;
  is_read: boolean;
  created_at: string;
}

const POLL_INTERVAL_MS = 30_000;

export function NotificationBell() {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/notifications?unread_only=false&limit=20', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        setNotifications(json.notifications);
        setUnreadCount(json.unreadCount);
      }
    } catch { /* ignore */ }
  }, [user]);

  // Poll for new notifications
  useEffect(() => {
    if (!user) return;
    fetchNotifications();
    intervalRef.current = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [user, fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = async () => {
    setOpen((prev) => !prev);
    if (!open && unreadCount > 0) {
      // Optimistically clear unread badge
      setUnreadCount(0);
      // Mark all as read
      fetch('/api/notifications', { method: 'PATCH' }).catch(() => {});
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
    setOpen(false);
    if (!notification.is_read) {
      fetch(`/api/notifications/${notification.id}`, { method: 'PATCH' }).catch(() => {});
    }
    if (notification.action_url) {
      router.push(notification.action_url);
    }
  };

  if (!user) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          'relative flex items-center gap-2 h-9 px-3 rounded-full border-2 border-[#073b4c] bg-white text-[#073b4c] font-bold text-xs',
          'hover:translate-y-[-1px] shadow-[3px_3px_0_#073b4c] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]',
        )}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="size-3.5" />
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#ef476f] border-2 border-white text-white text-[10px] font-black flex items-center justify-center"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-slate-900 border-[3px] border-[#073b4c] rounded-2xl shadow-[6px_6px_0_#073b4c] z-50 overflow-hidden"
          >
            <div className="px-4 py-3 border-b-2 border-[#073b4c]/10 flex items-center justify-between">
              <span className="text-sm font-black text-[#073b4c] uppercase tracking-wide">
                Notifications
              </span>
              {notifications.some((n) => !n.is_read) && (
                <button
                  className="text-[11px] font-bold text-[#ef476f] hover:underline"
                  onClick={() => {
                    fetch('/api/notifications', { method: 'PATCH' }).catch(() => {});
                    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
                    setUnreadCount(0);
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-[380px] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <Bell className="size-8 text-[#073b4c]/20 mx-auto mb-2" />
                  <p className="text-sm font-medium text-[#073b4c]/50">No notifications yet</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleNotificationClick(n)}
                    className={cn(
                      'w-full text-left px-4 py-3 flex gap-3 transition-colors border-b border-[#073b4c]/5 last:border-0',
                      n.is_read
                        ? 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        : 'bg-[#ef476f]/5 hover:bg-[#ef476f]/10',
                    )}
                  >
                    <div
                      className={cn(
                        'shrink-0 mt-0.5 size-2 rounded-full',
                        n.is_read ? 'bg-transparent' : 'bg-[#ef476f]',
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[#073b4c] leading-tight">{n.title}</p>
                      {n.body && (
                        <p className="text-xs text-[#073b4c]/60 mt-0.5 line-clamp-2">{n.body}</p>
                      )}
                      <p className="text-[10px] text-[#073b4c]/40 mt-1">
                        {timeAgo(n.created_at)}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
