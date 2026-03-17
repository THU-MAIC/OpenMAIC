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
import { useCanvasStore } from '@/lib/store/canvas';
import { createLogger } from '@/lib/logger';

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
    this.setMode('playing');
    this.processNext();
  }

  /** idle → playing (continue from current position, e.g. after discussion end) */
  continuePlayback(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot continue: not idle, current mode:', this.mode);
      return;
    }
    this.setMode('playing');
    this.processNext();
  }

  /** playing → paused | live → paused (abort SSE, truncate, topic pending) */
  pause(): void {
    if (this.mode === 'playing') {
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
      if (!this.currentTrigger && this.audioPlayer.isPlaying()) {
        this.audioPlayer.pause();
      }
    } else if (this.mode === 'live') {
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
      if (this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext
        this.audioPlayer.resume();
      } else if (this.speechTimerRemaining > 0) {
        // Reading timer was paused — reschedule with remaining time
        this.speechTimerStart = Date.now();
        this.speechTimer = setTimeout(() => {
          this.speechTimer = null;
          this.speechTimerRemaining = 0;
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') this.processNext();
        }, this.speechTimerRemaining);
      } else {
        // TTS finished while paused, continue to next event
        this.processNext();
      }
    }
  }

  /** → idle */
  stop(): void {
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode('idle');
    this.audioPlayer.stop();
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

  /** User clicks "Join" on ProactiveCard → save cursor → live */
  confirmDiscussion(): void {
    if (!this.currentTrigger) {
      log.warn('confirmDiscussion called but no trigger');
      return;
    }

    // Mark consumed so it won't re-trigger on replay
    this.consumedDiscussions.add(this.currentTrigger.id);

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
      this.consumedDiscussions.add(this.currentTrigger.id);
      this.currentTrigger = null;
    }
    this.callbacks.onProactiveHide?.();

    if (this.mode === 'playing') {
      this.processNext();
    }
  }

  /** End discussion → restore lecture → idle (user clicks "start" to continue) */
  handleEndDiscussion(): void {
    this.actionEngine.clearEffects();
    this.currentTopicState = 'closed';

    // Close whiteboard if it was open during the discussion
    useCanvasStore.getState().setWhiteboardOpen(false);

    this.callbacks.onDiscussionEnd?.();

    // Restore lecture state
    if (this.savedSceneIndex !== null && this.savedActionIndex !== null) {
      this.sceneIndex = this.savedSceneIndex;
      this.actionIndex = this.savedActionIndex;
      this.savedSceneIndex = null;
      this.savedActionIndex = null;
    }

    this.setMode('idle');
  }

  /** User sends a message during playback → interrupt → live mode */
  handleUserInterrupt(text: string): void {
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

  private setMode(mode: EngineMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  /**
   * Get the current action, or null if playback is complete.
   * Advances sceneIndex automatically when a scene's actions are exhausted.
   */
  private getCurrentAction(): { action: Action; sceneId: string } | null {
    while (this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      const actions = scene.actions || [];

      if (this.actionIndex < actions.length) {
        return { action: actions[this.actionIndex], sceneId: scene.id };
      }

      // Move to next scene
      this.sceneIndex++;
      this.actionIndex = 0;
    }
    return null;
  }

  /**
   * Core processing loop: consume the next action.
   */
  private async processNext(): Promise<void> {
    if (this.mode !== 'playing') return;

    // Check for scene boundary (fire scene change callback at start of each new scene)
    if (this.actionIndex === 0 && this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      this.actionEngine.clearEffects();
      this.callbacks.onSceneChange?.(scene.id);
      this.callbacks.onSpeakerChange?.('teacher');
    }

    const current = this.getCurrentAction();
    if (!current) {
      // All scenes complete
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
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext();
          }
        });

        // Estimated reading time when no pre-generated audio (TTS disabled).
        // CJK text: ~150ms/char (one char ≈ one word).
        // Non-CJK text: ~240ms/word (≈250 WPM).
        // Min 2s. Cancelled on pause; resume() calls processNext directly.
        const scheduleReadingTimer = () => {
          const text = speechAction.text;
          const cjkCount = (
            text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
          ).length;
          const isCJK = cjkCount > text.length * 0.3;
          const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
          const rawMs = isCJK
            ? Math.max(2000, text.length * 150)
            : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
          const readingMs = rawMs / speed;
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = readingMs;
          this.speechTimer = setTimeout(() => {
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.callbacks.onSpeechEnd?.();
            if (this.mode === 'playing') this.processNext();
          }, readingMs);
        };

        this.audioPlayer
          .play(speechAction.audioId || '')
          .then((audioStarted) => {
            if (!audioStarted) scheduleReadingTimer();
          })
          .catch((err) => {
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
        // Don't block — continue immediately
        this.processNext();
        break;
      }

      case 'discussion': {
        const discussionAction = action as DiscussionAction;
        // Check if already consumed
        if (this.consumedDiscussions.has(discussionAction.id)) {
          this.processNext();
          return;
        }
        // Skip if the discussion's agent isn't in the user's selected list
        if (
          discussionAction.agentId &&
          this.callbacks.isAgentSelected &&
          !this.callbacks.isAgentSelected(discussionAction.agentId)
        ) {
          this.consumedDiscussions.add(discussionAction.id);
          this.processNext();
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
          this.triggerDelayTimer = null;
          if (this.mode !== 'playing') return; // Cancelled if user paused/stopped
          this.currentTrigger = trigger;
          this.callbacks.onProactiveShow?.(trigger);
          // Engine pauses here — user calls confirmDiscussion() or skipDiscussion()
        }, 3000);
        break;
      }

      case 'play_video':
      case 'wb_open':
      case 'wb_draw_text':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_clear':
      case 'wb_delete':
      case 'wb_close': {
        // Synchronous whiteboard actions — await completion, then continue
        await this.actionEngine.execute(action);
        if (this.mode === 'playing') {
          this.processNext();
        }
        break;
      }

      default:
        // Unknown action, skip
        this.processNext();
        break;
    }
  }
}
