'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import type { PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';
import { cn } from '@/lib/utils';
import { DEFAULT_TEACHER_AVATAR, DEFAULT_STUDENT_AVATAR } from '@/components/roundtable/constants';

const PRESENTATION_BUBBLE_WIDTH = 'w-[min(420px,calc(100vw-3rem))]';

interface PresentationSpeechOverlayProps {
  readonly playbackView: PlaybackView;
  readonly participants: Participant[];
  readonly speakingAgentId: string | null;
  readonly isTopicPending: boolean;
  readonly userAvatar?: string;
  /** Which side this overlay instance renders — 'left' or 'right' */
  readonly side?: 'left' | 'right';
}

export interface PresentationBubbleModel {
  key: string;
  role: 'teacher' | 'agent' | 'user';
  side: 'left' | 'right';
  name: string;
  avatar: string;
  text: string;
  isLoading: boolean;
  isTopicPending: boolean;
}

export function buildPresentationBubbleModel({
  playbackView,
  participants,
  speakingAgentId,
  isTopicPending,
  fallbackTeacherName,
  fallbackStudentName,
  fallbackUserName,
  userAvatar,
}: {
  playbackView: PlaybackView;
  participants: Participant[];
  speakingAgentId: string | null;
  isTopicPending: boolean;
  fallbackTeacherName: string;
  fallbackStudentName: string;
  fallbackUserName: string;
  userAvatar?: string;
}): PresentationBubbleModel | null {
  const { phase, bubbleRole, sourceText } = playbackView;
  const showDuringPhase =
    phase === 'lecturePlaying' ||
    phase === 'lecturePaused' ||
    phase === 'discussionActive' ||
    phase === 'discussionPaused';
  const isLoading = phase === 'discussionActive' && bubbleRole !== null && sourceText === '';

  if (!showDuringPhase) return null;
  if (bubbleRole !== 'teacher' && bubbleRole !== 'agent' && bubbleRole !== 'user') return null;
  if (!sourceText && !isLoading) return null;

  const teacherParticipant = participants.find((participant) => participant.role === 'teacher');
  const speakingStudent = speakingAgentId
    ? participants.find(
        (participant) =>
          participant.id === speakingAgentId &&
          participant.role !== 'teacher' &&
          participant.role !== 'user',
      )
    : null;

  if (bubbleRole === 'teacher') {
    return {
      key: 'teacher',
      role: 'teacher',
      side: 'left',
      name: teacherParticipant?.name || fallbackTeacherName,
      avatar: teacherParticipant?.avatar || DEFAULT_TEACHER_AVATAR,
      text: sourceText,
      isLoading,
      isTopicPending,
    };
  }

  if (bubbleRole === 'user') {
    const userParticipant = participants.find((p) => p.role === 'user');
    return {
      key: 'user',
      role: 'user',
      side: 'right',
      name: userParticipant?.name || fallbackUserName,
      avatar: userAvatar || userParticipant?.avatar || DEFAULT_STUDENT_AVATAR,
      text: sourceText,
      isLoading,
      isTopicPending,
    };
  }

  return {
    key: `agent-${speakingAgentId || 'unknown'}`,
    role: 'agent',
    side: 'right',
    name: speakingStudent?.name || fallbackStudentName,
    avatar: speakingStudent?.avatar || DEFAULT_STUDENT_AVATAR,
    text: sourceText,
    isLoading,
    isTopicPending,
  };
}

/** Reusable bubble card — renders the speech bubble content (avatar, name, text) */
export function PresentationBubbleCard({ bubble }: { readonly bubble: PresentationBubbleModel }) {
  const { t } = useI18n();
  return (
    <div
      aria-live="polite"
      className={cn(
        'w-full min-w-0 rounded-3xl border backdrop-blur-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.45)] overflow-hidden',
        bubble.role === 'user'
          ? 'bg-violet-50/60 dark:bg-violet-950/55 border-violet-200/70 dark:border-violet-800/60'
          : bubble.role === 'agent'
            ? 'bg-blue-50/60 dark:bg-blue-950/55 border-blue-200/70 dark:border-blue-800/60'
            : 'bg-white/62 dark:bg-gray-900/82 border-gray-200/70 dark:border-gray-700/70',
      )}
    >
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <div
          className={cn(
            'w-10 h-10 rounded-full overflow-hidden border-2 shadow-sm shrink-0',
            bubble.role === 'user'
              ? 'border-violet-300 dark:border-violet-600'
              : bubble.role === 'agent'
                ? 'border-blue-300 dark:border-blue-600'
                : 'border-purple-200 dark:border-purple-700',
          )}
        >
          <AvatarDisplay src={bubble.avatar} alt={bubble.name} />
        </div>
        <div className="min-w-0">
          <div
            className={cn(
              'text-[11px] font-semibold uppercase tracking-[0.16em]',
              bubble.role === 'user'
                ? 'text-violet-500 dark:text-violet-300'
                : bubble.role === 'agent'
                  ? 'text-blue-500 dark:text-blue-300'
                  : 'text-purple-500 dark:text-purple-300',
            )}
          >
            {bubble.role === 'user'
              ? t('roundtable.you')
              : bubble.role === 'agent'
                ? t('settings.agentRoles.student')
                : t('settings.agentRoles.teacher')}
          </div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {bubble.name}
          </div>
        </div>
      </div>

      <div className="px-4 pb-3 max-h-[120px] overflow-hidden">
        {bubble.isLoading ? (
          <div className="flex gap-1 items-center py-1">
            {[0, 0.2, 0.4].map((delay) => (
              <motion.div
                key={delay}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1, delay }}
                className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  bubble.role === 'user'
                    ? 'bg-violet-400 dark:bg-violet-500'
                    : bubble.role === 'agent'
                      ? 'bg-blue-400 dark:bg-blue-500'
                      : 'bg-purple-400 dark:bg-purple-500',
                )}
              />
            ))}
          </div>
        ) : (
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-gray-800 dark:text-gray-100">
            {bubble.text}
            {bubble.isTopicPending && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 ml-1 align-middle" />
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function PresentationSpeechOverlay({
  playbackView,
  participants,
  speakingAgentId,
  isTopicPending,
  userAvatar,
  side = 'left',
}: PresentationSpeechOverlayProps) {
  const { t } = useI18n();
  const bubble = buildPresentationBubbleModel({
    playbackView,
    participants,
    speakingAgentId,
    isTopicPending,
    fallbackTeacherName: t('roundtable.teacher'),
    fallbackStudentName: t('settings.agentRoles.student'),
    fallbackUserName: t('roundtable.you'),
    userAvatar,
  });

  const matchesSide = !!(bubble && bubble.side === side);

  /* ── Left-side overlay: absolute covers stage, renders left bubble + cue ── */
  if (side === 'left') {
    return (
      <div className="absolute inset-0 pointer-events-none">
        <AnimatePresence mode="wait">
          {matchesSide && bubble && (
            <motion.div
              key={bubble.key}
              initial={{ opacity: 0, x: -20, y: 12 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.22, ease: [0.21, 1, 0.36, 1] }}
              className={cn('absolute bottom-6 left-6 z-30', PRESENTATION_BUBBLE_WIDTH)}
            >
              <PresentationBubbleCard bubble={bubble} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  /* ── Right-side: inline flow, rendered inside the dock's flex column ── */
  return (
    <AnimatePresence mode="wait">
      {matchesSide && bubble && (
        <motion.div
          key={bubble.key}
          initial={{ opacity: 0, x: 20, y: 12 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.21, 1, 0.36, 1] }}
          className={PRESENTATION_BUBBLE_WIDTH}
        >
          <PresentationBubbleCard bubble={bubble} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
