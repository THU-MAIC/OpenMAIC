// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NarrationPlayer,
  VideoRegistry,
  WidgetChannel,
} from '@/lib/standalone-player/playback/media-ports';
import { PauseGate, type StepControl } from '@/lib/standalone-player/playback/pause-gate';
import type { MediaLibrary } from '@/lib/standalone-player/playback/media-library';
import { MAX_VIDEO_WAIT_MS } from '@/lib/choreography/timing';

/**
 * jsdom implements no media playback: give an element scriptable play/pause
 * with the events and `paused`/`ended` state a browser reports.
 */
function scriptMedia<T extends HTMLMediaElement>(element: T) {
  const state = { paused: true, ended: false, duration: NaN };
  const plays: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  Object.defineProperty(element, 'paused', { get: () => state.paused });
  Object.defineProperty(element, 'ended', { get: () => state.ended });
  Object.defineProperty(element, 'duration', { get: () => state.duration });
  element.play = vi.fn(() => {
    return new Promise<void>((resolve, reject) => {
      plays.push({
        resolve: () => {
          if (state.paused) {
            state.paused = false;
            element.dispatchEvent(new Event('play'));
          }
          resolve();
        },
        reject,
      });
    });
  });
  element.pause = vi.fn(() => {
    if (state.paused) return;
    state.paused = true;
    element.dispatchEvent(new Event('pause'));
  });
  return {
    state,
    plays,
    /** Let the latest play() succeed. */
    started() {
      plays[plays.length - 1].resolve();
    },
    refuse(name: string) {
      plays[plays.length - 1].reject(new DOMException('refused', name));
    },
    end() {
      state.paused = true;
      state.ended = true;
      element.dispatchEvent(new Event('pause'));
      element.dispatchEvent(new Event('ended'));
    },
    /** The learner uses the native controls. */
    userPause() {
      state.paused = true;
      element.dispatchEvent(new Event('pause'));
    },
    userPlay() {
      state.paused = false;
      element.dispatchEvent(new Event('play'));
    },
  };
}

function control(): StepControl & { abort: AbortController } {
  const abort = new AbortController();
  return { signal: abort.signal, gate: new PauseGate(), abort };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NarrationPlayer', () => {
  const reportError = vi.fn();
  const media = (src: string | undefined): MediaLibrary => ({
    resolve: () => src,
    has: () => !!src,
    dispose: () => {},
    reportError,
    linkedMediaMissing: () => false,
    subscribe: () => () => {},
    probeLinkedMedia: () => {},
  });

  function player(src: string | null = 'blob:clip') {
    const element = document.createElement('audio');
    const scripted = scriptMedia(element);
    vi.spyOn(window, 'Audio').mockImplementation(function () {
      return element;
    } as never);
    return { narration: new NarrationPlayer(media(src ?? undefined)), element, audio: scripted };
  }

  it('resolves true when the clip plays to its end', async () => {
    const { narration, audio } = player();
    const ctl = control();
    const done = narration.play('k', ctl);
    audio.started();
    await flush();
    audio.end();
    await expect(done).resolves.toBe(true);
  });

  it('resolves false when the media cannot be decoded (no playable URL)', async () => {
    const { narration } = player(null);
    await expect(narration.play('k', control())).resolves.toBe(false);
  });

  it('resolves false when play() is refused, so the reading timer takes over', async () => {
    const { narration, audio } = player();
    const done = narration.play('k', control());
    audio.refuse('NotAllowedError');
    await expect(done).resolves.toBe(false);
  });

  it('a pause racing play() does not end the clip; resuming plays it again', async () => {
    const { narration, audio, element } = player();
    const ctl = control();
    let result: boolean | undefined;
    void narration.play('k', ctl).then((r) => (result = r));
    ctl.gate.set(true);
    audio.refuse('AbortError');
    await flush();
    expect(result).toBeUndefined();
    ctl.gate.set(false);
    expect(element.play).toHaveBeenCalledTimes(2);
    audio.started();
    await flush();
    audio.end();
    await flush();
    expect(result).toBe(true);
  });

  it('an error before the clip starts falls back to the timer; after it started it just ends', async () => {
    reportError.mockClear();
    const first = player();
    const early = first.narration.play('k', control());
    first.element.dispatchEvent(new Event('error'));
    await expect(early).resolves.toBe(false);

    const second = player();
    const late = second.narration.play('k', control());
    second.audio.started();
    await flush();
    second.element.dispatchEvent(new Event('error'));
    await expect(late).resolves.toBe(true);
    // Both failures reach the library, which decides whether a file is missing.
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith('k');
  });

  it('reports a clip with no playable source when play() rejects before any error event', async () => {
    reportError.mockClear();
    const { narration, audio } = player();
    const done = narration.play('audio/missing.mp3', control());
    // WebKit and Firefox reject play() for a missing file first.
    audio.refuse('NotSupportedError');
    await expect(done).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith('audio/missing.mp3');
  });

  it('reports an error event that fires after the clip has already given up', async () => {
    reportError.mockClear();
    const { narration, audio, element } = player();
    const done = narration.play('audio/late.mp3', control());
    audio.refuse('NotAllowedError');
    await expect(done).resolves.toBe(false);
    // Autoplay refusal is not a missing file.
    expect(reportError).not.toHaveBeenCalled();
    element.dispatchEvent(new Event('error'));
    expect(reportError).toHaveBeenCalledWith('audio/late.mp3');
  });

  it('does not report the priming sound as a clip', () => {
    reportError.mockClear();
    const { narration, element } = player();
    narration.prime();
    element.dispatchEvent(new Event('error'));
    expect(reportError).toHaveBeenCalledWith(undefined);
  });

  it('cancelling pauses the clip', async () => {
    const { narration, audio, element } = player();
    const ctl = control();
    const done = narration.play('k', ctl);
    audio.started();
    await flush();
    ctl.abort.abort();
    await expect(done).resolves.toBe(true);
    expect(element.pause).toHaveBeenCalled();
  });
});

describe('VideoRegistry', () => {
  function mountedVideo(registry: VideoRegistry, id = 'clip') {
    const video = document.createElement('video');
    video.setAttribute('src', 'blob:video');
    document.body.append(video);
    const scripted = scriptMedia(video);
    registry.register(id, video);
    return { video, scripted };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves at once for a video without bytes', async () => {
    const registry = new VideoRegistry();
    await expect(registry.play('missing', control())).resolves.toBeUndefined();
  });

  it('waits for the end and leaves no timer behind', async () => {
    const registry = new VideoRegistry();
    const { scripted } = mountedVideo(registry);
    scripted.state.duration = 3;
    let done = false;
    void registry.play('clip', control()).then(() => (done = true));
    scripted.started();
    await flush();
    expect(done).toBe(false);
    scripted.end();
    await flush();
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the video when the wait cap passes', async () => {
    const registry = new VideoRegistry();
    const { video, scripted } = mountedVideo(registry);
    scripted.state.duration = 4;
    let done = false;
    void registry.play('clip', control()).then(() => (done = true));
    scripted.started();
    await flush();
    await vi.advanceTimersByTimeAsync(4000 + 3000);
    expect(done).toBe(true);
    expect(video.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps a video of unknown duration and never past the global cap', async () => {
    const registry = new VideoRegistry();
    const { scripted } = mountedVideo(registry);
    scripted.state.duration = 60 * 60;
    let done = false;
    void registry.play('clip', control()).then(() => (done = true));
    scripted.started();
    await flush();
    await vi.advanceTimersByTimeAsync(MAX_VIDEO_WAIT_MS);
    expect(done).toBe(true);
  });

  it('cancelling stops the video', async () => {
    const registry = new VideoRegistry();
    const { video, scripted } = mountedVideo(registry);
    const ctl = control();
    const done = registry.play('clip', ctl);
    scripted.started();
    await flush();
    ctl.abort.abort();
    await done;
    expect(video.paused).toBe(true);
  });

  it('retries muted when sound is refused outside a gesture', async () => {
    const registry = new VideoRegistry();
    const { video, scripted } = mountedVideo(registry);
    void registry.play('clip', control());
    scripted.refuse('NotAllowedError');
    await flush();
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('keeps playback in step with the learner using the video controls', async () => {
    const registry = new VideoRegistry();
    const hooks = { onUserPause: vi.fn(), onUserPlay: vi.fn() };
    registry.setUserHooks(hooks);
    const { scripted } = mountedVideo(registry);
    const other = mountedVideo(registry, 'other');
    const ctl = control();
    void registry.play('clip', ctl);
    scripted.started();
    await flush();
    // The registry's own play() is not the learner's.
    expect(hooks.onUserPlay).not.toHaveBeenCalled();

    scripted.userPause();
    expect(hooks.onUserPause).toHaveBeenCalledTimes(1);
    ctl.gate.set(true);
    scripted.userPlay();
    expect(hooks.onUserPlay).toHaveBeenCalledTimes(1);

    // Starting another video pauses playback; resuming pauses that video.
    other.scripted.userPlay();
    expect(hooks.onUserPause).toHaveBeenCalledTimes(2);
    registry.pauseManual();
    expect(other.video.paused).toBe(true);

    // The end of a clip is not a learner pause.
    scripted.end();
    expect(hooks.onUserPause).toHaveBeenCalledTimes(2);
  });

  it('starting a second video by hand pauses the first one started by hand', async () => {
    const registry = new VideoRegistry();
    const hooks = { onUserPause: vi.fn(), onUserPlay: vi.fn() };
    registry.setUserHooks(hooks);
    const first = mountedVideo(registry, 'a');
    const second = mountedVideo(registry, 'b');
    first.scripted.userPlay();
    expect(first.video.paused).toBe(false);
    second.scripted.userPlay();
    expect(first.video.paused).toBe(true);
    expect(second.video.paused).toBe(false);
    // The registry's own pause is not the learner's, so it adds no extra hook call.
    expect(hooks.onUserPause).toHaveBeenCalledTimes(2);
  });

  it('starting a manual video leaves the awaited video to the playback pause', async () => {
    const registry = new VideoRegistry();
    registry.setUserHooks({ onUserPause: vi.fn(), onUserPlay: vi.fn() });
    const awaited = mountedVideo(registry, 'a');
    const manual = mountedVideo(registry, 'b');
    void registry.play('a', control());
    awaited.scripted.started();
    await flush();
    manual.scripted.userPlay();
    // The sequencer's pause gate (not the registry) pauses the awaited clip.
    expect(manual.video.paused).toBe(false);
    expect(awaited.video.paused).toBe(false);
  });

  it('resuming the awaited video by its controls pauses a video started by hand', async () => {
    const registry = new VideoRegistry();
    const hooks = { onUserPause: vi.fn(), onUserPlay: vi.fn() };
    registry.setUserHooks(hooks);
    const awaited = mountedVideo(registry, 'a');
    const manual = mountedVideo(registry, 'b');
    const ctl = control();
    void registry.play('a', ctl);
    awaited.scripted.started();
    await flush();
    // B started by hand: playback (and A) pause.
    manual.scripted.userPlay();
    expect(hooks.onUserPause).toHaveBeenCalledTimes(1);
    ctl.gate.set(true);
    expect(awaited.video.paused).toBe(true);
    // A resumed through its own controls: B must stop, playback resumes.
    awaited.scripted.userPlay();
    expect(manual.video.paused).toBe(true);
    expect(hooks.onUserPlay).toHaveBeenCalledTimes(1);
    // The registry's pause of B is not reported as the learner's.
    expect(hooks.onUserPause).toHaveBeenCalledTimes(1);
  });

  it('ignores the pause of a video whose slide unmounted', async () => {
    const registry = new VideoRegistry();
    const hooks = { onUserPause: vi.fn(), onUserPlay: vi.fn() };
    registry.setUserHooks(hooks);
    const { video, scripted } = mountedVideo(registry);
    void registry.play('clip', control());
    scripted.started();
    await flush();
    video.remove();
    scripted.userPause();
    expect(hooks.onUserPause).not.toHaveBeenCalled();
  });
});

describe('WidgetChannel', () => {
  it('queues messages until the iframe loaded, then posts them in order', () => {
    const channel = new WidgetChannel();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    channel.attach(frame);
    channel.send('HIGHLIGHT_ELEMENT', { target: '#a' });
    channel.send('SET_WIDGET_STATE', { state: { x: 1 } });
    expect(post).not.toHaveBeenCalled();
    channel.markLoaded(frame);
    expect(post.mock.calls).toEqual([
      [{ type: 'HIGHLIGHT_ELEMENT', target: '#a' }, '*'],
      [{ type: 'SET_WIDGET_STATE', state: { x: 1 } }, '*'],
    ]);
    channel.send('REVEAL_ELEMENT', { target: '#b' });
    expect(post).toHaveBeenCalledTimes(3);
    // Re-attaching the same frame (a re-render) keeps it loaded.
    channel.attach(frame);
    channel.send('REVEAL_ELEMENT', { target: '#c' });
    expect(post).toHaveBeenCalledTimes(4);
    frame.remove();
  });

  it('drops messages when no interactive scene is shown', () => {
    const channel = new WidgetChannel();
    expect(() => channel.send('HIGHLIGHT_ELEMENT', {})).not.toThrow();
  });
});
