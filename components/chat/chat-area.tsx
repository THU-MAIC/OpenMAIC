'use client';

import { useImperativeHandle, forwardRef, useRef, useCallback, useState, useMemo } from 'react';
import type { SessionType } from '@/lib/types/chat';
import type { LectureNoteEntry } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpeechAction, DiscussionAction } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { PanelRightClose, BookOpen, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useChatSessions } from './use-chat-sessions';
import { SessionList } from './session-list';
import { LectureNotesView } from './lecture-notes-view';

interface ChatAreaProps {
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
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onStopSession?: () => void;
  currentSceneId?: string | null;
}

export interface ChatAreaRef {
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string) => Promise<void>;
  endActiveSession: () => Promise<void>;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  switchToTab: (tab: 'lecture' | 'chat') => void;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
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
      onStopSession,
      currentSceneId,
    },
    ref,
  ) => {
    const { t } = useI18n();
    const scenes = useStageStore((s) => s.scenes);
    const {
      sessions,
      activeSessionType,
      expandedSessionIds,
      isStreaming,
      createSession,
      endSession,
      endActiveSession,
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
    } = useChatSessions({
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onActiveBubble,
      onStopSession,
    });

    const [activeTab, setActiveTab] = useState<'lecture' | 'chat'>('lecture');
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in
    // Preserves action order so spotlight/laser badges appear inline between speech texts
    const lectureNotes: LectureNoteEntry[] = useMemo(
      () =>
        scenes
          .filter((scene) => scene.actions && scene.actions.length > 0)
          .map((scene) => ({
            sceneId: scene.id,
            sceneTitle: scene.title,
            sceneOrder: scene.order,
            items: scene
              .actions!.filter(
                (a) =>
                  a.type === 'speech' ||
                  a.type === 'spotlight' ||
                  a.type === 'laser' ||
                  a.type === 'play_video' ||
                  a.type === 'discussion',
              )
              .map((a) => {
                if (a.type === 'speech') {
                  return {
                    kind: 'speech' as const,
                    text: (a as SpeechAction).text,
                  };
                }
                return {
                  kind: 'action' as const,
                  type: a.type,
                  label: a.type === 'discussion' ? (a as DiscussionAction).topic : undefined,
                };
              }),
            completedAt: scene.updatedAt || scene.createdAt || 0,
          }))
          .sort((a, b) => a.sceneOrder - b.sceneOrder),
      [scenes],
    );

    // Filter out lecture sessions for the Chat tab
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);

    // Whether there's an active discussion/QA session (for amber dot on Chat tab)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    // Wrap endSession for QA/Discussion: also notify parent for engine cleanup
    const handleEndSession = useCallback(
      async (sessionId: string) => {
        await endSession(sessionId);
        onStopSession?.();
      },
      [endSession, onStopSession],
    );

    const switchToTab = useCallback((tab: 'lecture' | 'chat') => {
      setActiveTab(tab);
    }, []);

    useImperativeHandle(ref, () => ({
      createSession,
      endSession,
      endActiveSession,
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
      switchToTab,
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
          width: displayWidth,
          transition: isDragging ? 'none' : 'width 0.3s ease',
        }}
        className={cn(
          'bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-l border-gray-100 dark:border-gray-800 shadow-[-2px_0_24px_rgba(0,0,0,0.02)] flex flex-col shrink-0 z-20 relative overflow-visible',
          className,
        )}
      >
        {/* Drag handle */}
        {!collapsed && (
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
            onValueChange={(v) => setActiveTab(v as 'lecture' | 'chat')}
            className="flex flex-col h-full gap-0"
          >
            {/* Tab header row */}
            <div className="h-10 flex items-center gap-1 shrink-0 mt-3 mb-1 px-3">
              <TabsList variant="line" className="h-full flex-1 w-0">
                <TabsTrigger value="lecture" className="text-xs gap-1 flex-1">
                  <BookOpen className="w-3.5 h-3.5" />
                  {t('chat.tabs.lecture')}
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs gap-1 flex-1 relative">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {t('chat.tabs.chat')}
                  {/* Amber pulse dot when there's an active chat session and user is on Notes tab */}
                  {hasActiveChatSession && activeTab === 'lecture' && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                    </span>
                  )}
                </TabsTrigger>
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
              <LectureNotesView notes={lectureNotes} currentSceneId={currentSceneId} />
            </TabsContent>

            {/* Chat Tab */}
            <TabsContent value="chat" className="flex-1 overflow-hidden flex flex-col">
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 scrollbar-hide">
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
                      sessions={chatSessions}
                      expandedSessionIds={expandedSessionIds}
                      isStreaming={isStreaming}
                      activeBubbleId={activeBubbleId}
                      onToggleExpand={toggleSessionExpand}
                      onEndSession={handleEndSession}
                    />
                    <div ref={bottomRef} />
                  </>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    );
  },
);

ChatArea.displayName = 'ChatArea';
