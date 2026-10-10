/**
 * Classroom-level playback of the standalone player: which scene plays, when
 * playback moves on, and what Play / Pause mean in each state. Pure (timers
 * only); the React hook in `use-playback.ts` binds it to the DOM.
 *
 * Modes:
 * - `idle`     nothing plays (first load, after the last scene, or after the
 *              learner navigated while paused). Play after the last scene
 *              finished starts the classroom over from its first scene;
 *              otherwise Play starts the shown scene;
 * - `playing`  the current scene's actions run;
 * - `paused`   the run is frozen mid-action and resumes where it stopped;
 * - `holding`  a quiz, interactive or PBL scene finished its narration and
 *              waits for the learner, exactly where the classroom's auto-play
 *              stops. Play (or any navigation) continues with the next scene.
 *
 * After a slide scene finishes, playback advances to the next scene after the
 * classroom's short pause. Navigation at any time cancels the running scene
 * (audio, video, timers, effects) and, while playing or holding, starts the
 * new scene from its beginning.
 */
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import { PauseGate, pausableDelay } from './pause-gate';
import { SceneSequencer, type SequencerPorts, type SequencerView } from './sequencer';

/** Pause before auto-play moves to the next scene (the classroom's value). */
export const SCENE_ADVANCE_DELAY_MS = 1500;

export type PlaybackMode = 'idle' | 'playing' | 'paused' | 'holding';

export interface PlaybackState {
  mode: PlaybackMode;
  /** Whether playback was ever started; the start overlay shows until then. */
  started: boolean;
  view: SequencerView;
}

export interface PlaybackControllerOptions {
  scenes: readonly ManifestScene[];
  ports: Omit<SequencerPorts, 'onView'>;
  /** Show another scene; the host calls {@link PlaybackController.sceneShown} once it rendered. */
  navigate(index: number): void;
}

/** Scene types whose auto-play waits for the learner instead of advancing. */
const HOLDING_SCENE_TYPES = new Set(['quiz', 'interactive', 'pbl']);

export class PlaybackController {
  private readonly sequencer: SceneSequencer;
  private readonly listeners = new Set<() => void>();
  private state: PlaybackState = {
    mode: 'idle',
    started: false,
    view: { caption: null, effects: {}, discussion: null },
  };
  private index = -1;
  /** The last scene played to its end (and nothing was navigated since). */
  private finished = false;
  /** Start the next scene the host shows, whatever the mode. */
  private startOnShow = false;
  private runToken = 0;
  private advance: AbortController | null = null;
  private readonly advanceGate = new PauseGate();

  constructor(private readonly options: PlaybackControllerOptions) {
    this.sequencer = new SceneSequencer({
      ...options.ports,
      onView: (view) => this.update({ view }),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PlaybackState => this.state;

  /** The host rendered scene `index` (after any navigation, including the first render). */
  sceneShown(index: number): void {
    if (index === this.index) return;
    this.index = index;
    this.finished = false;
    this.stopScene();
    const { mode } = this.state;
    const startOnShow = this.startOnShow;
    this.startOnShow = false;
    if (startOnShow || mode === 'playing' || mode === 'holding') this.startScene();
    else if (mode === 'paused') this.update({ mode: 'idle' });
  }

  play(): void {
    switch (this.state.mode) {
      case 'idle':
        if (this.finished && this.index > 0) {
          this.finished = false;
          this.startOnShow = true;
          this.options.navigate(0);
          return;
        }
        this.finished = false;
        this.startScene();
        return;
      case 'paused':
        this.sequencer.resume();
        this.advanceGate.set(false);
        this.update({ mode: 'playing' });
        return;
      case 'holding':
        if (this.index < this.options.scenes.length - 1) this.options.navigate(this.index + 1);
        else this.startScene();
        return;
      case 'playing':
        return;
    }
  }

  pause(): void {
    if (this.state.mode !== 'playing') return;
    this.sequencer.pause();
    this.advanceGate.set(true);
    this.update({ mode: 'paused' });
  }

  toggle(): void {
    if (this.state.mode === 'playing') this.pause();
    else this.play();
  }

  dismissDiscussion(): void {
    this.sequencer.dismissDiscussion();
  }

  /** Stop everything (the player is unmounting). */
  dispose(): void {
    this.stopScene();
    this.listeners.clear();
  }

  private startScene(): void {
    this.stopScene();
    const scene = this.options.scenes[this.index];
    if (!scene) {
      this.update({ mode: 'idle' });
      return;
    }
    const token = ++this.runToken;
    this.update({ mode: 'playing', started: true });
    void this.sequencer.play(scene.actions ?? []).then((result) => {
      if (result === 'completed' && token === this.runToken) void this.sceneFinished(token);
    });
  }

  private async sceneFinished(token: number): Promise<void> {
    const scene = this.options.scenes[this.index];
    const isLast = this.index >= this.options.scenes.length - 1;
    if (isLast) {
      this.finished = true;
      this.update({ mode: 'idle' });
      return;
    }
    if (scene && HOLDING_SCENE_TYPES.has(scene.type)) {
      this.update({ mode: 'holding' });
      return;
    }
    const advance = new AbortController();
    this.advance = advance;
    this.advanceGate.set(this.state.mode === 'paused');
    await pausableDelay(SCENE_ADVANCE_DELAY_MS, {
      signal: advance.signal,
      gate: this.advanceGate,
    });
    if (advance.signal.aborted || token !== this.runToken) return;
    this.advance = null;
    this.options.navigate(this.index + 1);
  }

  private stopScene(): void {
    this.runToken++;
    this.advance?.abort();
    this.advance = null;
    this.advanceGate.set(false);
    this.sequencer.cancel();
  }

  private update(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
