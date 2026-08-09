/**
 * Playback Engine - Unified state machine for lecture playback and live discussion
 *
 * Consumes Scene.actions[] directly via ActionEngine.
 * No intermediate compile step — actions are executed as-is.
 *
 * State machine:
 *
 *                  start()                  pause()
 *   idle ──────────────────→ playing ──────────────→ paused
 *     ▲                         ▲                       │
 *     │                         │  resume()             │
 *     │                         └───────────────────────┘
 *     │
 *     │  handleEndDiscussion()
 *     │                         confirmDiscussion()
 *     │                         / handleUserInterrupt()
 *     │                              │
 *     │                              ▼         pause()
 *     └──────────────────────── live ──────────────→ paused
 *                                 ▲                    │
 *                                 │ resume / user msg  │
 *                                 └────────────────────┘
 */

import type { Scene } from '@/lib/types/stage';
import type { Action, SpeechAction, DiscussionAction } from '@/lib/types/action';
import type {
  EngineMode,
  TopicState,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  TriggerEvent,
  Effect,
} from './types';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import { ActionEngine } from '@/lib/action/engine';
import {
  resolvePlaybackCursor,
  estimateSpeechDurationMs,
  DISCUSSION_TRIGGER_DELAY_MS,
} from '@/lib/choreography';
import {
  canJumpWithinReconstructablePrefix,
  isWhiteboardPlaybackAction,
} from '@/lib/playback/action-navigation';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { createLogger } from '@/lib/logger';

const log = createLogger('PlaybackEngine');

/**
 * If more than 30% of characters are CJK, treat the text as Chinese.
 * Intentionally low: mixed Chinese text often contains punctuation,
 * numbers, and short Latin fragments (e.g. "AI课堂").
 */
const CJK_LANG_THRESHOLD = 0.3;

export class PlaybackEngine {
  private scenes: Scene[] = [];
  private sceneIndex: number = 0;
  private actionIndex: number = 0;
  private mode: EngineMode = 'idle';
  private consumedDiscussions: Set<string> = new Set();

  // Discussion state save
  private savedSceneIndex: number | null = null;
  private savedActionIndex: number | null = null;

  // Discussion topic state
  private currentTopicState: TopicState | null = null;

  // Dependencies
  private audioPlayer: AudioPlayer;
  private actionEngine: ActionEngine;
  private callbacks: PlaybackEngineCallbacks;

  // Scene identity (for snapshot validation)
  private sceneId: string | undefined;

  // Internal state
  private currentTrigger: TriggerEvent | null = null;
  private triggerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  // Reading-time timer for speech actions without pre-generated audio (TTS disabled)
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private speechTimerStart: number = 0; // Date.now() when timer was scheduled
  // Browser-native TTS state (Web Speech API)
  private browserTTSActive: boolean = false;
  private browserTTSChunks: string[] = []; // sentence-level chunks for sequential playback
  private browserTTSChunkIndex: number = 0; // current chunk being spoken
  private browserTTSPausedChunks: string[] = []; // remaining chunks saved on pause (for cancel+re-speak)
  private speechTimerRemaining: number = 0; // remaining ms (set on pause)
  private playbackGeneration: number = 0;

  constructor(
    scenes: Scene[],
    actionEngine: ActionEngine,
    audioPlayer: AudioPlayer,
    callbacks: PlaybackEngineCallbacks = {},
  ) {
    this.scenes = scenes;
    this.sceneId = scenes[0]?.id;
    this.actionEngine = actionEngine;
    this.audioPlayer = audioPlayer;
    this.callbacks = callbacks;
  }

  // ==================== Public API ====================

  /** Get the current engine mode */
  getMode(): EngineMode {
    return this.mode;
  }

  /**
   * Whether the current session interrupted an active lecture.
   * True while a saved lecture position exists (set by handleUserInterrupt,
   * cleared by restoreSavedLectureState). Must be read BEFORE cleanup runs.
   */
  hasLectureInterruption(): boolean {
    return this.savedSceneIndex !== null;
  }

  /** Scene id at the current playback position (post-restore engine state) */
  getCurrentSceneId(): string | null {
    return this.scenes[this.sceneIndex]?.id ?? null;
  }

  /** Export a serializable playback snapshot */
  getSnapshot(): PlaybackSnapshot {
    return {
      sceneIndex: this.sceneIndex,
      actionIndex: this.actionIndex,
      consumedDiscussions: [...this.consumedDiscussions],
      sceneId: this.sceneId,
    };
  }

  /** Restore playback position from a snapshot */
  restoreFromSnapshot(snapshot: PlaybackSnapshot): void {
    this.sceneIndex = snapshot.sceneIndex;
    this.actionIndex = snapshot.actionIndex;
    this.consumedDiscussions = new Set(snapshot.consumedDiscussions);
  }

  /** idle → playing (from beginning) */
  start(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot start: not idle, current mode:', this.mode);
      return;
    }

    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.invalidatePlaybackGeneration();
    this.setMode('playing');
    this.processNext();
  }

  /** idle → playing (continue from current position, e.g. after discussion end) */
  continuePlayback(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot continue: not idle, current mode:', this.mode);
      return;
    }
    this.invalidatePlaybackGeneration();
    this.setMode('playing');
    this.processNext();
  }

  canJumpToAction(actionIndex: number): boolean {
    const actions = this.scenes[0]?.actions ?? [];
    return (
      this.mode !== 'live' &&
      canJumpWithinReconstructablePrefix(actions, this.actionIndex, actionIndex)
    );
  }

  async jumpToAction(actionIndex: number, options: { autoplay?: boolean } = {}): Promise<boolean> {
    const actions = this.scenes[0]?.actions ?? [];
    if (!this.canJumpToAction(actionIndex)) return false;

    const autoplay = options.autoplay ?? this.mode === 'playing';
    const generation = this.invalidatePlaybackGeneration();
    this.cancelActivePlaybackWork();
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.currentTopicState = null;
    this.currentTrigger = null;
    this.actionEngine.resetPlaybackVisualState();

    for (let i = 0; i < actionIndex; i++) {
      if (!this.isCurrentGeneration(generation)) return false;
      const action = actions[i];
      if (isWhiteboardPlaybackAction(action)) {
        await this.actionEngine.execute(action, { silent: true });
      }
    }

    if (!this.isCurrentGeneration(generation)) return false;
    this.actionEngine.clearEffects();
    this.sceneIndex = 0;
    this.actionIndex = actionIndex;
    this.callbacks.onProgress?.(this.getSnapshot());

    if (autoplay) {
      this.setMode('playing');
      this.processNext(generation);
    } else if (this.mode === 'playing' || this.mode === 'live') {
      this.setMode('paused');
    }

    return true;
  }

  /** playing → paused | live → paused (abort SSE, truncate, topic pending) */
  pause(): void {
    if (this.mode === 'playing') {
      this.invalidatePlaybackGeneration();
      // Cancel pending timers
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
      if (this.speechTimer) {
        // Save remaining time so resume() can reschedule
        this.speechTimerRemaining = Math.max(
          0,
          this.speechTimerRemaining - (Date.now() - this.speechTimerStart),
        );
        clearTimeout(this.speechTimer);
        this.speechTimer = null;
      }
      this.setMode('paused');
      // Freeze TTS — but skip if waiting on ProactiveCard (no active speech)
      if (!this.currentTrigger) {
        if (this.browserTTSActive) {
          // Cancel+re-speak pattern: save remaining chunks for resume.
          // speechSynthesis.pause()/resume() is broken on Firefox, so we
          // cancel now and re-speak from current chunk onward on resume.
          this.browserTTSPausedChunks = this.browserTTSChunks.slice(this.browserTTSChunkIndex);
          window.speechSynthesis?.cancel();
          // Note: cancel fires onerror('canceled'), which we ignore (see playBrowserTTSChunk)
        } else if (this.audioPlayer.isPlaying()) {
          this.audioPlayer.pause();
        }
      }
    } else if (this.mode === 'live') {
      this.invalidatePlaybackGeneration();
      this.setMode('paused');
      this.currentTopicState = 'pending';
      // Caller is responsible for aborting SSE
    } else {
      log.warn('Cannot pause: mode is', this.mode);
    }
  }

  /** paused → playing (TTS resume) | paused (in discussion) → live */
  resume(): void {
    if (this.mode !== 'paused') {
      log.warn('Cannot resume: not paused, mode is', this.mode);
      return;
    }

    if (this.currentTopicState === 'pending') {
      // Resume discussion → live
      this.currentTopicState = 'active';
      this.setMode('live');
    } else if (this.currentTrigger) {
      // Waiting on ProactiveCard — just resume mode, don't touch audio
      this.setMode('playing');
    } else {
      // Resume lecture
      this.setMode('playing');
      if (this.browserTTSPausedChunks.length > 0) {
        // Browser TTS was paused via cancel — re-speak remaining chunks
        this.browserTTSActive = true;
        this.browserTTSChunks = this.browserTTSPausedChunks;
        this.browserTTSChunkIndex = 0;
        this.browserTTSPausedChunks = [];
        this.playBrowserTTSChunk(this.playbackGeneration);
      } else if (this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext
        const generation = this.playbackGeneration;
        this.audioPlayer.onEnded(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext(generation);
          }
        });
        this.audioPlayer.resume();
      } else if (this.speechTimerRemaining > 0) {
        // Reading timer was paused — reschedule with remaining time
        const generation = this.playbackGeneration;
        this.speechTimerStart = Date.now();
        this.speechTimer = setTimeout(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.speechTimer = null;
          this.speechTimerRemaining = 0;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') this.processNext(generation);
        }, this.speechTimerRemaining);
      } else {
        // TTS finished while paused, continue to next event
        this.processNext();
      }
    }
  }

  /** → idle */
  stop(): void {
    this.invalidatePlaybackGeneration();
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode('idle');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.currentTopicState = null;
    this.currentTrigger = null;
  }

  /**
   * Consume a discussion and immediately publish a progress snapshot.
   * `onProgress` otherwise fires before a discussion action executes (the id
   * is not yet consumed) and a discussion is the scene's last action, so
   * without this emit the consumption fact would never reach persistence.
   */
  private markDiscussionConsumed(id: string): void {
    this.consumedDiscussions.add(id);
    this.callbacks.onProgress?.(this.getSnapshot());
  }

  /** User clicks "Join" on ProactiveCard → save cursor → live */
  confirmDiscussion(): void {
    if (!this.currentTrigger) {
      log.warn('confirmDiscussion called but no trigger');
      return;
    }
    this.invalidatePlaybackGeneration();

    // Mark consumed so it won't re-trigger on replay
    this.markDiscussionConsumed(this.currentTrigger.id);

    // Save lecture state — keep actionIndex as-is (past the discussion).
    // Discussions are placed after all speech actions, so the preceding
    // speech was already fully played; no need to replay it.
    this.savedSceneIndex = this.sceneIndex;
    this.savedActionIndex = this.actionIndex;

    // Enter live mode
    this.currentTopicState = 'active';
    this.setMode('live');

    // Notify callbacks
    this.callbacks.onProactiveHide?.();
    this.callbacks.onDiscussionConfirmed?.(
      this.currentTrigger.question,
      this.currentTrigger.prompt,
      this.currentTrigger.agentId,
    );
    this.currentTrigger = null;
  }

  /** User clicks "Skip" on ProactiveCard → consumed → processNext */
  skipDiscussion(): void {
    if (this.currentTrigger) {
      this.markDiscussionConsumed(this.currentTrigger.id);
      this.currentTrigger = null;
    }
    const generation = this.invalidatePlaybackGeneration();
    this.callbacks.onProactiveHide?.();

    if (this.mode === 'playing') {
      this.processNext(generation);
    }
  }

  /** End discussion → restore lecture → idle (user clicks "start" to continue) */
  handleEndDiscussion(): void {
    this.invalidatePlaybackGeneration();
    this.actionEngine.clearEffects();
    this.currentTopicState = 'closed';

    // Close whiteboard if it was open during the discussion
    useCanvasStore.getState().setWhiteboardOpen(false);

    // Restore the interrupted lecture cursor before notifying consumers. The
    // callback may inspect isExhausted() to decide whether playback completed.
    this.restoreSavedLectureState();

    this.callbacks.onDiscussionEnd?.();

    this.setMode('idle');
  }

  /**
   * Exit live discussion mode after a request failure without treating it as a
   * normal discussion end. The chat session stays retryable; this only restores
   * the playback engine to a coherent non-live state.
   */
  handleDiscussionError(): void {
    const hasSavedLectureState = this.savedSceneIndex !== null && this.savedActionIndex !== null;
    const isLiveTopic =
      this.mode === 'live' || (this.mode === 'paused' && this.currentTopicState === 'pending');

    if (!isLiveTopic && !hasSavedLectureState) {
      return;
    }

    this.invalidatePlaybackGeneration();
    this.actionEngine.clearEffects();
    useCanvasStore.getState().setWhiteboardOpen(false);
    this.currentTopicState = 'closed';
    this.currentTrigger = null;
    this.restoreSavedLectureState();
    this.setMode('idle');
  }

  /** User sends a message during playback → interrupt → live mode */
  handleUserInterrupt(text: string): void {
    this.invalidatePlaybackGeneration();
    if (this.mode === 'playing' || this.mode === 'paused') {
      // Save lecture state BEFORE stopping audio — actionIndex was already
      // incremented by processNext, so subtract 1 to replay the interrupted
      // sentence when resuming.  Guard against overwriting a previously saved
      // position (e.g. live → paused → new message).
      if (this.savedSceneIndex === null) {
        this.savedSceneIndex = this.sceneIndex;
        this.savedActionIndex = Math.max(0, this.actionIndex - 1);
      }

      // Cancel pending trigger delay
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
    }

    // Set mode BEFORE stopping audio — speechSynthesis.cancel() may fire the
    // onend callback synchronously, and the processNext guard checks
    // `this.mode === 'playing'`.  Setting mode first prevents a spurious
    // processNext that would advance actionIndex past the interrupted speech.
    this.currentTopicState = 'active';
    this.setMode('live');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.callbacks.onUserInterrupt?.(text);
  }

  /** Whether all remaining actions have been consumed (no speech left to play) */
  isExhausted(): boolean {
    let si = this.sceneIndex;
    let ai = this.actionIndex;
    while (si < this.scenes.length) {
      const actions = this.scenes[si].actions || [];
      while (ai < actions.length) {
        const action = actions[ai];
        // Consumed discussions don't count as remaining work
        if (action.type === 'discussion' && this.consumedDiscussions.has(action.id)) {
          ai++;
          continue;
        }
        return false;
      }
      si++;
      ai = 0;
    }
    return true;
  }

  // ==================== Private ====================

  private invalidatePlaybackGeneration(): number {
    this.playbackGeneration += 1;
    return this.playbackGeneration;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.playbackGeneration;
  }

  private cancelActivePlaybackWork(): void {
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    useCanvasStore.getState().pauseVideo();

    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.callbacks.onProactiveHide?.();
  }

  private setMode(mode: EngineMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  private restoreSavedLectureState(): void {
    if (this.savedSceneIndex !== null && this.savedActionIndex !== null) {
      this.sceneIndex = this.savedSceneIndex;
      this.actionIndex = this.savedActionIndex;
    }
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
  }

  /**
   * Get the current action, or null if playback is complete.
   * Advances sceneIndex automatically when a scene's actions are exhausted.
   * A scene with no actions yields one synthetic dwell beat (so the slide still
   * shows) instead of being skipped — see {@link resolvePlaybackCursor}.
   */
  private getCurrentAction(): { action: Action; sceneId: string } | null {
    const res = resolvePlaybackCursor(this.scenes, this.sceneIndex, this.actionIndex);
    if (!res) return null;
    this.sceneIndex = res.sceneIndex;
    this.actionIndex = res.actionIndex;
    return { action: res.action, sceneId: res.sceneId };
  }

  /**
   * Core processing loop: consume the next action.
   */
  private async processNext(generation: number = this.playbackGeneration): Promise<void> {
    if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;

    // Check for scene boundary (fire scene change callback at start of each new scene)
    if (this.actionIndex === 0 && this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      this.actionEngine.clearEffects();
      this.callbacks.onSceneChange?.(scene.id);
      this.callbacks.onSpeakerChange?.('teacher');
    }

    const current = this.getCurrentAction();
    if (!current) {
      if (!this.isCurrentGeneration(generation)) return;
      // All scenes complete
      this.invalidatePlaybackGeneration();
      this.actionEngine.clearEffects();
      this.setMode('idle');
      this.callbacks.onComplete?.();
      return;
    }

    const { action } = current;

    // Notify progress BEFORE advancing the cursor so the snapshot points at
    // the current action.  On restore the same action will be replayed — this
    // is the desired behaviour for speech (user may have only heard half).
    this.callbacks.onProgress?.(this.getSnapshot());

    this.actionIndex++;

    switch (action.type) {
      case 'speech': {
        const speechAction = action as SpeechAction;
        this.callbacks.onSpeechStart?.(speechAction.text);

        // onEnded → processNext; if paused, resume() will call processNext
        this.audioPlayer.onEnded(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext(generation);
          }
        });

        // Estimated reading time when no pre-generated audio (TTS disabled).
        // The estimate (CJK vs word-based pace, 2s floor, speed-adjusted) lives
        // in @/lib/choreography so the video exporter dwells identically.
        // Cancelled on pause; resume() calls processNext directly.
        const scheduleReadingTimer = () => {
          if (!this.isCurrentGeneration(generation)) return;
          const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
          const readingMs = estimateSpeechDurationMs(speechAction.text, { speed });
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = readingMs;
          this.speechTimer = setTimeout(() => {
            if (!this.isCurrentGeneration(generation)) return;
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.callbacks.onSpeechEnd?.();
            if (this.mode === 'playing') this.processNext(generation);
          }, readingMs);
        };

        // A speech line with no text (e.g. a freshly inserted blank slide's
        // seeded clip, or one the user cleared) has nothing to synthesize —
        // route it straight to the reading timer for a short dwell. Speaking an
        // empty SpeechSynthesisUtterance doesn't reliably fire onend in Chromium,
        // which would hang playback on that slide.
        const hasText = !!speechAction.text.trim();

        this.audioPlayer
          .play(speechAction.audioId || '', speechAction.audioUrl)
          .then((audioStarted) => {
            if (!this.isCurrentGeneration(generation)) return;
            if (!audioStarted) {
              // No pre-generated audio — try browser-native TTS only when it is
              // the selected provider AND actually enabled (opt-in, #665).
              const settings = useSettingsStore.getState();
              if (
                hasText &&
                settings.ttsEnabled &&
                settings.ttsProviderId === 'browser-native-tts' &&
                isTTSProviderEnabled(
                  'browser-native-tts',
                  settings.ttsProvidersConfig?.['browser-native-tts'],
                ) &&
                typeof window !== 'undefined' &&
                window.speechSynthesis
              ) {
                this.playBrowserTTS(speechAction, generation);
              } else {
                scheduleReadingTimer();
              }
            }
          })
          .catch((err) => {
            if (!this.isCurrentGeneration(generation)) return;
            log.error('TTS error:', err);
            scheduleReadingTimer();
          });
        break;
      }

      case 'spotlight':
      case 'laser': {
        // Fire-and-forget visual effects via ActionEngine
        this.actionEngine.execute(action);
        this.callbacks.onEffectFire?.({
          kind: action.type,
          targetId: action.elementId,
          ...(action.type === 'spotlight'
            ? { dimOpacity: action.dimOpacity }
            : { color: action.color }),
        } as Effect);
        // Don't block — continue immediately (use queueMicrotask to avoid
        // stack overflow from deep synchronous recursion when many consecutive
        // spotlight/laser actions appear in sequence)
        queueMicrotask(() => {
          if (this.isCurrentGeneration(generation)) {
            this.processNext(generation);
          }
        });
        break;
      }

      case 'discussion': {
        const discussionAction = action as DiscussionAction;
        // Check if already consumed
        if (this.consumedDiscussions.has(discussionAction.id)) {
          this.processNext(generation);
          return;
        }
        // Skip if the discussion's agent isn't in the user's selected list
        if (
          discussionAction.agentId &&
          this.callbacks.isAgentSelected &&
          !this.callbacks.isAgentSelected(discussionAction.agentId)
        ) {
          this.markDiscussionConsumed(discussionAction.id);
          this.processNext(generation);
          return;
        }

        // 3s delay before showing ProactiveCard (allows previous speech to finish naturally)
        const trigger: TriggerEvent = {
          id: discussionAction.id,
          question: discussionAction.topic,
          prompt: discussionAction.prompt,
          agentId: discussionAction.agentId,
        };

        this.triggerDelayTimer = setTimeout(() => {
          if (!this.isCurrentGeneration(generation)) return;
          this.triggerDelayTimer = null;
          if (this.mode !== 'playing') return; // Cancelled if user paused/stopped
          this.currentTrigger = trigger;
          this.callbacks.onProactiveShow?.(trigger);
          // Engine pauses here — user calls confirmDiscussion() or skipDiscussion()
        }, DISCUSSION_TRIGGER_DELAY_MS);
        break;
      }

      case 'play_video':
      case 'wb_open':
      case 'wb_draw_text':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_draw_line':
      case 'wb_draw_code':
      case 'wb_edit_code':
      case 'wb_clear':
      case 'wb_delete':
      case 'wb_close':
      case 'widget_highlight':
      case 'widget_setState':
      case 'widget_annotation':
      case 'widget_reveal': {
        // Synchronous actions — await completion, then continue
        await this.actionEngine.execute(action);
        if (!this.isCurrentGeneration(generation)) return;
        if (this.mode === 'playing') {
          this.processNext(generation);
        }
        break;
      }

      default:
        // Unknown action, skip
        this.processNext(generation);
        break;
    }
  }

  // ==================== Browser Native TTS ====================

  /**
   * Split text into sentence-level chunks for sequential playback.
   * Chrome has a bug where utterances >~15s are silently cut off and onend
   * never fires, causing the engine to hang. Chunking avoids this.
   */
  private splitIntoChunks(text: string): string[] {
    // Split on sentence-ending punctuation (Latin + CJK) and newlines
    const chunks = text
      .split(/(?<=[.!?。！？\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (chunks.length > 0) return chunks;
    // Blank/whitespace text → no chunks (so playBrowserTTSChunk finishes cleanly
    // instead of speaking an empty utterance that never fires onend). Otherwise
    // the text had no sentence punctuation — speak it as one chunk.
    return text.trim() ? [text] : [];
  }

  /**
   * Play text using the Web Speech API (browser-native TTS).
   * Splits text into sentence-level chunks to avoid Chrome's ~15s cutoff.
   * Uses cancel+re-speak for pause/resume (Firefox compatibility).
   */
  private playBrowserTTS(speechAction: SpeechAction, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.browserTTSChunks = this.splitIntoChunks(speechAction.text);
    this.browserTTSChunkIndex = 0;
    this.browserTTSPausedChunks = [];
    this.browserTTSActive = true;
    this.playBrowserTTSChunk(generation);
  }

  /** Speak the current chunk; on completion, advance to next or finish. */
  private async playBrowserTTSChunk(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    if (this.browserTTSChunkIndex >= this.browserTTSChunks.length) {
      // All chunks done
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.callbacks.onSpeechEnd?.();
      if (this.mode === 'playing') this.processNext(generation);
      return;
    }

    const settings = useSettingsStore.getState();
    const chunkText = this.browserTTSChunks[this.browserTTSChunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunkText);

    // Apply settings
    const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
    utterance.rate = (settings.ttsSpeed ?? 1) * speed;
    utterance.volume = settings.ttsMuted ? 0 : (settings.ttsVolume ?? 1);

    // Ensure voices are loaded (Chrome loads them asynchronously)
    const voices = await this.ensureVoicesLoaded();
    if (!this.isCurrentGeneration(generation)) return;

    // Set voice: try user's configured voice, fall back to auto-detect language
    let voiceFound = false;
    if (settings.ttsVoice && settings.ttsVoice !== 'default') {
      const voice = voices.find((v) => v.voiceURI === settings.ttsVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
        voiceFound = true;
      }
    }
    if (!voiceFound) {
      // No usable voice configured — detect text language so the browser
      // auto-selects an appropriate voice.
      const cjkRatio =
        chunkText.length > 0
          ? (chunkText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / chunkText.length
          : 0;
      utterance.lang = cjkRatio > CJK_LANG_THRESHOLD ? 'zh-CN' : 'en-US';
    }

    utterance.onend = () => {
      if (!this.isCurrentGeneration(generation)) return;
      this.browserTTSChunkIndex++;
      if (this.mode === 'playing') {
        this.playBrowserTTSChunk(generation); // next chunk
      }
    };

    utterance.onerror = (event) => {
      if (!this.isCurrentGeneration(generation)) return;
      // 'canceled' is expected when stop/pause is called — not a real error
      if (event.error !== 'canceled') {
        log.warn('Browser TTS chunk error:', event.error);
        // Skip failed chunk, try next
        this.browserTTSChunkIndex++;
        if (this.mode === 'playing') {
          this.playBrowserTTSChunk(generation);
        }
      }
      // On 'canceled': do nothing — pause handler already saved state
    };

    // Chrome bug workaround: cancel() before speak() to clear stale synthesis
    // state that can produce garbled/broken audio output.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Wait for speechSynthesis voices to load (Chrome loads them asynchronously).
   * Caches result so subsequent calls return immediately.
   */
  private cachedVoices: SpeechSynthesisVoice[] | null = null;
  private async ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
    if (this.cachedVoices && this.cachedVoices.length > 0) {
      return this.cachedVoices;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.cachedVoices = voices;
      return voices;
    }

    // Chrome: voices load asynchronously — wait for the voiceschanged event
    await new Promise<void>((resolve) => {
      const onVoicesChanged = () => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      };
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
      // Timeout after 2s to avoid hanging
      setTimeout(() => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      }, 2000);
    });

    voices = window.speechSynthesis.getVoices();
    this.cachedVoices = voices;
    return voices;
  }

  /** Cancel any active browser-native TTS */
  private cancelBrowserTTS(): void {
    if (this.browserTTSActive) {
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.browserTTSChunkIndex = 0;
      this.browserTTSPausedChunks = [];
      window.speechSynthesis?.cancel();
    }
  }
}
