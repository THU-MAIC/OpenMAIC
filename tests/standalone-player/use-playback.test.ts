// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import { usePlayback, type Playback } from '@/lib/standalone-player/playback/use-playback';
import { NarrationPlayer, WidgetChannel } from '@/lib/standalone-player/playback/media-ports';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const scenes = [0, 1].map((order) => ({
  type: 'interactive',
  order,
  title: String(order),
  content: { type: 'interactive' },
  actions: ['A', 'B'].map((text) => ({ id: text, type: 'speech', text, audioRef: text })),
})) as ManifestScene[];
let root: Root;
let playback: Playback;
let index: number;
let activeScenes: ManifestScene[];
let finishAudio: () => void;
const navigate = vi.fn();
function Probe() {
  const current = usePlayback(activeScenes, index, navigate);
  useEffect(() => {
    playback = current;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(NarrationPlayer.prototype, 'prime').mockImplementation(() => {});
  vi.spyOn(NarrationPlayer.prototype, 'play').mockImplementation(
    (_ref, control) =>
      new Promise((resolve) => {
        finishAudio = () => resolve(true);
        control.signal.addEventListener('abort', () => resolve(true), { once: true });
      }),
  );
  vi.spyOn(WidgetChannel.prototype, 'pauseMedia')
    .mockReturnValue(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(Promise.resolve(false));
  navigate.mockReset();
  index = 0;
  activeScenes = scenes;
  root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function blockSecondSpeech() {
  await act(async () => playback.play());
  expect(NarrationPlayer.prototype.play).toHaveBeenCalledWith('A', expect.anything());
  await act(async () => finishAudio());
}

describe('standalone narration silence failures', () => {
  it.each(['play', 'toggle'] as const)(
    'lets %s restart a completed last scene but guards the destination speech',
    async (command) => {
      const silence = vi.mocked(WidgetChannel.prototype.pauseMedia);
      silence.mockReset().mockReturnValue(true);
      index = 1;
      await act(async () => root.render(createElement(Probe)));
      await act(async () => playback.play());
      await act(async () => finishAudio());
      await act(async () => finishAudio());
      expect(playback.state.mode).toBe('idle');
      silence.mockReset().mockReturnValue(Promise.resolve(false));
      await act(async () => playback[command]());
      expect(navigate).toHaveBeenCalledExactlyOnceWith(0);
      expect(silence).not.toHaveBeenCalled();
      vi.mocked(NarrationPlayer.prototype.play).mockClear();
      index = 0;
      await act(async () => root.render(createElement(Probe)));
      expect(playback.state.mode).toBe('paused');
      expect(silence).toHaveBeenCalledOnce();
      expect(NarrationPlayer.prototype.play).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'guards unfinished idle after navigation (started: %s)',
    async (started) => {
      const silence = vi.mocked(WidgetChannel.prototype.pauseMedia);
      silence.mockReset().mockReturnValue(true);
      if (started) {
        await act(async () => playback.play());
        act(() => playback.pause());
      }
      index = 1;
      await act(async () => root.render(createElement(Probe)));
      expect(playback.state.mode).toBe('idle');
      vi.mocked(NarrationPlayer.prototype.play).mockClear();
      silence.mockReturnValue(Promise.resolve(false));
      await act(async () => playback.play());
      expect(navigate).not.toHaveBeenCalled();
      expect(NarrationPlayer.prototype.play).not.toHaveBeenCalled();
      expect(playback.state.mode).toBe('idle');
    },
  );

  it('keeps the silence guard when a single completed scene replays in place', async () => {
    const silence = vi.mocked(WidgetChannel.prototype.pauseMedia);
    silence.mockReset().mockReturnValue(true);
    activeScenes = scenes.slice(0, 1);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => playback.play());
    await act(async () => finishAudio());
    await act(async () => finishAudio());
    expect(playback.state.mode).toBe('idle');
    vi.mocked(NarrationPlayer.prototype.play).mockClear();
    silence.mockReturnValue(Promise.resolve(false));
    await act(async () => playback.play());
    expect(navigate).not.toHaveBeenCalled();
    expect(NarrationPlayer.prototype.play).not.toHaveBeenCalled();
    expect(playback.state.mode).toBe('idle');
  });

  it.each(['play', 'toggle'] as const)(
    'lets %s continue from holding without waiting for the departing frame',
    async (command) => {
      const silence = vi.mocked(WidgetChannel.prototype.pauseMedia);
      silence.mockReset().mockReturnValue(true);
      await act(async () => playback.play());
      await act(async () => finishAudio());
      await act(async () => finishAudio());
      expect(playback.state.mode).toBe('holding');
      silence.mockReset().mockReturnValue(Promise.resolve(false));
      await act(async () => playback[command]());
      expect(navigate).toHaveBeenCalledWith(1);
      expect(silence).not.toHaveBeenCalled();
    },
  );

  it('keeps the silence preflight when resuming paused narration', async () => {
    const silence = vi.mocked(WidgetChannel.prototype.pauseMedia);
    silence.mockReset().mockReturnValue(true);
    await act(async () => playback.play());
    act(() => playback.pause());
    silence.mockReturnValue(Promise.resolve(false));
    await act(async () => playback.play());
    expect(playback.state.mode).toBe('paused');
    expect(navigate).not.toHaveBeenCalled();
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('pauses on the current speech and retries its audio instead of advancing on reading time', async () => {
    await blockSecondSpeech();
    expect(playback.state).toMatchObject({ mode: 'paused', view: { caption: 'B' } });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(playback.state).toMatchObject({ mode: 'paused', view: { caption: 'B' } });
    expect(navigate).not.toHaveBeenCalled();
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
    await act(async () => playback.play());
    expect(playback.state.mode).toBe('playing');
    expect(NarrationPlayer.prototype.play).toHaveBeenLastCalledWith('B', expect.anything());
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('cancels the blocked sentence when navigating away', async () => {
    await blockSecondSpeech();
    index = 1;
    await act(async () => root.render(createElement(Probe)));
    expect(playback.state.mode).toBe('idle');
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('cancels a blocked sentence on disposal', async () => {
    await blockSecondSpeech();
    await act(async () => root.render(null));
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
  });
});
