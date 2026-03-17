'use client';

import type { ChatSession, SessionStatus } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ChevronDown, Circle, CheckCircle, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ChatSessionComponent } from './chat-session';

interface SessionListProps {
  sessions: ChatSession[];
  expandedSessionIds: Set<string>;
  isStreaming: boolean;
  activeBubbleId?: string | null;
  onToggleExpand: (sessionId: string) => void;
  onEndSession: (sessionId: string) => Promise<void>;
}

const sessionBadgeStyles = {
  qa: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  discussion: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  lecture: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
};

// Labels are provided via i18n in the component

function getStatusIcon(status: SessionStatus) {
  switch (status) {
    case 'active':
      return <Circle className="size-2.5 fill-green-500 text-green-500" />;
    case 'interrupted':
      return <Clock className="size-2.5 text-yellow-500" />;
    case 'completed':
      return <CheckCircle className="size-2.5 text-gray-400" />;
    case 'idle':
    default:
      return <Circle className="size-2.5 text-gray-300" />;
  }
}

export function SessionList({
  sessions,
  expandedSessionIds,
  isStreaming,
  activeBubbleId,
  onToggleExpand,
  onEndSession,
}: SessionListProps) {
  const { t } = useI18n();
  return (
    <>
      {sessions.map((session) => {
        const isExpanded = expandedSessionIds.has(session.id);
        const isActive = session.status === 'active';
        const dotColor =
          session.type === 'lecture'
            ? 'bg-purple-500'
            : session.type === 'qa'
              ? 'bg-blue-500'
              : 'bg-amber-500';

        return (
          <div
            key={session.id}
            className={cn(
              'rounded-xl border transition-all duration-500 overflow-hidden',
              isActive
                ? 'border-purple-200 dark:border-purple-700 bg-purple-50/30 dark:bg-purple-900/20 shadow-sm'
                : 'border-gray-100 dark:border-gray-800 bg-white/50 dark:bg-gray-800/50',
            )}
          >
            {/* Session Header */}
            <button
              onClick={() => onToggleExpand(session.id)}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors"
            >
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className={cn(dotColor, 'relative inline-flex rounded-full h-2.5 w-2.5')} />
                {isActive && (
                  <span
                    className={cn(
                      dotColor,
                      'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  'text-[8px] font-extrabold uppercase tracking-wider px-1.5 py-px rounded shrink-0',
                  sessionBadgeStyles[session.type],
                )}
              >
                {t(`chat.badge.${session.type}`)}
              </span>
              <span className="flex-1 text-[11px] font-semibold text-gray-700 dark:text-gray-300 truncate">
                {session.title}
              </span>
              <div className="flex items-center gap-1 text-[9px] text-gray-400 dark:text-gray-500">
                {getStatusIcon(session.status)}
              </div>
              <span className="text-[9px] text-gray-400 dark:text-gray-500 font-medium tabular-nums shrink-0">
                {session.messages.length}
              </span>
              <ChevronDown
                className={cn(
                  'w-3.5 h-3.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 shrink-0',
                  !isExpanded && '-rotate-90',
                )}
              />
            </button>

            {/* Messages */}
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="overflow-hidden border-t border-gray-100/50 dark:border-gray-700/50"
                >
                  <div className="px-2 pb-2 pt-1">
                    <ChatSessionComponent
                      session={session}
                      isActive={isActive}
                      isStreaming={isStreaming && isActive}
                      activeBubbleId={activeBubbleId}
                      onEndSession={onEndSession}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </>
  );
}
