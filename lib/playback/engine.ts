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

import { speechForTts, stripInlineLatexForPlainTts } from '@openmaic/generation/browser';
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
import type { LegacySpeechAction } from '@/lib/types/action';
import { ActionEngine } from '@/lib/action/engine';
import {
  resolvePlaybackCursor,
  estimateSpeechDurationMs,
  DISCUSSION_TRIGGER_DELAY_MS,
} from '@/lib/choreography';
import {
  canJumpWithinReconstructablePrefix,
  getSpeechVisualCueStartIndex,
  isWhiteboardPlaybackAction,
} from '@/lib/playback/action-navigation';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { BrowserSpeechPlayer, type SpeechLineSettings } from '@/lib/audio/browser-speech-player';
import { createLogger } from '@/lib/logger';
import i18n from '@/lib/i18n/config';

const log = createLogger('PlaybackEngine');

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
  /** Browser-native speech (Web Speech API), used when there is no pre-generated audio. */
  private browserSpeech: BrowserSpeechPlayer;
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
  private speechTimerRemaining: number = 0; // remaining ms (set on pause)
  private playbackGeneration: number = 0;
  // Keep the cursor on speech for progress/persistence; defer its cues until playback starts.
  private pendingNavigationSpeechIndex: number | null = null;

  constructor(
    scenes: Scene[],
    actionEngine: ActionEngine,
    audioPlayer: AudioPlayer,
    callbacks: PlaybackEngineCallbacks = {},
    browserSpeech: BrowserSpeechPlayer = new BrowserSpeechPlayer(),
  ) {
    this.scenes = scenes;
    this.sceneId = scenes[0]?.id;
    this.actionEngine = actionEngine;
    this.audioPlayer = audioPlayer;
    this.callbacks = callbacks;
    this.browserSpeech = browserSpeech;
    this.browserSpeech.onError(({ code }) => log.warn('Browser TTS sentence error:', code));
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
    this.pendingNavigationSpeechIndex = null;
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
    this.pendingNavigationSpeechIndex = null;
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
    this.pendingNavigationSpeechIndex = null;
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
        try {
          await this.actionEngine.execute(action, { silent: true });
        } catch (error) {
          log.error(
            'Skipping failed action during whiteboard restoration:',
            action.id,
            action.type,
            error,
          );
        }
      }
    }

    if (!this.isCurrentGeneration(generation)) return false;
    this.actionEngine.clearEffects();
    this.sceneIndex = 0;
    this.actionIndex = actionIndex;
    this.pendingNavigationSpeechIndex = actionIndex;
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
        if (this.browserSpeech.hasActiveSpeech()) {
          // Cancels the current sentence; resume() speaks it again.
          this.browserSpeech.pause();
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
      this.callbacks.beforeSpeech?.();
      if (this.browserSpeech.isPaused()) {
        // Browser speech was paused by cancelling — speak the current sentence again
        this.browserSpeech.onEnded(this.speechEndHandler(this.playbackGeneration));
        this.browserSpeech.resume();
      } else if (this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext
        this.audioPlayer.onEnded(this.speechEndHandler(this.playbackGeneration));
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
    this.pendingNavigationSpeechIndex = null;
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode('idle');
    this.audioPlayer.stop();
    this.browserSpeech.stop();
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
    this.browserSpeech.stop();
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
    this.browserSpeech.stop();
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

  private fireVisualCue(action: Extract<Action, { type: 'spotlight' | 'laser' }>): void {
    this.actionEngine.execute(action);
    this.callbacks.onEffectFire?.({
      kind: action.type,
      targetId: action.elementId,
      ...(action.type === 'spotlight'
        ? { dimOpacity: action.dimOpacity }
        : { color: action.color }),
    } as Effect);
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

    const replayCues =
      this.sceneIndex === 0 && this.pendingNavigationSpeechIndex === this.actionIndex;
    this.pendingNavigationSpeechIndex = null;
    if (replayCues && action.type === 'speech') {
      const actions = this.scenes[0].actions ?? [];
      const targetIndex = this.actionIndex;
      for (let i = getSpeechVisualCueStartIndex(actions, targetIndex); i < targetIndex; i++) {
        if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;
        const cue = actions[i];
        if (cue.type === 'spotlight' || cue.type === 'laser') this.fireVisualCue(cue);
      }
      if (this.mode !== 'playing' || !this.isCurrentGeneration(generation)) return;
    }

    // Notify progress BEFORE advancing the cursor so the snapshot points at
    // the current action.  On restore the same action will be replayed — this
    // is the desired behaviour for speech (user may have only heard half).
    this.callbacks.onProgress?.(this.getSnapshot());

    this.actionIndex++;

    switch (action.type) {
      case 'speech': {
        const speechAction = action as SpeechAction;
        const spoken = speechForTts(speechAction);
        this.callbacks.beforeSpeech?.();
        this.callbacks.onSpeechStart?.(speechAction.text);

        // onEnded → processNext; if paused, resume() will call processNext
        this.audioPlayer.onEnded(this.speechEndHandler(generation));

        // Estimated reading time when no pre-generated audio (TTS disabled).
        // The estimate (CJK vs word-based pace, 2s floor, speed-adjusted) lives
        // in @/lib/choreography so the video exporter dwells identically.
        // Cancelled on pause; resume() calls processNext directly.
        const scheduleReadingTimer = () => {
          if (!this.isCurrentGeneration(generation)) return;
          const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
          const readingMs = estimateSpeechDurationMs(spoken, { speed });
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
        const hasText = !!spoken;

        this.audioPlayer
          // The legacy URL of an unconverted pair rides along as the
          // fallback of last resort; converted documents carry no audioUrl.
          .play(speechAction.audioId || '', (speechAction as LegacySpeechAction).audioUrl)
          .then((audioStarted) => {
            if (!this.isCurrentGeneration(generation)) return;
            if (!audioStarted) {
              // No pre-generated audio — try browser-native TTS only when it is
              // the selected provider AND actually enabled (opt-in, #665).
              if (
                hasText &&
                ttsSelection()?.providerId === 'browser-native-tts' &&
                this.browserSpeech.isSupported()
              ) {
                this.playBrowserSpeech(
                  stripInlineLatexForPlainTts(spoken),
                  generation,
                  scheduleReadingTimer,
                );
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
        this.fireVisualCue(action);
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
        // A rejected stored action must not strand playback before the next action.
        try {
          await this.actionEngine.execute(action);
        } catch (error) {
          log.error('Skipping failed playback action:', action.id, action.type, error);
        }
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

  /** End of a speech line: advance unless playback moved on in the meantime. */
  private speechEndHandler(generation: number): () => void {
    return () => {
      if (!this.isCurrentGeneration(generation)) return;
      this.callbacks.onSpeechEnd?.();
      if (this.mode === 'playing') this.processNext(generation);
    };
  }

  /**
   * Speak a line with the browser's own speech synthesis, sentence by sentence
   * (see BrowserSpeechPlayer). Falls back to the reading timer when the line
   * cannot be spoken.
   */
  private playBrowserSpeech(text: string, generation: number, fallback: () => void): void {
    this.browserSpeech.onEnded(this.speechEndHandler(generation));
    void this.browserSpeech
      .play(text, () => this.browserSpeechSettings())
      .then((started) => {
        if (!started && this.isCurrentGeneration(generation)) fallback();
      });
  }

  /** Read before each sentence, so setting changes apply from the next one. */
  private browserSpeechSettings(): SpeechLineSettings {
    const settings = useSettingsStore.getState();
    const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
    return {
      // The user's voice when it was picked for browser speech.
      voice: ttsSelection()?.voice,
      locale: i18n.language,
      rate: (settings.ttsSpeed ?? 1) * speed,
      volume: settings.ttsVolume ?? 1,
      muted: settings.ttsMuted,
    };
  }
}
