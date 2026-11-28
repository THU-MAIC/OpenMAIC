'use client';

import {
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  useState,
  useMemo,
  useEffect,
  type RefCallback,
} from 'react';
import type { SessionType } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { buildLectureNotes } from '@/lib/chat/lecture-notes';
import { PanelRightClose, BookOpen, Camera, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { InlineQACameraPreview } from '@/components/live-tutor/inline-qa-camera-preview';
import {
  useChatSessions,
  MANUAL_STOP_END_OPTIONS,
  type EndSessionOptions,
  type SessionCleanupPayload,
  type ChatMessageSendOptions,
} from './use-chat-sessions';
import { SessionList } from './session-list';
import { LectureNotesView } from './lecture-notes-view';

interface ChatAreaProps {
  mobile?: boolean;
  mobileQuickReply?: {
    fromAgentId?: string;
    host: HTMLDivElement | null;
    onHostChange: RefCallback<HTMLDivElement>;
  };
  onTabChange?: (tab: 'lecture' | 'chat') => void;
  className?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  activeBubbleId?: string | null;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string, options?: string[]) => void;
  onLiveSessionError?: () => void;
  onLiveSessionStopping?: () => void;
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  onSoftClosingChange?: (softClosing: boolean, deadline?: number) => void;
  onStopSession?: (payload: SessionCleanupPayload) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: (
    messageId?: string,
    partId?: string,
  ) => { holding: boolean; segmentDone: number } | boolean;
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
  /** Pauses classroom playback/discussion audio when Gemini Live starts in the Camera tab. */
  onActivateCameraLive?: () => void;
  /** Optional portal host callback so a parent (PlaybackChromeRoot) can own one persistent tutor across desktop/mobile layouts. */
  onCameraTabHost?: (host: HTMLDivElement | null) => void;
  /** Notifies parent when the desktop Camera tab becomes active or inactive. */
  onCameraTabActiveChange?: (active: boolean) => void;
  /** Streams the latest Q&A transcript to the parent so a hoisted camera tutor stays in sync. */
  onRecentQaTranscriptChange?: (transcript: string) => void;
}

export type SpeechSource = 'lecture' | 'reply' | 'question';

export interface ChatAreaRef {
  revealSpeech: (source: SpeechSource, text: string) => boolean;
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string, options?: EndSessionOptions) => Promise<void>;
  endActiveSession: (options?: EndSessionOptions) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  continueActiveSoftClosingSession: () => boolean;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string, options?: ChatMessageSendOptions) => Promise<void>;
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  pauseActiveLiveBuffer: () => boolean;
  resumeActiveLiveBuffer: () => void;
  switchToTab: (
    tab: 'lecture' | 'chat' | 'camera',
    options?: { followLatest?: boolean; silent?: boolean },
  ) => void;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
      mobile = false,
      mobileQuickReply,
      onTabChange,
      className,
      width = DEFAULT_WIDTH,
      onWidthChange,
      collapsed = false,
      onCollapseChange,
      activeBubbleId,
      onActiveBubble,
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onLiveSessionError,
      onLiveSessionStopping,
      onSoftCloseSession,
      onSoftClosingChange,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
      currentSceneId,
      currentActionIndex,
      canJumpToAction,
      onJumpToAction,
      onActivateCameraLive,
      onCameraTabHost,
      onCameraTabActiveChange,
      onRecentQaTranscriptChange,
    },
    ref,
  ) => {
    const { t } = useI18n();
    const scenes = useStageStore((s) => s.scenes);
    const {
      sessions,
      activeSessionId,
      activeSessionType,
      expandedSessionIds,
      isStreaming,
      createSession,
      endSession,
      endActiveSession,
      continueSoftClosingSession,
      confirmSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      toggleSessionExpand,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
    } = useChatSessions({
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onActiveBubble,
      onLiveSessionError,
      onLiveSessionStopping,
      onSoftCloseSession,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
    });

    const [activeTab, setActiveTab] = useState<'lecture' | 'chat' | 'camera'>('lecture');
    const [cameraEverVisited, setCameraEverVisited] = useState(false);
    const [noteTarget, setNoteTarget] = useState<{ sceneId: string; actionIndex: number } | null>(
      null,
    );
    const [messageTarget, setMessageTarget] = useState<string | null>(null);
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);
    const chatScrollRef = useRef<HTMLDivElement>(null);
    const followReplies = useRef(true);
    const lastFollowPosition = useRef(0);
    const touchingChat = useRef(false);
    const scrollChatToBottom = useCallback(() => {
      const panel = chatScrollRef.current;
      if (panel) panel.scrollTop = panel.scrollHeight;
      lastFollowPosition.current = panel?.scrollTop ?? 0;
    }, []);

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in.
    const lectureNotes = useMemo(() => buildLectureNotes(scenes), [scenes]);

    // Filter out lecture sessions for the Chat tab
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);
    const activeChatSession = mobileQuickReply
      ? chatSessions.find((session) => session.id === activeSessionId)
      : undefined;
    const activeMessages = activeChatSession?.messages;
    const currentAgentReplies = activeMessages
      ?.slice(activeMessages.findLastIndex((message) => message.role === 'user') + 1)
      .filter(
        (message) =>
          message.role === 'assistant' &&
          message.parts.some(
            (part) => (part.type === 'text' && part.text.trim()) || part.type.startsWith('action-'),
          ),
      );
    const fromAgentId = mobileQuickReply?.fromAgentId;
    const quickReplyMessageId =
      (fromAgentId
        ? currentAgentReplies?.findLast((message) => message.metadata?.agentId === fromAgentId)
        : currentAgentReplies?.at(-1)
      )?.id ?? null;
    const quickReplyHost = mobileQuickReply?.host;

    // Extract recent Q&A messages so Gemini Live in the Camera tab shares classroom context
    const recentQaTranscript = useMemo(() => {
      const lines: string[] = [];
      for (const s of chatSessions.slice(-2)) {
        for (const m of s.messages.slice(-8)) {
          const speaker = m.metadata?.senderName || (m.role === 'user' ? 'Student' : 'AI Teacher');
          const text = m.parts
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) lines.push(`${speaker}: ${text}`);
        }
      }
      return lines.slice(-8).join('\n').slice(-1500);
    }, [chatSessions]);

    useEffect(() => {
      onRecentQaTranscriptChange?.(recentQaTranscript);
    }, [onRecentQaTranscriptChange, recentQaTranscript]);

    // On phones the panel owns scrolling across sessions. Stream updates may
    // follow its bottom, but must not move it while someone reads older replies.
    useEffect(() => {
      const panel = chatScrollRef.current;
      if (!mobile || activeTab !== 'chat' || messageTarget || !panel || !panel.clientHeight) return;
      // A scroll event can arrive after this render. Allow the browser to clamp
      // the previous position when the submitted reply buttons are removed.
      const bottom = Math.max(0, panel.scrollHeight - panel.clientHeight);
      if (panel.scrollTop < Math.min(lastFollowPosition.current, bottom) - 2) {
        followReplies.current = false;
      }
      if (followReplies.current && !touchingChat.current) {
        scrollChatToBottom();
      }
    }, [mobile, activeTab, chatSessions, messageTarget, quickReplyHost, scrollChatToBottom]);

    // Whether there's an active discussion/QA session (for amber dot on Chat tab)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    const softClosingChatSession = useMemo(
      () => chatSessions.find((s) => s.status === 'soft-closing'),
      [chatSessions],
    );

    useEffect(() => {
      onSoftClosingChange?.(
        Boolean(softClosingChatSession),
        softClosingChatSession?.softCloseDeadline,
      );
    }, [softClosingChatSession, onSoftClosingChange]);

    // Wrap endSession for QA/Discussion: also notify parent for engine cleanup
    const handleEndSession = useCallback(
      async (sessionId: string) => {
        const session = chatSessions.find((candidate) => candidate.id === sessionId);
        if (session?.status === 'soft-closing') {
          const payload = await confirmSoftClosingSession(sessionId);
          if (payload) onStopSession?.(payload);
          return;
        }
        await endSession(sessionId, MANUAL_STOP_END_OPTIONS);
        onStopSession?.({ sessionId, source: 'manual_stop' });
      },
      [chatSessions, confirmSoftClosingSession, endSession, onStopSession],
    );

    const handleStopActiveSession = useCallback(async () => {
      const active = chatSessions.find(
        (session) => session.status === 'active' || session.status === 'soft-closing',
      );
      if (active) await handleEndSession(active.id);
    }, [chatSessions, handleEndSession]);

    const handleContinueActiveSoftClosingSession = useCallback((): boolean => {
      const softClosing = chatSessions.find((session) => session.status === 'soft-closing');
      return softClosing ? continueSoftClosingSession(softClosing.id) : false;
    }, [chatSessions, continueSoftClosingSession]);

    const switchToTab = useCallback(
      (
        tab: 'lecture' | 'chat' | 'camera',
        { followLatest = false, silent = false }: { followLatest?: boolean; silent?: boolean } = {},
      ) => {
        if (mobile && tab === 'camera') return;
        if (mobile && tab === 'chat' && followLatest && !silent) {
          followReplies.current = true;
          scrollChatToBottom();
        }
        setNoteTarget(null);
        setMessageTarget(null);
        if (tab === 'camera') setCameraEverVisited(true);
        setActiveTab(tab);
        onCameraTabActiveChange?.(tab === 'camera');
        if (tab !== 'camera' && !silent) onTabChange?.(tab);
      },
      [mobile, onCameraTabActiveChange, onTabChange, scrollChatToBottom],
    );

    useImperativeHandle(ref, () => ({
      createSession,
      endSession,
      endActiveSession,
      stopActiveSession: handleStopActiveSession,
      continueActiveSoftClosingSession: handleContinueActiveSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      getIsStreaming: () => isStreaming,
      getActiveSessionType: () => activeSessionType,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      switchToTab,
      revealSpeech(source, text) {
        if (source === 'lecture') {
          const note = lectureNotes.find((entry) => entry.sceneId === currentSceneId);
          const matches = note?.items.filter(
            (item) => item.kind === 'speech' && item.text === text,
          );
          const line =
            matches?.filter((item) => item.actionIndex <= (currentActionIndex ?? -1)).pop() ??
            matches?.[0];
          if (!note || !line) return false;
          switchToTab('lecture');
          setNoteTarget({ sceneId: note.sceneId, actionIndex: line.actionIndex });
          return true;
        }
        for (const session of [...chatSessions].reverse()) {
          const matches = [...session.messages]
            .reverse()
            .filter(
              (message) =>
                (message.role === 'user') === (source === 'question') &&
                message.parts.some((part) => part.type === 'text' && part.text.includes(text)),
            );
          const message = matches.find((item) => item.id === activeBubbleId) ?? matches[0];
          if (!message) continue;
          if (!expandedSessionIds.has(session.id)) toggleSessionExpand(session.id);
          switchToTab('chat');
          setMessageTarget(message.id);
          return true;
        }
        return false;
      },
    }));

    // Drag-to-resize
    const handleDragStart = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        setIsDragging(true);
        const startX = e.clientX;
        const startWidth = width;

        const handleMouseMove = (me: MouseEvent) => {
          const delta = startX - me.clientX;
          const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
          onWidthChange?.(newWidth);
        };

        const handleMouseUp = () => {
          isDraggingRef.current = false;
          setIsDragging(false);
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      },
      [width, onWidthChange],
    );

    const displayWidth = collapsed ? 0 : width;

    return (
      <div
        style={{
          width: mobile ? '100%' : displayWidth,
          transition: isDragging ? 'none' : 'width 0.3s ease',
        }}
        className={cn(
          'bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-l border-gray-100 dark:border-gray-800 shadow-[-2px_0_24px_rgba(0,0,0,0.02)] flex flex-col shrink-0 z-20 relative overflow-visible',
          className,
        )}
      >
        {/* Drag handle */}
        {!mobile && !collapsed && (
          <div
            onMouseDown={handleDragStart}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group hover:bg-purple-400/30 dark:hover:bg-purple-600/30 active:bg-purple-500/40 dark:active:bg-purple-500/40 transition-colors"
          >
            <div className="absolute left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
          </div>
        )}

        <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
          <Tabs
            value={activeTab}
            onValueChange={(v) => switchToTab(v as 'lecture' | 'chat' | 'camera')}
            className="flex flex-col h-full gap-0"
          >
            {/* Tab header row */}
            <div className="h-10 flex items-center gap-1 shrink-0 mt-3 mb-1 px-3">
              <TabsList variant="line" className="h-full flex-1 w-0">
                <TabsTrigger value="lecture" className="text-xs gap-1 flex-1">
                  <BookOpen className="w-3.5 h-3.5" />
                  {t(mobile ? 'mobileClassroom.lecture' : 'chat.tabs.lecture')}
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs gap-1 flex-1 relative">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {t(mobile ? 'mobileClassroom.chat' : 'chat.tabs.chat')}
                  {/* Amber pulse dot when there's an active chat session and user is on Notes tab */}
                  {hasActiveChatSession && activeTab === 'lecture' && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                    </span>
                  )}
                </TabsTrigger>
                {!mobile && (
                  <TabsTrigger
                    value="camera"
                    data-testid="sidebar-camera-tab"
                    className="text-xs gap-1 flex-1"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    {t('liveTutor.classroomButton')}
                  </TabsTrigger>
                )}
              </TabsList>

              {onCollapseChange && (
                <button
                  onClick={() => onCollapseChange(true)}
                  className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 text-gray-500 dark:text-gray-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-gray-200/90 dark:hover:bg-gray-700/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Notes Tab */}
            <TabsContent value="lecture" className="flex-1 overflow-hidden flex flex-col">
              <LectureNotesView
                mobile={mobile}
                notes={lectureNotes}
                target={noteTarget}
                currentSceneId={currentSceneId}
                currentActionIndex={currentActionIndex}
                canJumpToAction={canJumpToAction}
                onJumpToAction={onJumpToAction}
              />
            </TabsContent>

            {/* Chat Tab */}
            <TabsContent value="chat" className="flex-1 overflow-hidden flex flex-col">
              <div
                ref={chatScrollRef}
                onScroll={({ currentTarget: el }) => {
                  if (el.scrollTop === lastFollowPosition.current) return;
                  followReplies.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 3;
                  lastFollowPosition.current = el.scrollTop;
                }}
                onTouchStart={() => {
                  touchingChat.current = true;
                }}
                onTouchEnd={() => {
                  touchingChat.current = false;
                }}
                onTouchCancel={() => {
                  touchingChat.current = false;
                }}
                className={cn(
                  'flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 scrollbar-hide',
                  mobile && 'overscroll-contain [overflow-anchor:none]',
                )}
              >
                {chatSessions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-6 opacity-50">
                    <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-3 text-gray-300 dark:text-gray-600">
                      <MessageSquare className="w-6 h-6" />
                    </div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      {t('chat.noConversations')}
                    </p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                      {t('chat.startConversation')}
                    </p>
                  </div>
                ) : (
                  <>
                    <SessionList
                      mobile={mobile}
                      revealMessageId={messageTarget}
                      sessions={chatSessions}
                      expandedSessionIds={expandedSessionIds}
                      isStreaming={isStreaming}
                      activeBubbleId={messageTarget ?? activeBubbleId}
                      quickReplyTarget={
                        mobileQuickReply && activeChatSession
                          ? {
                              sessionId: activeChatSession.id,
                              messageId: quickReplyMessageId,
                              onHostChange: mobileQuickReply.onHostChange,
                            }
                          : undefined
                      }
                      onToggleExpand={toggleSessionExpand}
                      onEndSession={handleEndSession}
                      onContinueSession={continueSoftClosingSession}
                    />
                  </>
                )}
              </div>
            </TabsContent>

            {/* Persistent Camera Tutor Tab (desktop slot; when onCameraTabHost is supplied, PlaybackChromeRoot portals one persistent tutor here so layout switches never drop an active session) */}
            {!mobile && onCameraTabHost && (
              <div
                ref={onCameraTabHost}
                className={cn(
                  'flex-1 min-h-0 flex flex-col p-3 overflow-hidden',
                  activeTab !== 'camera' && 'hidden',
                )}
              />
            )}
            {!mobile && !onCameraTabHost && (cameraEverVisited || activeTab === 'camera') && (
              <div
                className={cn(
                  'flex-1 min-h-0 flex flex-col p-3 overflow-hidden',
                  activeTab !== 'camera' && 'hidden',
                )}
              >
                <InlineQACameraPreview
                  embedded
                  open
                  onClose={() => switchToTab('chat')}
                  onActivateLive={onActivateCameraLive}
                  recentClassroomSpeech={recentQaTranscript}
                />
              </div>
            )}
          </Tabs>
        </div>
      </div>
    );
  },
);

ChatArea.displayName = 'ChatArea';
