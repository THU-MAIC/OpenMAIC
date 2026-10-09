/**
 * DOM side of the sequencer ports: the narration `<audio>` element, the slide
 * `<video>` elements, and the interactive scene's iframe channel.
 *
 * Autoplay: browsers only let media with sound start from a user gesture.
 * Playback starts from the Play button, whose click handler calls
 * {@link NarrationPlayer.prime} to start the one shared narration element
 * inside that gesture (WebKit then allows the same element to play later
 * clips). A `play()` that is still refused falls back to the reading timer for
 * speech, and to muted playback for video.
 */
import { MAX_VIDEO_WAIT_MS } from '@/lib/choreography/timing';
import { pausableDelay, type StepControl } from './pause-gate';
import type { MediaLibrary } from './media-library';

/** 0.1 s of silent 8 kHz mono PCM, used to unlock the narration element. */
function silentWavDataUri(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit PCM silence
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Extra time past a video's own duration before playback stops waiting for it. */
const VIDEO_END_GRACE_MS = 3000;
/** Cap for a video whose duration is unknown. */
const VIDEO_UNKNOWN_DURATION_CAP_MS = 60_000;

export class NarrationPlayer {
  private readonly audio: HTMLAudioElement;
  private primed = false;
  /** The clip the element is loading or playing (not the priming sound). */
  private current: string | undefined;

  constructor(private readonly media: MediaLibrary) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    // A source that fails to load reports an `error` event even after the
    // clip's own wait has ended (WebKit and Firefox reject `play()` first),
    // so the failure reaches the library whenever it fires.
    this.audio.addEventListener('error', () => this.media.reportError(this.current));
  }

  /** Call from inside the Play click handler (a user gesture). */
  prime(): void {
    if (this.primed) return;
    this.primed = true;
    try {
      this.current = undefined;
      this.audio.src = silentWavDataUri();
      void this.audio.play().catch(() => {});
    } catch {
      // Priming is best effort; refused clips fall back to the reading timer.
    }
  }

  play(ref: string, control: StepControl): Promise<boolean> {
    const src = this.media.resolve(ref);
    if (!src || control.signal.aborted) return Promise.resolve(false);
    const audio = this.audio;
    return new Promise<boolean>((resolve) => {
      let started = false;
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        unsubscribe();
        control.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onEnded = () => finish(true);
      // A clip that fails before it starts is paced by the reading timer; one
      // that fails midway simply ends.
      const onError = () => finish(started);
      const onAbort = () => {
        audio.pause();
        finish(true);
      };
      const start = () => {
        audio.play().then(
          () => {
            started = true;
          },
          (error: unknown) => {
            // A pause() racing the start rejects with AbortError; resume
            // calls start() again. Anything else means it cannot play.
            if (control.gate.paused || control.signal.aborted) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            // No playable source: WebKit and Firefox reject here before (or
            // without) an `error` event for a file that is not there.
            if (error instanceof DOMException && error.name === 'NotSupportedError') {
              this.media.reportError(ref);
            }
            finish(false);
          },
        );
      };
      const unsubscribe = control.gate.subscribe((paused) => {
        if (paused) audio.pause();
        else start();
      });
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      control.signal.addEventListener('abort', onAbort, { once: true });
      this.current = ref;
      audio.src = src;
      audio.currentTime = 0;
      if (!control.gate.paused) start();
    });
  }

  stop(): void {
    this.audio.pause();
  }
}

/** Callbacks through which a learner's own use of a video steers playback. */
export interface VideoUserHooks {
  /** The learner paused the video the sequencer is waiting on, or started another one. */
  onUserPause(): void;
  /** The learner resumed the video the sequencer is waiting on while playback was paused. */
  onUserPlay(): void;
}

/**
 * Slide `<video>` elements by element id, registered as the slide renders
 * them, and the one `play_video` is currently waiting on.
 *
 * The learner keeps the native controls, kept in step with playback:
 * - pausing the awaited video pauses playback, and playing it again resumes;
 * - starting any other video pauses playback, so narration and the video
 *   never sound together; resuming playback pauses such a video again.
 */
export class VideoRegistry {
  private readonly elements = new Map<string, HTMLVideoElement>();
  private readonly watched = new WeakSet<HTMLVideoElement>();
  /** Element events the registry itself caused, which are not the learner's. */
  private readonly expected = new WeakMap<HTMLVideoElement, { play: number; pause: number }>();
  private active: HTMLVideoElement | null = null;
  private hooks: VideoUserHooks | null = null;

  setUserHooks(hooks: VideoUserHooks | null): void {
    this.hooks = hooks;
  }

  register(elementId: string, video: HTMLVideoElement | null): void {
    if (!video) {
      this.elements.delete(elementId);
      return;
    }
    this.elements.set(elementId, video);
    if (this.watched.has(video)) return;
    this.watched.add(video);
    video.addEventListener('play', () => this.onElementEvent(video, 'play'));
    video.addEventListener('pause', () => this.onElementEvent(video, 'pause'));
  }

  /** Pause every video the learner started by hand (playback is resuming). */
  pauseManual(): void {
    for (const video of this.elements.values()) {
      if (video !== this.active && !video.paused) this.pauseOwn(video);
    }
  }

  async play(elementId: string, control: StepControl): Promise<void> {
    const video = this.elements.get(elementId);
    // Not embedded (poster only) or not on this slide: nothing to wait for.
    if (!video || !(video.currentSrc || video.getAttribute('src')) || control.signal.aborted) {
      return;
    }

    // Ends the wait timer and listeners as soon as the race settles, however
    // it settles (the clip ended, the cap passed, or the run was cancelled).
    const wait = new AbortController();
    const abortWait = () => wait.abort();
    control.signal.addEventListener('abort', abortWait, { once: true });
    let stopWaiting = () => {};
    const ended = new Promise<void>((resolve) => {
      stopWaiting = () => {
        video.removeEventListener('ended', stopWaiting);
        video.removeEventListener('error', stopWaiting);
        resolve();
      };
      video.addEventListener('ended', stopWaiting);
      video.addEventListener('error', stopWaiting);
    });
    const start = async (): Promise<boolean> => {
      try {
        await this.playOwn(video);
        return true;
      } catch (error) {
        if (control.gate.paused || control.signal.aborted) return true;
        if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
          // Sound refused outside a gesture: muted playback is always allowed.
          video.muted = true;
          return start();
        }
        return false;
      }
    };
    const unsubscribe = control.gate.subscribe((paused) => {
      if (paused) this.pauseOwn(video);
      else void start();
    });
    this.active = video;
    try {
      video.currentTime = 0;
      if (!(await start())) return;
      const capMs = Number.isFinite(video.duration)
        ? Math.min(video.duration * 1000 + VIDEO_END_GRACE_MS, MAX_VIDEO_WAIT_MS)
        : VIDEO_UNKNOWN_DURATION_CAP_MS;
      await Promise.race([
        ended,
        pausableDelay(capMs, { signal: wait.signal, gate: control.gate }),
      ]);
    } finally {
      wait.abort();
      control.signal.removeEventListener('abort', abortWait);
      unsubscribe();
      stopWaiting();
      if (this.active === video) this.active = null;
      // Past the cap, or cancelled: the clip must not keep playing under
      // the next narration.
      if (!video.ended && !video.paused) this.pauseOwn(video);
    }
  }

  private async playOwn(video: HTMLVideoElement): Promise<void> {
    const counts = this.expect(video);
    // Only a paused element reports a `play` event.
    const wasPaused = video.paused;
    if (wasPaused) counts.play++;
    try {
      await video.play();
    } catch (error) {
      // A refused play() never reported one.
      if (wasPaused && video.paused && counts.play > 0) counts.play--;
      throw error;
    }
  }

  private pauseOwn(video: HTMLVideoElement): void {
    if (video.paused) return;
    this.expect(video).pause++;
    video.pause();
  }

  private expect(video: HTMLVideoElement) {
    let counts = this.expected.get(video);
    if (!counts) {
      counts = { play: 0, pause: 0 };
      this.expected.set(video, counts);
    }
    return counts;
  }

  private onElementEvent(video: HTMLVideoElement, type: 'play' | 'pause'): void {
    const counts = this.expect(video);
    if (counts[type] > 0) {
      counts[type]--;
      return;
    }
    // A detached element pauses on its own when its slide unmounts; the end
    // of a clip also reports a pause.
    if (!video.isConnected || (type === 'pause' && video.ended)) return;
    if (type === 'pause') {
      if (video === this.active) this.hooks?.onUserPause();
    } else if (video === this.active) {
      // Resuming playback by any path pauses the videos started by hand.
      this.pauseManual();
      this.hooks?.onUserPlay();
    } else {
      // Starting a second hand-started video stops the first one.
      for (const other of this.elements.values()) {
        if (other !== video && other !== this.active && !other.paused) this.pauseOwn(other);
      }
      this.hooks?.onUserPause();
    }
  }
}

/** Posts widget messages to the interactive scene's iframe, queued until it loads. */
export class WidgetChannel {
  private frame: HTMLIFrameElement | null = null;
  private loaded = false;
  private queue: Array<Record<string, unknown>> = [];

  attach(frame: HTMLIFrameElement | null): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.loaded = false;
    this.queue = [];
  }

  markLoaded(frame: HTMLIFrameElement): void {
    if (frame !== this.frame) return;
    this.loaded = true;
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) this.post(message);
  }

  send(type: string, payload: Record<string, unknown>): void {
    const message = { type, ...payload };
    if (!this.frame) return;
    if (!this.loaded) {
      this.queue.push(message);
      return;
    }
    this.post(message);
  }

  private post(message: Record<string, unknown>): void {
    // The page runs in an opaque origin (no allow-same-origin), so the
    // classroom's '*' target is the only one that reaches it.
    this.frame?.contentWindow?.postMessage(message, '*');
  }
}
