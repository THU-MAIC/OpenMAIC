'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Send,
  MessageSquare,
  Pause,
  Play,
  ChevronLeft,
  ChevronRight,
  Repeat,
  BookOpen,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useI18n } from '@/lib/hooks/use-i18n';
import { toast } from 'sonner';
import { useSettingsStore, PLAYBACK_SPEEDS } from '@/lib/store/settings';
import { ProactiveCard } from '@/components/chat/proactive-card';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { DiscussionAction } from '@/lib/types/action';
import type { EngineMode, PlaybackView } from '@/lib/playback';
import type { Participant } from '@/lib/types/roundtable';

export interface DiscussionRequest {
  topic: string;
  prompt?: string;
  agentId?: string; // Agent ID to initiate discussion (default: 'default-1')
}

interface RoundtableProps {
  readonly mode?: 'playback' | 'autonomous';
  readonly initialParticipants?: Participant[];
  readonly playbackView?: PlaybackView; // Centralised derived state from Stage
  readonly currentSpeech?: string | null; // Live SSE speech (from StreamBuffer — discussion/QA)
  readonly lectureSpeech?: string | null; // Active lecture speech (from PlaybackEngine, full text)
  readonly idleText?: string | null; // Static idle text (first speech action)
  readonly playbackCompleted?: boolean; // True when engine finished all actions (show restart icon)
  readonly discussionRequest?: DiscussionAction | null;
  readonly engineMode?: EngineMode;
  readonly isStreaming?: boolean;
  readonly sessionType?: 'qa' | 'discussion';
  readonly speakingAgentId?: string | null;
  readonly speechProgress?: number | null; // StreamBuffer reveal progress (0–1) for auto-scroll
  readonly showEndFlash?: boolean;
  readonly endFlashSessionType?: 'qa' | 'discussion';
  readonly thinkingState?: { stage: string; agentId?: string } | null;
  readonly isCueUser?: boolean;
  readonly isTopicPending?: boolean;
  readonly onMessageSend?: (message: string) => void;
  readonly onDiscussionStart?: (request: DiscussionAction) => void;
  readonly onDiscussionSkip?: () => void;
  readonly onStopDiscussion?: () => void;
  readonly onInputActivate?: () => void;

  readonly onResumeTopic?: () => void;
  readonly onPlayPause?: () => void;
  readonly isDiscussionPaused?: boolean;
  readonly onDiscussionPause?: () => void;
  readonly onDiscussionResume?: () => void;
  readonly totalActions?: number;
  readonly currentActionIndex?: number;
  // Toolbar props (merged from CanvasArea)
  readonly currentSceneIndex?: number;
  readonly scenesCount?: number;
  readonly whiteboardOpen?: boolean;
  readonly sidebarCollapsed?: boolean;
  readonly chatCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onToggleChat?: () => void;
  readonly onPrevSlide?: () => void;
  readonly onNextSlide?: () => void;
  readonly onWhiteboardClose?: () => void;
}

const DEFAULT_TEACHER_AVATAR = '/avatars/teacher.png';
const DEFAULT_USER_AVATAR = '/avatars/user.png';

/** Render avatar as <img> for URLs or as emoji text span */
function AvatarDisplay({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const isUrl = src.startsWith('http') || src.startsWith('data:') || src.startsWith('/');
  if (isUrl) {
    return (
      <img src={src} alt={alt || ''} className={cn('w-full h-full object-cover', className)} />
    );
  }
  return (
    <span className={cn('flex items-center justify-center w-full h-full select-none', className)}>
      {src}
    </span>
  );
}

export function Roundtable({
  mode: _mode = 'autonomous',
  initialParticipants = [],
  playbackView,
  currentSpeech,
  lectureSpeech,
  idleText,
  playbackCompleted,
  discussionRequest,
  engineMode = 'idle',
  isStreaming,
  sessionType,
  speakingAgentId,
  speechProgress: _speechProgress,
  showEndFlash,
  endFlashSessionType = 'discussion',
  thinkingState,
  isCueUser,
  isTopicPending,
  onMessageSend,
  onDiscussionStart,
  onDiscussionSkip,
  onStopDiscussion,
  onInputActivate,

  onResumeTopic,
  onPlayPause,
  isDiscussionPaused,
  onDiscussionPause,
  onDiscussionResume,
  currentSceneIndex = 0,
  scenesCount = 1,
  whiteboardOpen = false,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onWhiteboardClose,
}: RoundtableProps) {
  const { t } = useI18n();
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
  const ttsEnabled = useSettingsStore((state) => state.ttsEnabled);
  const asrEnabled = useSettingsStore((state) => state.asrEnabled);
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);
  const autoPlayLecture = useSettingsStore((s) => s.autoPlayLecture);
  const setAutoPlayLecture = useSettingsStore((s) => s.setAutoPlayLecture);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = useSettingsStore((s) => s.setPlaybackSpeed);
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [isVoiceOpen, setIsVoiceOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [userMessage, setUserMessage] = useState<string | null>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const bubbleScrollRef = useRef<HTMLDivElement>(null);
  const teacherAvatarRef = useRef<HTMLDivElement>(null);
  const studentAvatarRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // End flash visible state (Issue 3)
  const [endFlashVisible, setEndFlashVisible] = useState(false);

  // Send cooldown: lock input from "message sent" until "agent bubble appears"
  const [isSendCooldown, setIsSendCooldown] = useState(false);
  const isSendCooldownRef = useRef(false);

  const teacherParticipant = initialParticipants.find((p) => p.role === 'teacher');
  const studentParticipants = initialParticipants.filter(
    (p) => p.role !== 'teacher' && p.role !== 'user',
  );

  // Stable ref object for the current discussion agent's avatar
  const discussionAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!discussionRequest) {
      discussionAnchorRef.current = null;
      return;
    }
    if (discussionRequest.agentId === teacherParticipant?.id) {
      discussionAnchorRef.current = teacherAvatarRef.current;
    } else {
      discussionAnchorRef.current =
        studentAvatarRefs.current.get(discussionRequest.agentId || '') || null;
    }
  }, [discussionRequest, teacherParticipant?.id]);

  // Derived state from Stage's computePlaybackView (centralised derivation)
  const isInLiveFlow =
    playbackView?.isInLiveFlow ??
    !!(speakingAgentId || thinkingState || isStreaming || sessionType);

  // Role-aware source text: userMessage overlay on top of playbackView
  const sourceText = userMessage
    ? userMessage
    : (playbackView?.sourceText ??
      (currentSpeech
        ? currentSpeech
        : isInLiveFlow
          ? ''
          : lectureSpeech || (playbackCompleted ? '' : idleText) || ''));

  // Auto-scroll bubble: keep latest streaming text visible during live/discussion flow
  useEffect(() => {
    if (!isInLiveFlow) return;
    const el = bubbleScrollRef.current;
    if (!el) return;
    const scrollableHeight = el.scrollHeight - el.clientHeight;
    if (scrollableHeight <= 0) return;
    el.scrollTo({ top: scrollableHeight, behavior: 'smooth' });
  }, [sourceText, isInLiveFlow]);

  // End flash effect (Issue 3)
  useEffect(() => {
    if (showEndFlash) {
      setEndFlashVisible(true);
      const timer = setTimeout(() => setEndFlashVisible(false), 1800);
      return () => clearTimeout(timer);
    } else {
      setEndFlashVisible(false);
    }
  }, [showEndFlash]);

  // Clear send cooldown when agent bubble appears
  useEffect(() => {
    if (isSendCooldown && speakingAgentId) {
      setIsSendCooldown(false);
      isSendCooldownRef.current = false;
    }
  }, [isSendCooldown, speakingAgentId]);

  // Safety net: clear cooldown when streaming transitions from active → ended
  // (not when isStreaming was already false — that would clear cooldown immediately)
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && isSendCooldown) {
      setIsSendCooldown(false);
      isSendCooldownRef.current = false;
    }
    prevStreamingRef.current = !!isStreaming;
  }, [isStreaming, isSendCooldown]);

  // Spacebar shortcut: toggle discussion buffer-level pause/resume
  // Much easier than clicking the small bubble during fast text streaming
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when user is typing in an input, textarea, or contentEditable
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) {
        return;
      }
      if (e.code !== 'Space') return;

      // Only handle during live flow (QA/Discussion)
      if (!isInLiveFlow) return;

      e.preventDefault(); // Prevent page scroll

      if (isDiscussionPaused) {
        onDiscussionResume?.();
      } else if (!thinkingState && currentSpeech) {
        // Same guard as bubble click: don't pause during thinking or before text arrives
        onDiscussionPause?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isInLiveFlow,
    isDiscussionPaused,
    thinkingState,
    currentSpeech,
    onDiscussionPause,
    onDiscussionResume,
  ]);

  // Separate participants by role (teacherParticipant & studentParticipants declared earlier for effect)
  const userParticipant = initialParticipants.find((p) => p.role === 'user');

  const teacherAvatar = teacherParticipant?.avatar || DEFAULT_TEACHER_AVATAR;
  const teacherName = teacherParticipant?.name || t('roundtable.teacher');
  const userAvatar = userParticipant?.avatar || DEFAULT_USER_AVATAR;

  // Audio recording
  const { isRecording, isProcessing, startRecording, stopRecording } = useAudioRecorder({
    onTranscription: (text) => {
      if (!text.trim()) {
        toast.info(t('roundtable.noSpeechDetected'));
        setIsVoiceOpen(false);
        return;
      }
      // Block if in send cooldown (e.g. text was sent while voice was processing)
      if (isSendCooldownRef.current) {
        setIsVoiceOpen(false);
        return;
      }
      setUserMessage(text);
      onMessageSend?.(text);
      setIsSendCooldown(true);
      isSendCooldownRef.current = true;
      setIsVoiceOpen(false);

      setTimeout(() => {
        setUserMessage(null);
      }, 3000);
    },
    onError: (error) => {
      toast.error(error);
    },
  });

  const handleSendMessage = () => {
    if (!inputValue.trim() || isSendCooldown) return;

    setUserMessage(inputValue);
    onMessageSend?.(inputValue);
    setIsSendCooldown(true);
    isSendCooldownRef.current = true;
    setInputValue('');
    setIsInputOpen(false);

    setTimeout(() => {
      setUserMessage(null);
    }, 3000);
  };

  const handleToggleInput = () => {
    if (isSendCooldown) return;
    if (!isInputOpen) {
      onInputActivate?.();
    }
    setIsInputOpen(!isInputOpen);
    setIsVoiceOpen(false);
  };

  const handleToggleVoice = () => {
    if (isVoiceOpen) {
      if (isRecording) {
        stopRecording();
      }
      setIsVoiceOpen(false);
    } else {
      if (isSendCooldown) return;
      onInputActivate?.();
      setIsVoiceOpen(true);
      setIsInputOpen(false);
      startRecording();
    }
  };

  // Determine active speaking state and bubble ownership
  // Check if current speaker is a student agent (not teacher)
  const speakingStudent = speakingAgentId
    ? studentParticipants.find((s) => s.id === speakingAgentId)
    : null;

  // Bubble loading: speakingAgentId is set (agent_start fired) but text hasn't arrived yet
  const isBubbleLoading = !!(speakingAgentId && !currentSpeech && !userMessage);
  // Student agent specifically loading (for agent-style bubble)
  const isAgentLoading = !!(speakingStudent && !currentSpeech && !userMessage);

  const activeRole: 'teacher' | 'user' | 'agent' | null = userMessage
    ? 'user'
    : (playbackView?.activeRole ??
      (currentSpeech && speakingStudent
        ? 'agent'
        : currentSpeech
          ? 'teacher'
          : isAgentLoading
            ? 'agent'
            : isBubbleLoading
              ? 'teacher'
              : isCueUser
                ? null
                : lectureSpeech
                  ? 'teacher'
                  : null));

  const bubbleRole: 'teacher' | 'user' | 'agent' | null = userMessage
    ? 'user'
    : (playbackView?.bubbleRole ??
      (currentSpeech && speakingStudent
        ? 'agent'
        : currentSpeech
          ? 'teacher'
          : isAgentLoading
            ? 'agent'
            : isBubbleLoading
              ? 'teacher'
              : isInLiveFlow
                ? null
                : isCueUser
                  ? null
                  : lectureSpeech || idleText
                    ? 'teacher'
                    : null));

  const bubbleName =
    bubbleRole === 'agent'
      ? speakingStudent?.name || t('settings.agentRoles.student')
      : bubbleRole === 'teacher'
        ? teacherName
        : bubbleRole === 'user'
          ? t('roundtable.you')
          : '';

  // Stable key based on speaker identity, NOT text content (prevents re-mount flicker)
  const bubbleKey =
    bubbleRole === 'user'
      ? 'user'
      : bubbleRole === 'agent'
        ? `agent-${speakingAgentId}`
        : bubbleRole === 'teacher'
          ? 'teacher'
          : 'idle';

  // Show stop button whenever there's an active QA/discussion session or live mode.
  // sessionType is only cleared in doSessionCleanup, so this stays stable through
  // brief loading gaps (e.g. between user message and agent SSE response).
  const showStopButton =
    engineMode === 'live' || sessionType === 'qa' || sessionType === 'discussion';

  const handleCycleSpeed = useCallback(() => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackSpeed as (typeof PLAYBACK_SPEEDS)[number]);
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length;
    setPlaybackSpeed(PLAYBACK_SPEEDS[nextIndex]);
  }, [playbackSpeed, setPlaybackSpeed]);

  return (
    <div className="h-[192px] w-full flex flex-col relative z-10 border-t border-gray-100 dark:border-gray-800 bg-white/60 dark:bg-gray-800/60 backdrop-blur-md">
      {/* ── Toolbar strip — merged from CanvasArea ── */}
      <CanvasToolbar
        className="shrink-0 h-8 px-3 border-b border-gray-100/40 dark:border-gray-700/30"
        currentSceneIndex={currentSceneIndex}
        scenesCount={scenesCount}
        engineState={
          engineMode === 'playing' || engineMode === 'live'
            ? 'playing'
            : engineMode === 'paused'
              ? 'paused'
              : 'idle'
        }
        isLiveSession={isStreaming || isTopicPending || engineMode === 'live'}
        whiteboardOpen={whiteboardOpen}
        sidebarCollapsed={sidebarCollapsed}
        chatCollapsed={chatCollapsed}
        onToggleSidebar={onToggleSidebar}
        onToggleChat={onToggleChat}
        onPrevSlide={onPrevSlide ?? (() => {})}
        onNextSlide={onNextSlide ?? (() => {})}
        onPlayPause={onPlayPause ?? (() => {})}
        onWhiteboardClose={onWhiteboardClose ?? (() => {})}
        showStopDiscussion={showStopButton}
        onStopDiscussion={onStopDiscussion}
        ttsEnabled={ttsEnabled}
        ttsMuted={ttsMuted}
        ttsVolume={ttsVolume}
        onToggleMute={() => ttsEnabled && setTTSMuted(!ttsMuted)}
        onVolumeChange={(v) => setTTSVolume(v)}
        autoPlayLecture={autoPlayLecture}
        onToggleAutoPlay={() => setAutoPlayLecture(!autoPlayLecture)}
        playbackSpeed={playbackSpeed}
        onCycleSpeed={handleCycleSpeed}
      />

      {/* ── Interaction area — three-column layout ── */}
      <div className="flex-1 flex items-stretch min-h-0">
        {/* Left: Teacher identity */}
        <div className="w-[90px] shrink-0 flex flex-col border-r border-gray-100/50 dark:border-gray-700/50 bg-white/40 dark:bg-gray-900/40 overflow-visible relative">
          {/* Decorative Element (Top) */}
          <div className="absolute top-0 inset-x-0 h-16 bg-gradient-to-b from-purple-50/50 dark:from-purple-900/10 to-transparent pointer-events-none" />
          <div className="absolute top-3 inset-x-0 flex flex-col items-center justify-center gap-1 opacity-10 pointer-events-none">
            <BookOpen size={20} className="text-purple-900 dark:text-purple-100" />
            <div className="w-8 h-0.5 bg-purple-900 dark:bg-purple-100 rounded-full" />
          </div>

          {/* Main Content */}
          <div className="flex-1 flex items-center justify-center gap-3 px-2 min-h-0 pb-1 pt-8">
            {/* Avatar Group (Left) */}
            <div
              ref={teacherAvatarRef}
              className="relative group cursor-pointer flex flex-col items-center justify-center gap-1"
            >
              <HoverCard openDelay={300} closeDelay={100}>
                <HoverCardTrigger asChild>
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        'relative w-12 h-12 rounded-full transition-all duration-500 flex items-center justify-center',
                        activeRole === 'teacher' ? 'scale-105' : 'opacity-90 scale-95',
                      )}
                    >
                      <div
                        className={cn(
                          'absolute inset-0 rounded-full border-2 transition-all duration-500',
                          activeRole === 'teacher'
                            ? 'border-purple-500 dark:border-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.4)]'
                            : 'border-gray-200 dark:border-gray-700 group-hover:border-purple-300 dark:group-hover:border-purple-600',
                        )}
                      />

                      <div className="w-10 h-10 rounded-full bg-white dark:bg-gray-800 overflow-hidden relative z-10 shadow-sm border border-gray-50 dark:border-gray-700">
                        <img
                          src={teacherAvatar}
                          alt="Teacher"
                          className="w-full h-full object-cover"
                        />
                      </div>

                      {activeRole === 'teacher' && (
                        <div className="absolute -right-0.5 top-0.5 w-4 h-4 bg-green-500 dark:bg-green-400 rounded-full border-2 border-white dark:border-gray-800 flex items-center justify-center z-20">
                          <div className="w-1 h-1 bg-white rounded-full animate-pulse" />
                        </div>
                      )}
                    </div>

                    <span
                      className={cn(
                        'max-w-[80px] truncate px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase border shadow-sm transition-all duration-300 bg-white/90 dark:bg-gray-800/90',
                        activeRole === 'teacher' && !speakingStudent
                          ? 'text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-700'
                          : 'text-gray-400 dark:text-gray-500 border-gray-100 dark:border-gray-700 group-hover:text-purple-500 dark:group-hover:text-purple-400 group-hover:border-purple-200 dark:group-hover:border-purple-600',
                      )}
                    >
                      {teacherName}
                    </span>
                  </div>
                </HoverCardTrigger>
                <HoverCardContent
                  side="bottom"
                  align="center"
                  className="w-64 p-3 max-h-[300px] overflow-y-auto"
                >
                  {(() => {
                    const teacherConfig = useAgentRegistry
                      .getState()
                      .getAgent(teacherParticipant?.id || '');
                    return (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800">
                            <img
                              src={teacherAvatar}
                              alt={teacherName}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{teacherName}</p>
                            <span
                              className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full text-white mt-0.5"
                              style={{
                                backgroundColor: teacherConfig?.color || '#8b5cf6',
                              }}
                            >
                              {t('settings.agentRoles.teacher')}
                            </span>
                          </div>
                        </div>
                        {teacherConfig?.persona && (
                          <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                            {teacherConfig.persona}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </HoverCardContent>
              </HoverCard>

              {/* ProactiveCard from teacher avatar */}
              <AnimatePresence>
                {discussionRequest && discussionRequest.agentId === teacherParticipant?.id && (
                  <ProactiveCard
                    action={discussionRequest}
                    mode={engineMode === 'paused' ? 'paused' : 'playback'}
                    anchorRef={teacherAvatarRef}
                    align="left"
                    agentName={teacherName}
                    agentAvatar={teacherAvatar}
                    agentColor={
                      useAgentRegistry.getState().getAgent(teacherParticipant?.id || '')?.color
                    }
                    onSkip={() => onDiscussionSkip?.()}
                    onListen={() => onDiscussionStart?.(discussionRequest)}
                    onTogglePause={() => onPlayPause?.()}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Center: Interaction stage */}
        <div className="flex-1 relative mx-3 mb-2">
          {/* End flash banner (Issue 3) */}
          <AnimatePresence>
            {endFlashVisible && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.9 }}
                animate={{
                  opacity: [0, 1, 1, 0],
                  y: [-10, 0, 0, -6],
                  scale: [0.9, 1, 1, 0.95],
                }}
                transition={{
                  duration: 1.8,
                  times: [0, 0.15, 0.7, 1],
                  ease: 'easeOut',
                }}
                className="absolute top-1 left-1/2 -translate-x-1/2 z-50 bg-gray-800/80 backdrop-blur-md text-white px-3.5 py-1.5 rounded-full text-xs font-medium pointer-events-none"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block mr-1.5" />
                {endFlashSessionType === 'discussion'
                  ? t('roundtable.discussionEnded')
                  : t('roundtable.qaEnded')}
              </motion.div>
            )}
          </AnimatePresence>

          <div
            onClick={() => {
              if (isInputOpen || isVoiceOpen) {
                setIsInputOpen(false);
                setIsVoiceOpen(false);
                if (isRecording) stopRecording();
              }
            }}
            className="relative w-full h-full rounded-[2.5rem] bg-gradient-to-b from-white/40 to-white/80 dark:from-gray-800/40 dark:to-gray-800/80 backdrop-blur-xl border border-white/50 dark:border-gray-700/50 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_0_rgba(255,255,255,0.9)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] flex flex-col justify-center px-6 overflow-hidden group transition-all duration-700 cursor-default"
          >
            {/* Text input box */}
            <AnimatePresence>
              {isInputOpen && (
                <motion.div
                  key="input-stage"
                  initial={{
                    opacity: 0,
                    scale: 0.95,
                    y: 15,
                    filter: 'blur(4px)',
                  }}
                  animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.95, y: 15, filter: 'blur(4px)' }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-x-6 bottom-4 z-20 flex items-center justify-end"
                >
                  <div className="relative w-fit max-w-[85%] sm:max-w-[65%] min-w-[200px] sm:min-w-[300px] bg-white/90 dark:bg-gray-800/90 backdrop-blur-md p-2 pr-2 rounded-2xl rounded-br-none shadow-2xl border border-purple-200 dark:border-purple-700 flex items-end gap-2 ring-1 ring-purple-100/50 dark:ring-purple-800/50">
                    <div className="pl-4 flex-1 py-1 min-w-0">
                      <textarea
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                        placeholder={t('roundtable.inputPlaceholder')}
                        autoFocus
                        rows={1}
                        className="w-full resize-none bg-transparent border-none focus:ring-0 focus:outline-none outline-none shadow-none ring-0 text-gray-700 dark:text-gray-200 text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 min-h-[40px] max-h-[120px]"
                        style={{ fieldSizing: 'content' } as Record<string, string>}
                      />
                    </div>
                    <button
                      onClick={handleSendMessage}
                      disabled={isSendCooldown}
                      className={cn(
                        'p-2.5 text-white rounded-xl transition shadow-md mb-0.5 shrink-0',
                        isSendCooldown
                          ? 'bg-gray-400 dark:bg-gray-600 cursor-not-allowed shadow-gray-200 dark:shadow-gray-900/50'
                          : 'bg-purple-600 hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600 shadow-purple-200 dark:shadow-purple-900/50',
                      )}
                    >
                      {isSendCooldown ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </motion.div>
              )}

              {/* Audio recording status */}
              {isVoiceOpen && (
                <motion.div
                  key="voice-stage"
                  initial={{
                    opacity: 0,
                    scale: 0.9,
                    x: 20,
                    filter: 'blur(4px)',
                  }}
                  animate={{ opacity: 1, scale: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.9, x: 20, filter: 'blur(4px)' }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-30 flex items-center gap-4 pr-2 pointer-events-none"
                >
                  <div className="flex flex-col-reverse items-end gap-1 mr-[-10px] relative z-20">
                    <div className="flex items-center gap-0.5 h-8 px-2 py-1.5 bg-white/80 dark:bg-gray-800/80 backdrop-blur-md rounded-xl border border-purple-100 dark:border-purple-800 shadow-sm">
                      {[...Array(12)].map((_, i) => (
                        <motion.div
                          key={i}
                          animate={{
                            height: [4, 16 + Math.random() * 12, 4],
                            opacity: [0.3, 1, 0.3],
                          }}
                          transition={{
                            repeat: Infinity,
                            duration: 0.5 + Math.random() * 0.5,
                            delay: i * 0.05,
                            ease: 'easeInOut',
                          }}
                          className="w-1 bg-gradient-to-t from-purple-500 to-indigo-600 dark:from-purple-400 dark:to-indigo-500 rounded-full"
                        />
                      ))}
                    </div>
                    <motion.div
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="text-[10px] font-bold tracking-widest text-purple-600 dark:text-purple-400 uppercase bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm px-2 py-0.5 rounded-full shadow-sm border border-purple-100/50 dark:border-purple-800/50 mr-1"
                    >
                      {isProcessing ? t('roundtable.processing') : t('roundtable.listening')}
                    </motion.div>
                  </div>

                  <div
                    className="pointer-events-auto relative group cursor-pointer"
                    onClick={handleToggleVoice}
                  >
                    <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-purple-600 to-indigo-700 dark:from-purple-500 dark:to-indigo-600 shadow-[0_4px_20px_rgba(147,51,234,0.3)] flex items-center justify-center z-20 group-hover:scale-105 transition-transform duration-300 border border-white/20 dark:border-white/10">
                      <Mic className="w-6 h-6 text-white" />
                    </div>
                    <div className="absolute inset-0 rounded-full border-2 border-purple-500 dark:border-purple-400 opacity-40 animate-[ping_2s_ease-in-out_infinite] z-10" />
                    <div className="absolute inset-0 rounded-full border border-indigo-400 dark:border-indigo-300 opacity-20 animate-[ping_3s_ease-in-out_infinite_0.5s] z-10" />
                    <div className="absolute inset-0 bg-purple-600 dark:bg-purple-500 blur-2xl opacity-20 group-hover:opacity-40 transition-opacity z-0" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Thinking dots (Issue 5) */}
            <AnimatePresence>
              {thinkingState?.stage === 'director' && !currentSpeech && !userMessage && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center gap-2 px-4 py-2 bg-white/90 dark:bg-gray-800/90 backdrop-blur-md rounded-full shadow-sm border border-gray-100 dark:border-gray-700"
                >
                  <div className="flex gap-1">
                    <motion.div
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        repeat: Infinity,
                        duration: 1.2,
                        delay: 0,
                      }}
                      className="w-1.5 h-1.5 rounded-full bg-purple-500"
                    />
                    <motion.div
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        repeat: Infinity,
                        duration: 1.2,
                        delay: 0.2,
                      }}
                      className="w-1.5 h-1.5 rounded-full bg-purple-500"
                    />
                    <motion.div
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        repeat: Infinity,
                        duration: 1.2,
                        delay: 0.4,
                      }}
                      className="w-1.5 h-1.5 rounded-full bg-purple-500"
                    />
                  </div>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 font-medium">
                    {t('roundtable.thinking')}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Cue user: centered indicator when waiting for user input */}
            <AnimatePresence>
              {isCueUser && !bubbleRole && !thinkingState && !isInputOpen && !isVoiceOpen && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ duration: 0.35, ease: [0.21, 1, 0.36, 1] }}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-2.5"
                >
                  {/* Button with ripple effect */}
                  <div className="relative flex items-center justify-center">
                    {/* Soft background glow */}
                    <div
                      className={cn(
                        'absolute w-24 h-24 rounded-full blur-2xl',
                        asrEnabled
                          ? 'bg-amber-400/[0.08] dark:bg-amber-500/[0.06]'
                          : 'bg-purple-400/[0.08] dark:bg-purple-500/[0.06]',
                      )}
                    />

                    {/* Expanding ripple 1 */}
                    <motion.div
                      animate={{ scale: [1, 2.2], opacity: [0.25, 0] }}
                      transition={{
                        repeat: Infinity,
                        duration: 2.2,
                        ease: 'easeOut',
                      }}
                      className={cn(
                        'absolute w-11 h-11 rounded-full border',
                        asrEnabled
                          ? 'border-amber-400/50 dark:border-amber-500/35'
                          : 'border-purple-400/50 dark:border-purple-500/35',
                      )}
                    />
                    {/* Expanding ripple 2 */}
                    <motion.div
                      animate={{ scale: [1, 2.2], opacity: [0.25, 0] }}
                      transition={{
                        repeat: Infinity,
                        duration: 2.2,
                        ease: 'easeOut',
                        delay: 0.7,
                      }}
                      className={cn(
                        'absolute w-11 h-11 rounded-full border',
                        asrEnabled
                          ? 'border-amber-300/40 dark:border-amber-400/25'
                          : 'border-purple-300/40 dark:border-purple-400/25',
                      )}
                    />

                    {/* Action circle — voice (ASR on) or text input (ASR off) */}
                    <motion.button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (asrEnabled) handleToggleVoice();
                        else handleToggleInput();
                      }}
                      animate={{ scale: [1, 1.05, 1] }}
                      transition={{
                        repeat: Infinity,
                        duration: 2,
                        ease: 'easeInOut',
                      }}
                      className={cn(
                        'relative w-11 h-11 rounded-full flex items-center justify-center shadow-lg cursor-pointer hover:shadow-xl active:scale-95 z-10 bg-gradient-to-br',
                        asrEnabled
                          ? 'from-amber-400 to-orange-500 dark:from-amber-500 dark:to-orange-600 shadow-amber-400/30 dark:shadow-amber-600/20 hover:shadow-amber-400/40 dark:hover:shadow-amber-600/30'
                          : 'from-purple-400 to-indigo-500 dark:from-purple-500 dark:to-indigo-600 shadow-purple-400/30 dark:shadow-purple-600/20 hover:shadow-purple-400/40 dark:hover:shadow-purple-600/30',
                      )}
                    >
                      {asrEnabled ? (
                        <Mic className="w-[18px] h-[18px] text-white drop-shadow-sm" />
                      ) : (
                        <MessageSquare className="w-[18px] h-[18px] text-white drop-shadow-sm" />
                      )}
                    </motion.button>
                  </div>

                  {/* Visual indicator below button */}
                  {asrEnabled ? (
                    <div className="flex items-center justify-center gap-[3px] h-3">
                      {[0, 1, 2, 3, 4, 3, 2, 1, 0].map((intensity, i) => (
                        <motion.div
                          key={i}
                          animate={{
                            scaleY: [0.3, 0.5 + intensity * 0.15, 0.3],
                            opacity: [0.3, 0.7, 0.3],
                          }}
                          transition={{
                            repeat: Infinity,
                            duration: 0.8 + (i % 3) * 0.1,
                            delay: i * 0.08,
                            ease: 'easeInOut',
                          }}
                          className="w-[2.5px] h-full origin-center rounded-full bg-amber-400/70 dark:bg-amber-500/60"
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-[3px] h-3">
                      {[0, 1, 2, 3, 2, 1, 0].map((intensity, i) => (
                        <motion.div
                          key={i}
                          animate={{
                            scaleY: [0.3, 0.45 + intensity * 0.15, 0.3],
                            opacity: [0.25, 0.6, 0.25],
                          }}
                          transition={{
                            repeat: Infinity,
                            duration: 1.0 + (i % 3) * 0.15,
                            delay: i * 0.12,
                            ease: 'easeInOut',
                          }}
                          className="w-[2.5px] h-full origin-center rounded-full bg-purple-400/60 dark:bg-purple-500/50"
                        />
                      ))}
                    </div>
                  )}

                  {/* Label */}
                  <motion.span
                    animate={{ opacity: [0.5, 0.9, 0.5] }}
                    transition={{
                      repeat: Infinity,
                      duration: 2.5,
                      ease: 'easeInOut',
                    }}
                    className={cn(
                      'text-[10px] font-medium tracking-wider',
                      asrEnabled
                        ? 'text-amber-600/70 dark:text-amber-400/60'
                        : 'text-purple-600/70 dark:text-purple-400/60',
                    )}
                  >
                    {t('roundtable.yourTurn')}
                  </motion.span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chat bubble */}
            <AnimatePresence mode="wait">
              {bubbleRole && (
                <motion.div
                  key={bubbleKey}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{
                    opacity: isInputOpen || isVoiceOpen ? 0.4 : 1,
                    y: 0,
                    filter: isInputOpen || isVoiceOpen ? 'blur(1px) grayscale(0.2)' : 'none',
                  }}
                  exit={{ opacity: 0, y: -8, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.2, ease: [0.21, 1, 0.36, 1] }}
                  className="w-full flex items-center relative z-10"
                >
                  <div
                    className={cn(
                      'flex w-full transition-all duration-500',
                      bubbleRole === 'teacher' ? 'justify-start' : 'justify-end',
                    )}
                  >
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        if (bubbleRole === 'user') return;
                        // Topic pending: click Play to resume
                        if (isTopicPending) {
                          onResumeTopic?.();
                          return;
                        }
                        // QA/Discussion: buffer-level pause/resume (freeze text reveal, SSE continues)
                        if (isInLiveFlow) {
                          if (isDiscussionPaused) {
                            onDiscussionResume?.();
                          } else if (!thinkingState && currentSpeech) {
                            // Don't allow pause during thinking or before text arrives
                            onDiscussionPause?.();
                          }
                          return;
                        }
                        // Lecture playback: toggle play/pause
                        onPlayPause?.();
                      }}
                      className={cn(
                        'relative px-4 pt-2 pb-3 rounded-2xl text-[15px] leading-relaxed transition-all border max-w-[65%] min-w-[200px] group/bubble flex flex-col max-h-[110px]',
                        bubbleRole === 'teacher' ? 'pl-4 pr-10' : 'pl-4 pr-10',
                        bubbleRole === 'user'
                          ? 'bg-purple-600/95 dark:bg-purple-500/95 backdrop-blur-sm border-purple-400/40 dark:border-purple-300/40 text-white rounded-br-sm shadow-md shadow-purple-300/30 dark:shadow-purple-800/30'
                          : bubbleRole === 'agent'
                            ? cn(
                                'bg-blue-50/95 dark:bg-blue-950/60 backdrop-blur-sm border-blue-200/60 dark:border-blue-800/60 text-gray-700 dark:text-gray-200 rounded-br-sm shadow-sm',
                                (isInLiveFlow || isTopicPending) &&
                                  'hover:shadow-md cursor-pointer',
                              )
                            : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-bl-sm shadow-sm hover:shadow-md cursor-pointer',
                      )}
                    >
                      {bubbleRole &&
                        (() => {
                          const bubbleAvatar =
                            bubbleRole === 'user'
                              ? userAvatar
                              : bubbleRole === 'agent'
                                ? speakingStudent?.avatar || userAvatar
                                : teacherAvatar;
                          return (
                            <div
                              className={cn(
                                'absolute -top-2.5 z-20 pointer-events-none select-none',
                                bubbleRole === 'teacher' ? '-left-2.5' : '-right-2.5',
                              )}
                              title={bubbleName}
                            >
                              <div
                                className={cn(
                                  'w-6 h-6 rounded-full overflow-hidden border-2 shadow-sm',
                                  bubbleRole === 'user'
                                    ? 'border-purple-400 dark:border-purple-500'
                                    : bubbleRole === 'agent'
                                      ? 'border-blue-300 dark:border-blue-600'
                                      : 'border-purple-200 dark:border-purple-700',
                                )}
                              >
                                <AvatarDisplay src={bubbleAvatar} alt={bubbleName} />
                              </div>
                            </div>
                          );
                        })()}

                      <div ref={bubbleScrollRef} className="overflow-y-auto scrollbar-hide">
                        {isBubbleLoading ? (
                          <div className="flex gap-1 items-center py-1">
                            <motion.div
                              animate={{ opacity: [0.3, 1, 0.3] }}
                              transition={{
                                repeat: Infinity,
                                duration: 1,
                                delay: 0,
                              }}
                              className={cn(
                                'w-1.5 h-1.5 rounded-full',
                                isAgentLoading
                                  ? 'bg-blue-400 dark:bg-blue-500'
                                  : 'bg-purple-400 dark:bg-purple-500',
                              )}
                            />
                            <motion.div
                              animate={{ opacity: [0.3, 1, 0.3] }}
                              transition={{
                                repeat: Infinity,
                                duration: 1,
                                delay: 0.2,
                              }}
                              className={cn(
                                'w-1.5 h-1.5 rounded-full',
                                isAgentLoading
                                  ? 'bg-blue-400 dark:bg-blue-500'
                                  : 'bg-purple-400 dark:bg-purple-500',
                              )}
                            />
                            <motion.div
                              animate={{ opacity: [0.3, 1, 0.3] }}
                              transition={{
                                repeat: Infinity,
                                duration: 1,
                                delay: 0.4,
                              }}
                              className={cn(
                                'w-1.5 h-1.5 rounded-full',
                                isAgentLoading
                                  ? 'bg-blue-400 dark:bg-blue-500'
                                  : 'bg-purple-400 dark:bg-purple-500',
                              )}
                            />
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap break-words" suppressHydrationWarning>
                            {sourceText}
                            {isTopicPending && (
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 ml-1 align-middle" />
                            )}
                          </p>
                        )}
                      </div>

                      {/* Playback state icon (hidden during loading — dots already indicate activity) */}
                      {bubbleRole !== 'user' &&
                        !isBubbleLoading &&
                        (() => {
                          const btnState = playbackView?.buttonState ?? 'none';
                          const barsColor =
                            bubbleRole === 'agent' ? 'bg-blue-500' : 'bg-purple-500';

                          if (btnState === 'none') return null;

                          if (btnState === 'play') {
                            return (
                              <div className="absolute right-2.5 bottom-2.5 p-1.5 rounded-full bg-gray-50/80 dark:bg-gray-700/80 hover:bg-purple-100 dark:hover:bg-purple-900/50 group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300 cursor-pointer">
                                <Play className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400 ml-0.5" />
                              </div>
                            );
                          }

                          if (btnState === 'restart') {
                            return (
                              <div className="absolute right-2.5 bottom-2.5 p-1.5 rounded-full bg-gray-50/80 dark:bg-gray-700/80 hover:bg-purple-100 dark:hover:bg-purple-900/50 group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300 cursor-pointer">
                                <Repeat className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400" />
                              </div>
                            );
                          }

                          // btnState === 'bars'
                          return (
                            <div className="absolute right-2.5 bottom-2.5 p-1.5 rounded-full bg-gray-50/80 dark:bg-gray-700/80 group-hover/bubble:bg-purple-100 dark:group-hover/bubble:bg-purple-900/50 transition-all duration-300">
                              {isDiscussionPaused ? (
                                /* Paused: static Play icon */
                                <Play className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 group-hover/bubble:text-purple-600 dark:group-hover/bubble:text-purple-400 ml-0.5" />
                              ) : (
                                <>
                                  {/* Breathing bars — visible by default, hidden on hover */}
                                  <div className="flex gap-0.5 items-end justify-center h-3.5 w-3.5 group-hover/bubble:hidden">
                                    <motion.div
                                      animate={{ height: ['20%', '100%', '20%'] }}
                                      transition={{
                                        repeat: Infinity,
                                        duration: 0.6,
                                      }}
                                      className={cn('w-1 rounded-full', barsColor)}
                                    />
                                    <motion.div
                                      animate={{ height: ['40%', '100%', '40%'] }}
                                      transition={{
                                        repeat: Infinity,
                                        duration: 0.4,
                                      }}
                                      className={cn('w-1 rounded-full', barsColor)}
                                    />
                                    <motion.div
                                      animate={{ height: ['20%', '80%', '20%'] }}
                                      transition={{
                                        repeat: Infinity,
                                        duration: 0.5,
                                      }}
                                      className={cn('w-1 rounded-full', barsColor)}
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
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right: Participants area */}
        <div className="w-[140px] shrink-0 flex flex-col py-3 border-l border-gray-100/50 dark:border-gray-700/50 bg-gray-50/30 dark:bg-gray-900/30 overflow-visible">
          {/* Companion agent avatars — horizontal row, scrollable on overflow, arrows on hover */}
          <div className="flex-none relative group/scroll">
            {/* Left arrow */}
            <button
              onClick={() => {
                agentScrollRef.current?.scrollBy({
                  left: -80,
                  behavior: 'smooth',
                });
              }}
              className="absolute left-0 top-0 bottom-0 w-5 z-10 flex items-center justify-center bg-gradient-to-r from-gray-50/90 dark:from-gray-900/90 to-transparent opacity-0 group-hover/scroll:opacity-100 transition-opacity cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-gray-400" />
            </button>

            <div
              ref={agentScrollRef}
              className="overflow-x-auto overflow-y-hidden px-2 scrollbar-hide"
              onWheel={(e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                  e.currentTarget.scrollLeft += e.deltaY;
                  e.preventDefault();
                }
              }}
            >
              <div className="flex gap-1 w-max py-1">
                {studentParticipants.map((student) => {
                  const isSpeaking = speakingAgentId === student.id;
                  const isThinkingAgent =
                    thinkingState?.stage === 'agent_loading' &&
                    thinkingState.agentId === student.id;
                  const agentConfig = useAgentRegistry.getState().getAgent(student.id);
                  const roleLabelKey = agentConfig?.role as
                    | 'teacher'
                    | 'assistant'
                    | 'student'
                    | undefined;
                  const roleLabel = roleLabelKey ? t(`settings.agentRoles.${roleLabelKey}`) : '';
                  const i18nDescription = t(`settings.agentDescriptions.${student.id}`);
                  const description =
                    i18nDescription !== `settings.agentDescriptions.${student.id}`
                      ? i18nDescription
                      : agentConfig?.persona || '';
                  const hasDescription = !!description;
                  const isDiscussionAgent =
                    !!discussionRequest && discussionRequest.agentId === student.id;
                  return (
                    <div
                      key={student.id}
                      data-agent-id={student.id}
                      ref={(el) => {
                        if (el) studentAvatarRefs.current.set(student.id, el);
                        else studentAvatarRefs.current.delete(student.id);
                      }}
                      className="relative group/student shrink-0"
                    >
                      {/* Breathing glow for discussion agent */}
                      {isDiscussionAgent && (
                        <motion.div
                          animate={{
                            scale: [1, 1.2, 1],
                            opacity: [0.7, 0, 0.7],
                          }}
                          transition={{
                            repeat: Infinity,
                            duration: 2,
                            ease: 'easeInOut',
                          }}
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            border: `2px solid ${agentConfig?.color || '#d97706'}`,
                          }}
                        />
                      )}
                      <HoverCard openDelay={300} closeDelay={100}>
                        <HoverCardTrigger asChild>
                          <div
                            className={cn(
                              'relative w-9 h-9 rounded-full transition-all duration-300 cursor-pointer',
                              isSpeaking
                                ? 'opacity-100 grayscale-0 scale-110'
                                : 'opacity-50 grayscale-[0.2] scale-95 hover:opacity-100 hover:grayscale-0 hover:scale-100',
                            )}
                          >
                            <div
                              className={cn(
                                'absolute inset-0 rounded-full border-2 transition-all duration-300',
                                isSpeaking
                                  ? 'border-purple-500 dark:border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.4)]'
                                  : 'border-white dark:border-gray-700',
                              )}
                            />
                            <div className="absolute inset-0.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                              <img
                                src={student.avatar}
                                alt={student.name}
                                className="w-full h-full"
                              />
                            </div>
                            {/* Speaking indicator */}
                            {isSpeaking && (
                              <div className="absolute -right-0.5 -top-0.5 w-3 h-3 bg-green-500 rounded-full border border-white dark:border-gray-800 z-20 flex items-center justify-center">
                                <div className="w-1 h-1 bg-white rounded-full animate-pulse" />
                              </div>
                            )}
                            {/* Loading indicator (Issue 5) */}
                            {isThinkingAgent && (
                              <div className="absolute inset-0 rounded-full border-2 border-purple-400 border-t-transparent animate-spin z-20" />
                            )}
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent
                          side="bottom"
                          align="center"
                          className="w-64 p-3 max-h-[300px] overflow-y-auto"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800">
                              <img
                                src={student.avatar}
                                alt={student.name}
                                className="w-full h-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{student.name}</p>
                              {roleLabel && roleLabel !== `settings.agentRoles.${roleLabelKey}` && (
                                <span
                                  className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full text-white mt-0.5"
                                  style={{
                                    backgroundColor: agentConfig?.color || '#6b7280',
                                  }}
                                >
                                  {roleLabel}
                                </span>
                              )}
                            </div>
                          </div>
                          {hasDescription && (
                            <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                              {description}
                            </p>
                          )}
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right arrow */}
            <button
              onClick={() => {
                agentScrollRef.current?.scrollBy({
                  left: 80,
                  behavior: 'smooth',
                });
              }}
              className="absolute right-0 top-0 bottom-0 w-5 z-10 flex items-center justify-center bg-gradient-to-l from-gray-50/90 dark:from-gray-900/90 to-transparent opacity-0 group-hover/scroll:opacity-100 transition-opacity cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
            </button>

            {/* ProactiveCard for student/non-teacher agents — rendered via portal */}
            <AnimatePresence>
              {discussionRequest &&
                discussionRequest.agentId !== teacherParticipant?.id &&
                (() => {
                  const matchedStudent = studentParticipants.find(
                    (s) => s.id === discussionRequest.agentId,
                  );
                  const agentConfig = useAgentRegistry
                    .getState()
                    .getAgent(discussionRequest.agentId || '');
                  return (
                    <ProactiveCard
                      action={discussionRequest}
                      mode={engineMode === 'paused' ? 'paused' : 'playback'}
                      anchorRef={discussionAnchorRef}
                      align="left"
                      agentName={matchedStudent?.name || agentConfig?.name}
                      agentAvatar={matchedStudent?.avatar || agentConfig?.avatar}
                      agentColor={agentConfig?.color}
                      onSkip={() => onDiscussionSkip?.()}
                      onListen={() => onDiscussionStart?.(discussionRequest)}
                      onTogglePause={() => onPlayPause?.()}
                    />
                  );
                })()}
            </AnimatePresence>
          </div>

          {/* Divider */}
          <div className="mx-auto my-1.5 w-8 h-px bg-gray-200 dark:bg-gray-700 opacity-50 shrink-0" />

          {/* User avatar + interaction buttons */}
          <div className="flex-1 flex items-center justify-center gap-3 px-2 min-h-0">
            <div className="flex flex-col gap-1.5 shrink-0">
              {isSendCooldown ? (
                /* Unified cooldown indicator — replaces both buttons with a single dot wave */
                <div className="flex items-center justify-center w-8 h-8">
                  <div className="flex items-center gap-[3px]">
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        animate={{
                          y: [0, -3, 0],
                          opacity: [0.35, 0.9, 0.35],
                        }}
                        transition={{
                          repeat: Infinity,
                          duration: 0.9,
                          delay: i * 0.12,
                          ease: 'easeInOut',
                        }}
                        className="w-[4px] h-[4px] rounded-full bg-purple-400 dark:bg-purple-400"
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (asrEnabled) handleToggleVoice();
                    }}
                    disabled={!asrEnabled}
                    className={cn(
                      'w-8 h-8 rounded-full border flex items-center justify-center transition-all active:scale-95 shadow-sm',
                      !asrEnabled
                        ? 'bg-gray-100 dark:bg-gray-800/50 text-gray-300 dark:text-gray-600 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                        : isVoiceOpen
                          ? 'bg-purple-600 dark:bg-purple-500 border-purple-600 dark:border-purple-500 text-white shadow-purple-200 dark:shadow-purple-800'
                          : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-400 hover:border-purple-200 dark:hover:border-purple-700',
                    )}
                  >
                    {asrEnabled ? (
                      <Mic className="w-3.5 h-3.5" />
                    ) : (
                      <MicOff className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleInput();
                    }}
                    className={cn(
                      'w-8 h-8 rounded-full border flex items-center justify-center transition-all active:scale-95 shadow-sm',
                      isInputOpen
                        ? 'bg-purple-600 dark:bg-purple-500 border-purple-600 dark:border-purple-500 text-white shadow-purple-200 dark:shadow-purple-800'
                        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-400 hover:border-purple-200 dark:hover:border-purple-700',
                    )}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>

            {/* User avatar (big, clickable to open input) */}
            <div
              className="relative group cursor-pointer shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleInput();
              }}
            >
              <div
                className={cn(
                  'relative w-16 h-16 rounded-full transition-all duration-300 flex items-center justify-center',
                  activeRole === 'user' || isInputOpen || isCueUser
                    ? 'scale-105'
                    : 'opacity-50 grayscale-[0.2] scale-95 group-hover:opacity-100 group-hover:grayscale-0 group-hover:scale-100',
                )}
              >
                <div
                  className={cn(
                    'absolute inset-0 rounded-full border-2 transition-all duration-300',
                    isCueUser
                      ? 'border-amber-500 dark:border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.4)] animate-pulse'
                      : activeRole === 'user' || isInputOpen
                        ? 'border-purple-600 dark:border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.3)]'
                        : 'border-white dark:border-gray-700 group-hover:border-purple-200 dark:group-hover:border-purple-600',
                  )}
                />
                <div className="w-14 h-14 rounded-full bg-gray-50 dark:bg-gray-800 overflow-hidden relative z-10 shadow-sm border border-gray-50 dark:border-gray-700 text-2xl">
                  <AvatarDisplay src={userAvatar} alt="You" />
                </div>
                <div className="absolute top-0 right-0 w-5 h-5 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-md border border-gray-100 dark:border-gray-700 z-20">
                  <div
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      isInputOpen || isCueUser
                        ? 'bg-purple-500 animate-pulse'
                        : 'bg-gray-300 dark:bg-gray-600',
                    )}
                  />
                </div>
              </div>
              {/* Cue user hint (Issue 7) */}
              <AnimatePresence>
                {isCueUser && (
                  <motion.div
                    initial={{ opacity: 0, y: 4, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.9 }}
                    className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 bg-amber-500 text-white text-[9px] font-bold rounded-full shadow-sm z-30"
                  >
                    {t('roundtable.yourTurn')}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
      {/* close interaction row */}
    </div>
  );
}
