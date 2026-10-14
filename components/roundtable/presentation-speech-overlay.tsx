'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Play, Pause, Repeat, Loader2, Volume2, ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
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
  readonly onBubbleClick?: () => void;
  readonly audioIndicatorState?: AudioIndicatorState;
  readonly buttonState?: 'play' | 'bars' | 'restart' | 'none';
  readonly isPaused?: boolean;
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

/** Collapsed pill — shows avatar + name, click to expand */
function CollapsedBubblePill({
  bubble,
  onExpand,
  onPlayPause,
  isPaused,
}: {
  readonly bubble: PresentationBubbleModel;
  readonly onExpand: () => void;
  readonly onPlayPause?: () => void;
  readonly isPaused?: boolean;
}) {
  return (
    <div className="flex items-center gap-2" onClick={onExpand}>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur-xl shadow-md cursor-pointer transition-all duration-200',
          'hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]',
          bubble.role === 'user'
            ? 'bg-violet-50/80 dark:bg-violet-950/70 border-violet-200/70 dark:border-violet-800/60'
            : bubble.role === 'agent'
              ? 'bg-blue-50/80 dark:bg-blue-950/70 border-blue-200/70 dark:border-blue-800/60'
              : 'bg-white/80 dark:bg-gray-900/85 border-gray-200/70 dark:border-gray-700/70',
        )}
      >
        <div
          className={cn(
            'w-6 h-6 rounded-full overflow-hidden border shrink-0',
            bubble.role === 'user'
              ? 'border-violet-300 dark:border-violet-600'
              : bubble.role === 'agent'
                ? 'border-blue-300 dark:border-blue-600'
                : 'border-purple-200 dark:border-purple-700',
          )}
        >
          <AvatarDisplay src={bubble.avatar} alt={bubble.name} />
        </div>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate max-w-[120px]">
          {bubble.name}
        </span>
        <ChevronUp className="w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0" />
      </div>
      {onPlayPause && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onPlayPause();
          }}
          className={cn(
            'p-2 rounded-full border backdrop-blur-xl shadow-md cursor-pointer transition-all duration-200',
            'hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]',
            bubble.role === 'user'
              ? 'bg-violet-50/80 dark:bg-violet-950/70 border-violet-200/70 dark:border-violet-800/60 hover:bg-violet-100 dark:hover:bg-violet-900/70'
              : bubble.role === 'agent'
                ? 'bg-blue-50/80 dark:bg-blue-950/70 border-blue-200/70 dark:border-blue-800/60 hover:bg-blue-100 dark:hover:bg-blue-900/70'
                : 'bg-white/80 dark:bg-gray-900/85 border-gray-200/70 dark:border-gray-700/70 hover:bg-gray-100 dark:hover:bg-gray-800/70',
          )}
        >
          {isPaused ? (
            <Play className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 ml-0.5" />
          ) : (
            <Pause className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
          )}
        </div>
      )}
    </div>
  );
}

/** Reusable bubble card — renders the speech bubble content (avatar, name, text) */
export function PresentationBubbleCard({
  bubble,
  onClick,
  onCollapse,
  audioIndicatorState,
  buttonState,
  isPaused,
}: {
  readonly bubble: PresentationBubbleModel;
  readonly onClick?: () => void;
  readonly onCollapse?: () => void;
  readonly audioIndicatorState?: AudioIndicatorState;
  readonly buttonState?: 'play' | 'bars' | 'restart' | 'none';
  readonly isPaused?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      aria-live="polite"
      onClick={onClick}
      className={cn(
        'relative w-full min-w-0 rounded-3xl border backdrop-blur-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.45)] overflow-hidden group/bubble',
        onClick && 'cursor-pointer',
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
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {bubble.name}
            </div>
            {audioIndicatorState === 'generating' && (
              <Loader2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 animate-spin" />
            )}
            {audioIndicatorState === 'playing' && (
              <Volume2 className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
            )}
          </div>
        </div>
        {onCollapse && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
            className="absolute top-2 right-2 p-1.5 rounded-full text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-gray-800/80 transition-colors duration-200 cursor-pointer z-10"
          >
            <ChevronDown className="w-4 h-4" />
          </div>
        )}
      </div>

      <div className="ml-4 mr-10 mb-4 max-h-[140px] overflow-y-auto scrollbar-hide">
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

      {bubble.role !== 'user' &&
        !bubble.isLoading &&
        buttonState &&
        buttonState !== 'none' &&
        (() => {
          const barsColor = bubble.role === 'agent' ? '#3b82f6' : '#a855f7';

          if (buttonState === 'play') {
            return (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onClick?.();
                }}
                className="absolute right-2.5 bottom-2.5 z-20 p-1.5 rounded-full bg-white/40 dark:bg-gray-800/40 backdrop-blur-sm group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400 ml-0.5" />
              </div>
            );
          }

          if (buttonState === 'restart') {
            return (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onClick?.();
                }}
                className="absolute right-2.5 bottom-2.5 z-20 p-1.5 rounded-full bg-white/40 dark:bg-gray-800/40 backdrop-blur-sm group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300 cursor-pointer"
              >
                <Repeat className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400" />
              </div>
            );
          }

          // buttonState === 'bars'
          return (
            <div
              onClick={(e) => {
                e.stopPropagation();
                onClick?.();
              }}
              className="absolute right-2.5 bottom-2.5 z-20 p-1.5 rounded-full bg-white/40 dark:bg-gray-800/40 backdrop-blur-sm group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300 cursor-pointer"
            >
              {isPaused ? (
                <Play className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400 ml-0.5" />
              ) : (
                <>
                  {/* Breathing bars — visible by default, hidden on hover */}
                  <div className="flex gap-0.5 items-end justify-center h-3.5 w-3.5 group-hover/bubble:hidden">
                    <div
                      className="w-1 rounded-full"
                      style={{
                        backgroundColor: barsColor,
                        animation: 'breathing-bar-1 0.6s ease-in-out infinite',
                      }}
                    />
                    <div
                      className="w-1 rounded-full"
                      style={{
                        backgroundColor: barsColor,
                        animation: 'breathing-bar-2 0.4s ease-in-out infinite',
                      }}
                    />
                    <div
                      className="w-1 rounded-full"
                      style={{
                        backgroundColor: barsColor,
                        animation: 'breathing-bar-3 0.5s ease-in-out infinite',
                      }}
                    />
                  </div>
                  {/* Pause icon on hover */}
                  <Pause className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 hidden group-hover/bubble:block" />
                </>
              )}
            </div>
          );
        })()}
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
  onBubbleClick,
  audioIndicatorState,
  buttonState,
  isPaused,
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

  // Persistent collapse: once collapsed, stay collapsed until user explicitly expands.
  // Left/right sides are separate component instances so they track independently.
  // Right-side agents share a single instance, so all agents share the same collapse state.
  const [isCollapsed, setIsCollapsed] = useState(false);

  const matchesSide = !!(bubble && bubble.side === side);

  const renderContent = (b: PresentationBubbleModel) => (
    <AnimatePresence mode="wait" initial={false}>
      {isCollapsed ? (
        <motion.div
          key="collapsed"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.18 }}
        >
          <CollapsedBubblePill
            bubble={b}
            onExpand={() => setIsCollapsed(false)}
            onPlayPause={onBubbleClick}
            isPaused={isPaused}
          />
        </motion.div>
      ) : (
        <motion.div
          key="expanded"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.18 }}
          className={PRESENTATION_BUBBLE_WIDTH}
        >
          <PresentationBubbleCard
            bubble={b}
            onClick={onBubbleClick}
            onCollapse={() => setIsCollapsed(true)}
            audioIndicatorState={audioIndicatorState}
            buttonState={buttonState}
            isPaused={isPaused}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );

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
              className="absolute bottom-6 left-6 z-30 pointer-events-auto"
            >
              {renderContent(bubble)}
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
          className="pointer-events-auto"
        >
          {renderContent(bubble)}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
