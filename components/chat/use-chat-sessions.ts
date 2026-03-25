'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  ChatSession,
  SessionType,
  SessionStatus,
  ChatMessageMetadata,
  DirectorState,
} from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpotlightAction, DiscussionAction } from '@/lib/types/action';
import type { UIMessage } from 'ai';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { processSSEStream } from './process-sse-stream';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { AgentStartItem, ActionItem } from '@/lib/buffer/stream-buffer';
import { ActionEngine } from '@/lib/action/engine';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ChatSessions');

interface UseChatSessionsOptions {
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSessionError?: () => void;
  /** Called when a QA/Discussion session completes naturally (director end). */
  onStopSession?: () => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
}

export function useChatSessions(options: UseChatSessionsOptions = {}) {
  const onLiveSpeechRef = useRef(options.onLiveSpeech);
  const onSpeechProgressRef = useRef(options.onSpeechProgress);
  const onThinkingRef = useRef(options.onThinking);
  const onCueUserRef = useRef(options.onCueUser);
  const onActiveBubbleRef = useRef(options.onActiveBubble);
  const onLiveSessionErrorRef = useRef(options.onLiveSessionError);
  const onStopSessionRef = useRef(options.onStopSession);
  const onSegmentSealedRef = useRef(options.onSegmentSealed);
  const shouldHoldAfterRevealRef = useRef(options.shouldHoldAfterReveal);
  useEffect(() => {
    onLiveSpeechRef.current = options.onLiveSpeech;
    onSpeechProgressRef.current = options.onSpeechProgress;
    onThinkingRef.current = options.onThinking;
    onCueUserRef.current = options.onCueUser;
    onActiveBubbleRef.current = options.onActiveBubble;
    onLiveSessionErrorRef.current = options.onLiveSessionError;
    onStopSessionRef.current = options.onStopSession;
    onSegmentSealedRef.current = options.onSegmentSealed;
    shouldHoldAfterRevealRef.current = options.shouldHoldAfterReveal;
  }, [
    options.onLiveSpeech,
    options.onSpeechProgress,
    options.onThinking,
    options.onCueUser,
    options.onActiveBubble,
    options.onLiveSessionError,
    options.onStopSession,
    options.onSegmentSealed,
    options.shouldHoldAfterReveal,
  ]);
  const { t } = useI18n();

  // Track current stageId for data isolation
  const stageId = useStageStore((s) => s.stage?.id);
  const stageIdRef = useRef(stageId);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    // Restore sessions from store (loaded from IndexedDB)
    const stored = useStageStore.getState().chats;
    return stored.map((s) =>
      s.status === 'active' ? { ...s, status: 'interrupted' as SessionStatus } : s,
    );
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<ChatSession[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Per-loop-iteration state — tracks done event data and cue_user for the agent loop
  const loopDoneDataRef = useRef<{
    directorState?: DirectorState;
    totalAgents: number;
    agentHadContent?: boolean;
    cueUserReceived: boolean;
  } | null>(null);

  // Reload sessions when stage changes (course switch)
  // This synchronous setState is intentional: it resets derived state from
  // an external store (IndexedDB) when the stageId dependency changes.
  useEffect(() => {
    if (stageId === stageIdRef.current) return;
    stageIdRef.current = stageId;
    // Stage changed — reload sessions from store (already populated by loadFromStorage)
    const stored = useStageStore.getState().chats;
    setSessions(
      stored.map((s) =>
        s.status === 'active' ? { ...s, status: 'interrupted' as SessionStatus } : s,
      ),
    );
    setActiveSessionId(null);
    setExpandedSessionIds(new Set());
  }, [stageId]);

  // Sync sessions back to store for persistence (debounced via store's debouncedSave)
  // Guard: only write to the currently active stage
  useEffect(() => {
    if (stageIdRef.current && stageIdRef.current === useStageStore.getState().stage?.id) {
      useStageStore.getState().setChats(sessions);
    }
  }, [sessions]);

  // StreamBuffer instances per session (SSE + lecture share the same buffer model)
  const buffersRef = useRef<Map<string, StreamBuffer>>(new Map());

  // Abort active stream and destroy buffers on unmount
  useEffect(() => {
    const buffers = buffersRef.current;
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      buffers.forEach((buf) => buf.shutdown());
      buffers.clear();
    };
  }, []);

  // Session-scoped "paused intent" — survives buffer recreation across turns.
  // When true, newly created discussion/QA buffers are immediately paused.
  const livePausedRef = useRef(false);

  const clearLiveSessionAfterError = useCallback((sessionId: string, message: string) => {
    const now = Date.now();
    const errorMessageId = `error-${now}`;

    const buf = buffersRef.current.get(sessionId);
    if (buf) {
      buf.shutdown();
      buffersRef.current.delete(sessionId);
    }

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              updatedAt: now,
              messages: [
                ...s.messages,
                {
                  id: errorMessageId,
                  role: 'assistant' as const,
                  parts: [{ type: 'text', text: message }],
                  metadata: {
                    senderName: 'System',
                    originalRole: 'agent' as const,
                    createdAt: now,
                  },
                },
              ],
            }
          : s,
      ),
    );

    onActiveBubbleRef.current?.(null);
    if (onLiveSessionErrorRef.current) {
      onLiveSessionErrorRef.current();
    } else {
      onSpeechProgressRef.current?.(null);
      onThinkingRef.current?.(null);
      onLiveSpeechRef.current?.(null, null);
    }
  }, []);

  // Tracks the single message ID per lecture session
  const lectureMessageIds = useRef<Map<string, string>>(new Map());

  // Tracks last action index per lecture session (avoids stale closure reads)
  const lectureLastActionIndexRef = useRef<Map<string, number>>(new Map());

  const toggleSessionExpand = useCallback((sessionId: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  /**
   * Create a StreamBuffer for a session and wire its callbacks to React state.
   * Returns the buffer instance (also stored in buffersRef).
   */
  const createBufferForSession = useCallback(
    (sessionId: string, type?: SessionType): StreamBuffer => {
      // Dispose previous buffer if any
      // Shutdown (not dispose) — avoids stale onLiveSpeech(null,null) callback
      const prev = buffersRef.current.get(sessionId);
      if (prev) prev.shutdown();

      // For discussion/QA sessions, add pacing delays so fast models don't
      // rush through text and actions. Lecture pacing is handled by PlaybackEngine.
      const pacingOptions = type === 'lecture' ? {} : { postTextDelayMs: 1200, actionDelayMs: 800 };

      const buffer = new StreamBuffer(
        {
          onAgentStart(data: AgentStartItem) {
            const now = Date.now();
            const agentConfig = useAgentRegistry.getState().getAgent(data.agentId);
            const newMsg: UIMessage<ChatMessageMetadata> = {
              id: data.messageId,
              role: 'assistant',
              parts: [],
              metadata: {
                senderName: agentConfig?.name || data.agentName,
                senderAvatar: data.avatar || agentConfig?.avatar,
                originalRole: 'agent',
                agentId: data.agentId,
                createdAt: now,
              },
            };
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? { ...s, messages: [...s.messages, newMsg], updatedAt: now }
                  : s,
              ),
            );
            onActiveBubbleRef.current?.(data.messageId);
          },

          onAgentEnd() {
            // Remove empty assistant messages (agent started but produced no content)
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const msgs = s.messages.filter(
                  (m) => !(m.role === 'assistant' && m.parts.length === 0),
                );
                return msgs.length !== s.messages.length ? { ...s, messages: msgs } : s;
              }),
            );
          },

          onTextReveal(
            messageId: string,
            partId: string,
            revealedText: string,
            _isComplete: boolean,
          ) {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== messageId) return m;
                    const parts = [...m.parts];
                    // Match by _partId (supports multiple text parts per message, e.g. lecture)
                    const existingIdx = parts.findIndex(
                      (p) => (p as unknown as Record<string, unknown>)._partId === partId,
                    );
                    if (existingIdx >= 0) {
                      parts[existingIdx] = {
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                    } else {
                      parts.push({
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number]);
                    }
                    return { ...m, parts };
                  }),
                  // Don't update updatedAt on every tick — avoids thrashing persistence sync
                };
              }),
            );
          },

          onActionReady(messageId: string, data: ActionItem) {
            // Add action badge to message parts
            const actionPart = {
              type: `action-${data.actionName}`,
              actionId: data.actionId,
              actionName: data.actionName,
              input: data.params,
              state: 'result',
              output: { success: true },
            } as unknown as UIMessage<ChatMessageMetadata>['parts'][number];

            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === messageId ? { ...m, parts: [...m.parts, actionPart] } : m,
                  ),
                  updatedAt: Date.now(),
                };
              }),
            );

            // Execute the action via ActionEngine (fire-and-forget for visual effects)
            try {
              const actionEngine = new ActionEngine(useStageStore);
              const action = {
                id: data.actionId,
                type: data.actionName,
                ...data.params,
              } as Action;
              actionEngine.execute(action);
            } catch (err) {
              log.warn('[Buffer] Action execution error:', err);
            }
          },

          onLiveSpeech(text: string | null, agentId: string | null) {
            // Lecture sessions: roundtable text is managed by PlaybackEngine → setLectureSpeech
            // in stage.tsx. Buffer only drives chat area pacing for lectures.
            if (type === 'lecture') return;
            onLiveSpeechRef.current?.(text, agentId);
          },

          onSpeechProgress(ratio: number | null) {
            onSpeechProgressRef.current?.(ratio);
          },

          onThinking(data: { stage: string; agentId?: string } | null) {
            onThinkingRef.current?.(data);
          },

          onCueUser(fromAgentId?: string, prompt?: string) {
            // Track cue_user for agent loop
            if (loopDoneDataRef.current) {
              loopDoneDataRef.current.cueUserReceived = true;
            } else {
              loopDoneDataRef.current = {
                totalAgents: 0,
                cueUserReceived: true,
              };
            }
            onCueUserRef.current?.(fromAgentId, prompt);
          },

          onDone(data: {
            totalActions: number;
            totalAgents: number;
            agentHadContent?: boolean;
            directorState?: DirectorState;
          }) {
            // Store done data for agent loop consumption
            loopDoneDataRef.current = {
              directorState: data.directorState,
              totalAgents: data.totalAgents,
              agentHadContent: data.agentHadContent ?? true,
              cueUserReceived: loopDoneDataRef.current?.cueUserReceived ?? false,
            };
            // Session completion is handled by runAgentLoop, not here
            // (Lectures don't use the agent loop and complete via endSession)
          },

          onError(message: string) {
            log.error('[Buffer] Stream error:', message);
          },

          onSegmentSealed(
            messageId: string,
            partId: string,
            fullText: string,
            agentId: string | null,
          ) {
            onSegmentSealedRef.current?.(messageId, partId, fullText, agentId);
          },

          shouldHoldAfterReveal() {
            return shouldHoldAfterRevealRef.current?.() ?? (false as const);
          },
        },
        pacingOptions,
      );

      buffersRef.current.set(sessionId, buffer);
      buffer.start();

      // Inherit paused intent for discussion/QA sessions so new-turn buffers
      // don't start revealing text while the user has paused reading.
      if (type !== 'lecture' && livePausedRef.current) {
        buffer.pause();
      }

      return buffer;
    },
    [],
  );

  /**
   * Frontend-driven agent loop. Sends per-agent requests until:
   * - Director returns END (no agent spoke, no cue_user)
   * - Director returns USER (cue_user event received)
   * - maxTurns reached
   * - Request aborted
   *
   * Each iteration: POST /api/chat → process SSE → wait for buffer drain → check outcome.
   */
  const runAgentLoop = useCallback(
    async (
      sessionId: string,
      requestTemplate: {
        messages: UIMessage<ChatMessageMetadata>[];
        storeState: Record<string, unknown>;
        config: {
          agentIds: string[];
          sessionType?: string;
          agentConfigs?: Record<string, unknown>[];
          [key: string]: unknown;
        };
        userProfile?: { nickname?: string; bio?: string };
        apiKey: string;
        baseUrl?: string;
        model?: string;
        providerType?: string;
        requiresApiKey?: boolean;
      },
      controller: AbortController,
      sessionType: SessionType,
    ): Promise<void> => {
      const settingsState = useSettingsStore.getState();

      // Attach full configs for generated (non-default) agents so the server can use them.
      // The server-side registry only has default agents; generated agents exist only client-side.
      const generatedConfigs = requestTemplate.config.agentIds
        .filter((id: string) => !id.startsWith('default-'))
        .map((id: string) => useAgentRegistry.getState().getAgent(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map(({ createdAt: _c, updatedAt: _u, isDefault: _d, ...rest }) => rest);
      if (generatedConfigs.length > 0) {
        requestTemplate.config.agentConfigs = generatedConfigs;
      }

      const defaultMaxTurns = requestTemplate.config.agentIds.length <= 1 ? 1 : 10;
      const maxTurns = settingsState.maxTurns
        ? parseInt(settingsState.maxTurns, 10) || defaultMaxTurns
        : defaultMaxTurns;

      let directorState: DirectorState | undefined = undefined;
      let turnCount = 0;
      let currentMessages = requestTemplate.messages;
      let consecutiveEmptyTurns = 0;

      while (turnCount < maxTurns) {
        if (controller.signal.aborted) break;

        // Reset loop state for this iteration
        loopDoneDataRef.current = null;

        // Refresh store state each iteration — agent actions may have changed
        // whiteboard, scene, or mode between turns
        const freshState = useStageStore.getState();
        const freshStoreState = {
          stage: freshState.stage,
          scenes: freshState.scenes,
          currentSceneId: freshState.currentSceneId,
          mode: freshState.mode,
          whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
        };

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...requestTemplate,
            messages: currentMessages,
            storeState: freshStoreState,
            directorState,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} - ${errorText}`);
        }

        const buffer = createBufferForSession(sessionId, sessionType);
        await processSSEStream(response, sessionId, buffer, controller.signal);

        // Wait for buffer to finish playing all items (character animations, delays)
        try {
          await buffer.waitUntilDrained();
        } catch {
          // Buffer was disposed/shutdown (abort or session end) — exit loop
          break;
        }

        if (controller.signal.aborted) break;

        // Read loop outcome from done data.
        // loopDoneDataRef is mutated by StreamBuffer callbacks (onDone, onCueUser);
        // TypeScript's CFA can't track cross-callback mutations.
        const doneData = loopDoneDataRef.current as {
          directorState?: DirectorState;
          totalAgents: number;
          agentHadContent?: boolean;
          cueUserReceived: boolean;
        } | null;
        if (!doneData) break; // No done event — something went wrong

        // Update accumulated director state
        directorState = doneData.directorState;
        turnCount = directorState?.turnCount ?? turnCount + 1;

        // Check outcome
        if (doneData.cueUserReceived) {
          // Director said USER — stop loop, wait for user input
          break;
        }
        if (doneData.totalAgents === 0) {
          // Director said END — no agent spoke, conversation complete
          break;
        }

        // Track consecutive empty responses (agent dispatched but produced no content)
        if (doneData.agentHadContent === false) {
          consecutiveEmptyTurns++;
          if (consecutiveEmptyTurns >= 2) {
            log.warn(
              `[AgentLoop] ${consecutiveEmptyTurns} consecutive empty agent responses, stopping loop`,
            );
            break;
          }
        } else {
          consecutiveEmptyTurns = 0;
        }

        // Agent spoke — continue loop if under maxTurns
        // Refresh messages from latest session state for next iteration
        const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
        if (currentSession) {
          currentMessages = currentSession.messages;
        }
      }

      // Handle loop completion
      const doneData = loopDoneDataRef.current;
      if (!controller.signal.aborted) {
        const wasCueUser = doneData?.cueUserReceived ?? false;
        if (!wasCueUser) {
          // Session completed normally (END or maxTurns reached)
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    status: 'completed' as SessionStatus,
                    updatedAt: Date.now(),
                  }
                : s,
            ),
          );
          onStopSessionRef.current?.();
        }
        // If maxTurns reached, log it
        if (turnCount >= maxTurns && doneData && doneData.totalAgents > 0) {
          log.info(`[AgentLoop] Max turns (${maxTurns}) reached for session ${sessionId}`);
        }
      }
    },
    [createBufferForSession],
  );

  /**
   * Create a new chat session
   */
  const createSession = useCallback(async (type: SessionType, title: string): Promise<string> => {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();

    const newSession: ChatSession = {
      id: sessionId,
      type,
      title,
      status: 'active',
      messages: [],
      config: {
        agentIds: ['default-1'],
        maxTurns: 0, // Not used for runtime — frontend loop manages maxTurns
        currentTurn: 0,
        defaultAgentId: 'default-1',
      },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: now,
      updatedAt: now,
    };

    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(sessionId);
    setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

    log.info(`[ChatArea] Created session: ${sessionId} (${type})`);
    return sessionId;
  }, []);

  /**
   * End a chat session.
   * For QA/Discussion sessions with active streaming, appends "..." + interrupted marker.
   */
  const endSession = useCallback(
    async (sessionId: string): Promise<void> => {
      log.info(`[ChatArea] Ending session: ${sessionId}`);
      livePausedRef.current = false;

      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const isLiveSession = session && (session.type === 'qa' || session.type === 'discussion');
      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      // Only abort if this session owns the active stream
      if (wasStreaming) {
        abortControllerRef.current!.abort();
        abortControllerRef.current = null;
        streamingSessionIdRef.current = null;
        setIsStreaming(false);
      }

      // Destroy buffer — shutdown avoids firing stale onLiveSpeech(null,null)
      const buf = buffersRef.current.get(sessionId);
      if (buf) {
        buf.shutdown();
        buffersRef.current.delete(sessionId);
      }
      lectureMessageIds.current.delete(sessionId);
      lectureLastActionIndexRef.current.delete(sessionId);

      if (isLiveSession && wasStreaming) {
        // Append "..." + interrupted marker to last assistant message
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            return { ...s, messages, status: 'completed' as SessionStatus };
          }),
        );
        // Clear roundtable state via callbacks
        onLiveSpeechRef.current?.(null, null);
        onThinkingRef.current?.(null);
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, status: 'completed' as SessionStatus } : s,
          ),
        );
      }

      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId],
  );

  /**
   * End the currently active QA/Discussion session (if any).
   */
  const endActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(
      (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
    );
    if (active) {
      await endSession(active.id);
    }
  }, [endSession]);

  /**
   * Soft-pause the active QA/Discussion session.
   * Aborts SSE and appends "..." + interrupted marker, but keeps session 'active'
   * so the user can continue speaking in the same topic.
   */
  const softPauseSession = useCallback(async (sessionId: string): Promise<void> => {
    livePausedRef.current = false;
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;
    const isLiveSession = session.type === 'qa' || session.type === 'discussion';
    if (!isLiveSession || session.status !== 'active') return;

    const wasStreaming = !!(
      abortControllerRef.current && streamingSessionIdRef.current === sessionId
    );

    // Destroy buffer — no more ticks, no stale onDone/onLiveSpeech callbacks.
    // Resume will create a fresh buffer.
    const buf = buffersRef.current.get(sessionId);
    if (buf) {
      buf.shutdown();
      buffersRef.current.delete(sessionId);
    }

    // Abort SSE stream
    if (wasStreaming) {
      abortControllerRef.current!.abort();
      abortControllerRef.current = null;
      streamingSessionIdRef.current = null;
      setIsStreaming(false);
    }

    if (wasStreaming) {
      // Append "..." + interrupted marker to last assistant message, keep status 'active'
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const messages = [...s.messages];
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
              const parts = [...messages[i].parts];
              let appended = false;
              for (let j = parts.length - 1; j >= 0; j--) {
                if (parts[j].type === 'text') {
                  const textPart = parts[j] as { type: 'text'; text: string };
                  parts[j] = {
                    type: 'text',
                    text: (textPart.text || '') + '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number];
                  appended = true;
                  break;
                }
              }
              if (!appended) {
                parts.push({
                  type: 'text',
                  text: '...',
                } as UIMessage<ChatMessageMetadata>['parts'][number]);
              }
              messages[i] = {
                ...messages[i],
                parts,
                metadata: { ...messages[i].metadata, interrupted: true },
              };
              break;
            }
          }
          // Keep status 'active' — session continues when user speaks
          return { ...s, messages, updatedAt: Date.now() };
        }),
      );
      // Note: Do NOT call onLiveSpeech/onThinking here.
      // Caller (doSoftPause) manages roundtable state to keep the interrupted bubble visible.
    }

    log.info(`[ChatArea] Soft-paused session: ${sessionId}`);
  }, []);

  /**
   * Soft-pause the currently active QA/Discussion session (if any).
   */
  const softPauseActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(
      (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
    );
    if (active) {
      await softPauseSession(active.id);
    }
  }, [softPauseSession]);

  /**
   * Resume a soft-paused session by re-calling /chat with existing messages.
   * The director will pick the next agent to continue the topic.
   */
  const resumeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.status !== 'active') return;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const currentState = useStageStore.getState();

      try {
        log.info(`[ChatArea] Resuming session: ${sessionId}`);

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        const agentIds =
          useSettingsStore.getState().selectedAgentIds?.length > 0
            ? useSettingsStore.getState().selectedAgentIds
            : session.config.agentIds;

        await runAgentLoop(
          sessionId,
          {
            messages: session.messages,
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
            },
            config: {
              agentIds,
              sessionType: session.type,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            requiresApiKey: mc.requiresApiKey,
          },
          controller,
          session.type,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Resume aborted');
          return;
        }
        log.error('[ChatArea] Resume error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [clearLiveSessionAfterError, runAgentLoop],
  );

  /**
   * Resume the currently active soft-paused session (if any).
   */
  const resumeActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(
      (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
    );
    if (active) {
      await resumeSession(active.id);
    }
  }, [resumeSession]);

  /**
   * Send a message to the active session
   */
  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      let sessionId = activeSessionId;

      // Interrupt active generation: abort stream and append "..." to the last agent message
      if (isStreaming && abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;

        if (sessionId) {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') {
                  const parts = [...messages[i].parts];
                  for (let j = parts.length - 1; j >= 0; j--) {
                    if (parts[j].type === 'text') {
                      const textPart = parts[j] as {
                        type: 'text';
                        text: string;
                      };
                      parts[j] = {
                        type: 'text',
                        text: (textPart.text || '') + '...',
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                      messages[i] = { ...messages[i], parts };
                      return { ...s, messages, updatedAt: Date.now() };
                    }
                  }
                  break;
                }
              }
              return s;
            }),
          );
        }
      }

      // Validate model configuration before sending
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Create a new session when there's no active QA session to append to.
      // A completed session should NOT be reused — start a fresh one instead.
      const activeSession = sessionsRef.current.find((s) => s.id === sessionId);
      const needNewSession =
        !sessionId || activeSession?.type === 'lecture' || activeSession?.status === 'completed';

      if (needNewSession) {
        // End all active QA/Discussion sessions before creating new one
        const activeQAOrDiscussion = sessionsRef.current.filter(
          (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
        );
        for (const session of activeQAOrDiscussion) {
          await endSession(session.id);
        }
        sessionId = await createSession('qa', 'Q&A');
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const now = Date.now();
      const userMessageId = `user-${now}`;

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0 ? settingsState.selectedAgentIds : ['default-1'];

      const userMessage: UIMessage<ChatMessageMetadata> = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
        metadata: {
          senderName: t('common.you'),
          senderAvatar: USER_AVATAR,
          originalRole: 'user',
          createdAt: now,
        },
      };

      // Read current session data from ref (avoids stale closure AND keeps updater pure)
      const existingSession = sessionsRef.current.find((s) => s.id === sessionId);
      const sessionMessages: UIMessage<ChatMessageMetadata>[] = existingSession
        ? [...existingSession.messages, userMessage]
        : [userMessage];
      const sessionType: SessionType = existingSession?.type || 'qa';

      // Pure updater — no side effects
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === sessionId);
        if (exists) {
          return prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: [...s.messages, userMessage],
                  status: 'active' as SessionStatus,
                  updatedAt: now,
                }
              : s,
          );
        } else {
          const newSession: ChatSession = {
            id: sessionId!,
            type: 'qa',
            title: 'Q&A',
            status: 'active',
            messages: [userMessage],
            config: {
              agentIds,
              maxTurns: 0, // Not used for runtime — frontend loop manages maxTurns
              currentTurn: 0,
              defaultAgentId: agentIds[0],
            },
            toolCalls: [],
            pendingToolCalls: [],
            createdAt: now,
            updatedAt: now,
          };
          return [...prev, newSession];
        }
      });

      const currentState = useStageStore.getState();

      try {
        log.info(
          `[ChatArea] Sending message: "${content.slice(0, 50)}..." agents: ${agentIds.join(', ')}`,
        );

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoop(
          sessionId!,
          {
            messages: sessionMessages,
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
            },
            config: {
              agentIds,
              sessionType,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            requiresApiKey: mc.requiresApiKey,
          },
          controller,
          sessionType,
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Request aborted by user');
          return;
        }

        log.error('[ChatArea] Error:', error);
        clearLiveSessionAfterError(
          sessionId!,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [
      activeSessionId,
      clearLiveSessionAfterError,
      isStreaming,
      createSession,
      endSession,
      runAgentLoop,
      t,
    ],
  );

  /**
   * Start a discussion with agent speaking first
   */
  const startDiscussion = useCallback(
    async (request: DiscussionRequest): Promise<void> => {
      log.info(`[ChatArea] Starting discussion: "${request.topic}"`);
      // Explicitly clear buffer-pause intent (also cleared transitively via endSession,
      // but being explicit guards against future refactors)
      livePausedRef.current = false;

      // Validate model configuration before starting discussion
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Auto-end previous active QA/Discussion sessions to ensure only one is active
      const activeQAOrDiscussion = sessionsRef.current.filter(
        (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
      );
      for (const session of activeQAOrDiscussion) {
        await endSession(session.id);
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const agentId = request.agentId || 'default-1';

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0
          ? [...settingsState.selectedAgentIds]
          : [agentId];
      // Ensure the trigger agent is included
      if (!agentIds.includes(agentId)) {
        agentIds.unshift(agentId);
      }

      // No pre-created assistant message — agent_start events create them dynamically
      const newSession: ChatSession = {
        id: sessionId,
        type: 'discussion',
        title: request.topic,
        status: 'active',
        messages: [],
        config: {
          agentIds,
          maxTurns: 0, // Not used for runtime — frontend loop manages maxTurns
          currentTurn: 0,
          triggerAgentId: agentId,
        },
        toolCalls: [],
        pendingToolCalls: [],
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const currentState = useStageStore.getState();

      try {
        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoop(
          sessionId,
          {
            messages: [],
            storeState: {
              stage: currentState.stage,
              scenes: currentState.scenes,
              currentSceneId: currentState.currentSceneId,
              mode: currentState.mode,
              whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
            },
            config: {
              agentIds,
              sessionType: 'discussion',
              discussionTopic: request.topic,
              discussionPrompt: request.prompt,
              triggerAgentId: agentId,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            apiKey: mc.apiKey,
            baseUrl: mc.baseUrl,
            model: mc.modelString,
            providerType: mc.providerType,
            requiresApiKey: mc.requiresApiKey,
          },
          controller,
          'discussion',
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Discussion aborted by user');
          return;
        }

        log.error('[ChatArea] Discussion error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error starting discussion: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n context
    [clearLiveSessionAfterError, endSession, runAgentLoop],
  );

  /**
   * Handle interruption
   */
  const handleInterrupt = useCallback(() => {
    if (!abortControllerRef.current) return;

    log.info('[ChatArea] Interrupting active request');
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    streamingSessionIdRef.current = null;
  }, []);

  /**
   * Start a lecture session for a scene.
   * Creates a single assistant message that all actions will be appended to.
   * Deduplicates: returns existing active lecture session for the same sceneId if found.
   */
  const startLecture = useCallback(
    async (sceneId: string): Promise<string> => {
      // Check for existing lecture session with same sceneId (active or completed)
      const existing = sessions.find(
        (s) =>
          s.type === 'lecture' &&
          s.sceneId === sceneId &&
          (s.status === 'active' || s.status === 'completed'),
      );
      if (existing) {
        // Reactivate a completed session so the chat panel shows it as active again.
        // Actions won't be re-appended because lastActionIndex already covers them.
        if (existing.status === 'completed') {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === existing.id ? { ...s, status: 'active' as SessionStatus } : s,
            ),
          );
          // Restore lecture tracking refs (cleared by endSession)
          const messageId = existing.messages[0]?.id;
          if (messageId) {
            lectureMessageIds.current.set(existing.id, messageId);
          }
          if (existing.lastActionIndex !== undefined) {
            lectureLastActionIndexRef.current.set(existing.id, existing.lastActionIndex);
          }
        }
        setActiveSessionId(existing.id);
        setExpandedSessionIds((prev) => new Set([...prev, existing.id]));
        return existing.id;
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const messageId = `lecture-msg-${now}`;

      const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
      const title = scene?.title || t('chat.lecture');

      const agentConfig = useAgentRegistry.getState().getAgent('default-1');

      // Create session with a single assistant message (all actions append parts here)
      const lectureMessage: UIMessage<ChatMessageMetadata> = {
        id: messageId,
        role: 'assistant',
        parts: [],
        metadata: {
          senderName: agentConfig?.name || t('settings.agentNames.default-1'),
          senderAvatar: agentConfig?.avatar,
          originalRole: 'teacher',
          agentId: 'default-1',
          createdAt: now,
        },
      };

      const newSession: ChatSession = {
        id: sessionId,
        type: 'lecture',
        title,
        status: 'active',
        messages: [lectureMessage],
        config: {
          agentIds: ['default-1'],
          maxTurns: 0,
          currentTurn: 0,
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId,
        lastActionIndex: -1,
        createdAt: now,
        updatedAt: now,
      };

      lectureMessageIds.current.set(sessionId, messageId);

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      log.info(`[ChatArea] Created lecture session: ${sessionId} for scene ${sceneId}`);
      return sessionId;
    },
    [sessions, t],
  );

  /**
   * Add a lecture action to the single message bubble via StreamBuffer.
   * Speech → pushText + sealText (buffer handles pacing).
   * Spotlight/laser/discussion → pushAction (badge appears after preceding text is revealed).
   */
  const addLectureMessage = useCallback(
    (sessionId: string, action: Action, actionIndex: number) => {
      const messageId = lectureMessageIds.current.get(sessionId);
      if (!messageId) return;

      // Skip if this action was already appended in a previous run
      const lastIndex = lectureLastActionIndexRef.current.get(sessionId) ?? -1;
      if (actionIndex <= lastIndex) return;
      lectureLastActionIndexRef.current.set(sessionId, actionIndex);

      // Update lastActionIndex in session
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, lastActionIndex: actionIndex, updatedAt: Date.now() } : s,
        ),
      );

      // Get or create buffer for this lecture session
      let buffer = buffersRef.current.get(sessionId);
      if (!buffer || buffer.disposed) {
        buffer = createBufferForSession(sessionId, 'lecture');
      }

      if (action.type === 'speech') {
        buffer.pushText(messageId, action.text, 'default-1');
        buffer.sealText(messageId);
      } else if (
        action.type === 'spotlight' ||
        action.type === 'laser' ||
        action.type === 'discussion'
      ) {
        const now = Date.now();
        buffer.pushAction({
          messageId,
          actionId: `${action.type}-${now}`,
          actionName: action.type,
          params:
            action.type === 'spotlight'
              ? {
                  elementId: action.elementId,
                  dimOpacity: (action as SpotlightAction).dimOpacity,
                }
              : action.type === 'laser'
                ? { elementId: action.elementId }
                : {
                    topic: (action as DiscussionAction).topic,
                    prompt: (action as DiscussionAction).prompt,
                  },
          agentId: 'default-1',
        });
      }
    },
    [createBufferForSession],
  );

  // Derive active session type for external consumers
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionType = activeSession?.type ?? null;

  const getLectureMessageId = useCallback((sessionId: string): string | null => {
    return lectureMessageIds.current.get(sessionId) ?? null;
  }, []);

  /** Pause the buffer for a session (lecture pause support). */
  const pauseBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.pause();
  }, []);

  /** Resume the buffer for a session. */
  const resumeBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.resume();
  }, []);

  /** Pause the active live (QA/Discussion) buffer and set sticky intent. */
  const pauseActiveLiveBuffer = useCallback(() => {
    const active = sessionsRef.current.find(
      (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
    );
    if (!active) return;
    livePausedRef.current = true;
    const buf = buffersRef.current.get(active.id);
    if (buf) buf.pause();
    log.info('[ChatArea] Buffer-paused discussion:', active.id);
  }, []);

  /** Resume the active live (QA/Discussion) buffer and clear sticky intent. */
  const resumeActiveLiveBuffer = useCallback(() => {
    const active = sessionsRef.current.find(
      (s) => (s.type === 'qa' || s.type === 'discussion') && s.status === 'active',
    );
    if (!active) return;
    livePausedRef.current = false;
    const buf = buffersRef.current.get(active.id);
    if (buf) buf.resume();
    log.info('[ChatArea] Buffer-resumed discussion:', active.id);
  }, []);

  return {
    sessions,
    activeSessionId,
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
    handleInterrupt,
    getLectureMessageId,
    pauseBuffer,
    resumeBuffer,
    pauseActiveLiveBuffer,
    resumeActiveLiveBuffer,
  };
}
