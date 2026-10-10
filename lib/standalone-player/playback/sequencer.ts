/**
 * Scene sequencer of the standalone player: replays one scene's actions the
 * way the classroom's playback engine does (`lib/playback/engine.ts`), without
 * its stores, IndexedDB audio player or AI features.
 *
 * - speech waits for its narration to end, or, without audio, for the same
 *   reading-time estimate the classroom uses; its text is the caption while
 *   it plays;
 * - spotlight / laser fire and continue at once, so they overlap the speech
 *   that follows; any effect clears 5 s after the most recent one fired, and
 *   all effects clear when the scene changes;
 * - play_video plays the slide video in place and waits for it to end;
 * - discussion shows a card with its topic for a few seconds (the live AI
 *   discussion cannot run offline) and then continues;
 * - widget actions are posted to the interactive scene's iframe, with the
 *   classroom's short settle delay;
 * - whiteboard actions (only live chat produces them) and unknown types are
 *   skipped.
 *
 * DOM work (audio/video elements, the iframe) sits behind {@link SequencerPorts}.
 */
import type { SlideEffects } from '@openmaic/renderer';
import type { ManifestAction } from '@/lib/export/classroom-zip-types';
import type { StandaloneAction } from '@/lib/export/standalone-html/prepare-manifest';
import {
  DISCUSSION_AUTO_SKIP_MS,
  EFFECT_AUTO_CLEAR_MS,
  WIDGET_MS,
  estimateSpeechDurationMs,
} from '@/lib/choreography/timing';
import { PauseGate, pausableDelay, type StepControl } from './pause-gate';

/** Default laser options of the classroom's canvas store. */
const LASER_COLOR = '#ff0000';
const LASER_DURATION_MS = 3000;
/** Default spotlight dimness the classroom's action engine applies. */
const SPOTLIGHT_DIMNESS = 0.5;

const WIDGET_MESSAGE_TYPES: Record<string, string> = {
  widget_highlight: 'HIGHLIGHT_ELEMENT',
  widget_setState: 'SET_WIDGET_STATE',
  widget_annotation: 'ANNOTATE_ELEMENT',
  widget_reveal: 'REVEAL_ELEMENT',
};

export interface SequencerView {
  /** Text of the speech playing now. */
  caption: string | null;
  effects: SlideEffects;
  /** Topic of the discussion card on screen. */
  discussion: string | null;
}

export interface SequencerPorts {
  /**
   * Play narration audio by its media key. Resolves `true` once it played to
   * its end (or the step was cancelled), `false` when it could not start, in
   * which case the reading timer paces the speech instead.
   */
  playAudio(ref: string, control: StepControl): Promise<boolean>;
  /** Play a slide video in place; resolves when it ends, fails, or hits its cap. */
  playVideo(elementId: string, control: StepControl): Promise<void>;
  /** Post a widget message to the interactive scene's iframe. */
  sendWidgetMessage(type: string, payload: Record<string, unknown>): void;
  /** The view (caption, effects, discussion card) changed. */
  onView(view: SequencerView): void;
}

export type SequenceResult = 'completed' | 'cancelled';

const EMPTY_VIEW: SequencerView = { caption: null, effects: {}, discussion: null };

export class SceneSequencer {
  readonly gate = new PauseGate();
  private abort: AbortController | null = null;
  private effectTimer: ReturnType<typeof setTimeout> | null = null;
  private skipDiscussion: (() => void) | null = null;
  private view: SequencerView = EMPTY_VIEW;

  constructor(private readonly ports: SequencerPorts) {}

  get running(): boolean {
    return this.abort !== null;
  }

  get paused(): boolean {
    return this.gate.paused;
  }

  /**
   * Play a scene's actions from the start, cancelling any run in progress.
   * Resolves `'completed'` after the last action, `'cancelled'` when another
   * run or {@link cancel} interrupted it.
   */
  async play(actions: readonly ManifestAction[]): Promise<SequenceResult> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    this.gate.set(false);
    const control: StepControl = { signal: abort.signal, gate: this.gate };

    // A scene without actions still shows for one short beat, as in the
    // classroom (an empty speech line on the reading timer).
    const steps = actions.length > 0 ? actions : [{ id: '', type: 'speech', text: '' }];
    for (const action of steps as readonly StandaloneAction[]) {
      await this.gate.whenOpen(control.signal);
      if (control.signal.aborted) return 'cancelled';
      await this.step(action, control);
      if (control.signal.aborted) return 'cancelled';
    }
    await this.gate.whenOpen(control.signal);
    if (control.signal.aborted) return 'cancelled';
    this.abort = null;
    return 'completed';
  }

  pause(): void {
    this.gate.set(true);
  }

  resume(): void {
    this.gate.set(false);
  }

  /** Stop the run in progress and clear everything it put on screen. */
  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.skipDiscussion = null;
    this.gate.set(false);
    this.clearEffectTimer();
    this.setView(EMPTY_VIEW);
  }

  /** Close the discussion card now and continue. */
  dismissDiscussion(): void {
    this.skipDiscussion?.();
  }

  private async step(action: StandaloneAction, control: StepControl): Promise<void> {
    switch (action.type) {
      case 'speech': {
        const text = typeof action.text === 'string' ? action.text : '';
        this.setView({ ...this.view, caption: text.trim() ? text : null });
        const played = action.audioRef
          ? await this.ports.playAudio(action.audioRef, control).catch(() => false)
          : false;
        if (!played && !control.signal.aborted) {
          await pausableDelay(estimateSpeechDurationMs(text), control);
        }
        // The line is over: its caption must not linger over what follows
        // (a video, or a quiz the scene now holds on).
        if (!control.signal.aborted) this.setView({ ...this.view, caption: null });
        return;
      }
      case 'spotlight':
        this.fireEffect({
          spotlight: {
            elementId: action.elementId,
            dimness: action.dimOpacity ?? SPOTLIGHT_DIMNESS,
          },
        });
        return;
      case 'laser':
        this.fireEffect({
          laser: {
            elementId: action.elementId,
            color: action.color ?? LASER_COLOR,
            duration: LASER_DURATION_MS,
          },
        });
        return;
      case 'play_video':
        await this.ports.playVideo(action.elementId, control).catch(() => undefined);
        return;
      case 'discussion': {
        this.setView({ ...this.view, discussion: action.topic || '' });
        await pausableDelay(DISCUSSION_AUTO_SKIP_MS, control, (skip) => {
          this.skipDiscussion = skip;
        });
        if (!control.signal.aborted) {
          this.skipDiscussion = null;
          this.setView({ ...this.view, discussion: null });
        }
        return;
      }
      case 'widget_highlight':
      case 'widget_setState':
      case 'widget_annotation':
      case 'widget_reveal': {
        const { id: _id, type, ...payload } = action;
        this.ports.sendWidgetMessage(WIDGET_MESSAGE_TYPES[type], payload);
        await pausableDelay(WIDGET_MS, control);
        return;
      }
      default:
        // Whiteboard and unknown actions: nothing the offline player can show.
        return;
    }
  }

  private fireEffect(effect: SlideEffects): void {
    this.setView({ ...this.view, effects: { ...this.view.effects, ...effect } });
    // One timer for all effects, restarted by each new one (as the classroom).
    this.clearEffectTimer();
    this.effectTimer = setTimeout(() => {
      this.effectTimer = null;
      this.setView({ ...this.view, effects: {} });
    }, EFFECT_AUTO_CLEAR_MS);
  }

  private clearEffectTimer(): void {
    if (this.effectTimer !== null) clearTimeout(this.effectTimer);
    this.effectTimer = null;
  }

  private setView(view: SequencerView): void {
    if (
      view.caption === this.view.caption &&
      view.effects === this.view.effects &&
      view.discussion === this.view.discussion
    ) {
      return;
    }
    this.view = view;
    this.ports.onView(view);
  }
}
