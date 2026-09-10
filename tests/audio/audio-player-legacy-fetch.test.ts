import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The legacy narration fetch of playback: superseded plays must abort the
// in-flight fetch at the network layer (stop/replace/destroy), a stalled
// fetch must be bounded by a timeout, and ordinary fetch/CORS failures keep
// the direct media-element fallback.
const mocks = vi.hoisted(() => ({
  resolveAudioBlob: vi.fn(async (..._args: unknown[]) => null),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: (...args: unknown[]) => mocks.resolveAudioBlob(...args),
}));

function stubObjectUrl() {
  class URLStub extends URL {}
  Object.assign(URLStub, {
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  });
  vi.stubGlobal('URL', URLStub);
}

function stubAudio(play: () => Promise<void>) {
  class AudioStub {
    play = play;
    addEventListener = vi.fn();
    pause = vi.fn();
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    src = '';
    currentTime = 0;
  }
  vi.stubGlobal('Audio', AudioStub);
}

/**
 * A fetch implementation that stalls until the caller's abort signal fires.
 * Records every signal it received so tests can assert cancellation.
 */
function stalledFetch(record: { signals: Array<AbortSignal | undefined>; calls: number }) {
  return vi.fn<typeof globalThis.fetch>((_input, init) => {
    record.calls += 1;
    const signal = init?.signal;
    record.signals.push(signal as AbortSignal);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
    });
  });
}

describe('AudioPlayer legacy narration fetch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    stubAudio(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the in-flight legacy fetch when playback is stopped', async () => {
    stubObjectUrl();
    const record: { signals: Array<AbortSignal | undefined>; calls: number } = {
      signals: [],
      calls: 0,
    };
    vi.stubGlobal('fetch', stalledFetch(record));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const url = 'https://server.example.com/audio/legacy.mp3';

    const playing = player.play('tts_s0_a1', url);
    // The fetch is in flight and unanswered.
    await vi.waitFor(() => expect(record.calls).toBe(1));

    player.stop();

    // The superseded play was cancelled at the network layer and settles
    // false instead of waiting for the fetch.
    await expect(playing).resolves.toBe(false);
    expect(record.signals[0]?.aborted).toBe(true);
  });

  it('aborts the previous play fetch when a replacement play starts', async () => {
    stubObjectUrl();
    const record: { signals: Array<AbortSignal | undefined>; calls: number } = {
      signals: [],
      calls: 0,
    };
    const fetchImpl = vi.fn<typeof globalThis.fetch>((input, init) => {
      record.calls += 1;
      const signal = init?.signal;
      record.signals.push(signal as AbortSignal);
      if (String(input) === 'https://server.example.com/audio/second.mp3') {
        return Promise.resolve(
          new Response(new Blob(['second'], { type: 'audio/mpeg' }), { status: 200 }),
        );
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();

    const first = player.play('tts_s0_a1', 'https://server.example.com/audio/first.mp3');
    await vi.waitFor(() => expect(record.calls).toBe(1));

    await player.play('tts_s0_a2', 'https://server.example.com/audio/second.mp3');

    await expect(first).resolves.toBe(false);
    expect(record.signals[0]?.aborted).toBe(true);
  });

  it('aborts the in-flight legacy fetch on destroy()', async () => {
    stubObjectUrl();
    const record: { signals: Array<AbortSignal | undefined>; calls: number } = {
      signals: [],
      calls: 0,
    };
    vi.stubGlobal('fetch', stalledFetch(record));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const url = 'https://server.example.com/audio/legacy.mp3';

    const playing = player.play('tts_s0_a1', url);
    await vi.waitFor(() => expect(record.calls).toBe(1));

    player.destroy();

    await expect(playing).resolves.toBe(false);
    expect(record.signals[0]?.aborted).toBe(true);
  });

  it('bounds a stalled legacy fetch with a finite timeout and falls back to the media element', async () => {
    vi.useFakeTimers();
    stubObjectUrl();
    const record: { signals: Array<AbortSignal | undefined>; calls: number } = {
      signals: [],
      calls: 0,
    };
    vi.stubGlobal('fetch', stalledFetch(record));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const url = 'https://server.example.com/audio/stalled.mp3';

    const playing = player.play('tts_s0_a1', url);
    await vi.advanceTimersByTimeAsync(0);
    expect(record.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(16_000);

    // The timeout aborted the fetch; the media element fallback took over
    // with the URL directly (the bytes could not be fetched in budget).
    await expect(playing).resolves.toBe(true);
    expect(record.signals[0]?.aborted).toBe(true);
    expect((player as unknown as { audio: { src: string } | null }).audio?.src).toBe(url);
  });

  it('keeps the direct media-element fallback for ordinary fetch failures', async () => {
    stubObjectUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const url = 'https://cross-origin.example.com/audio/no-cors.mp3';

    await expect(player.play('tts_s0_a1', url)).resolves.toBe(true);
    expect((player as unknown as { audio: { src: string } | null }).audio?.src).toBe(url);
  });

  it('treats a zero-byte legacy fetch as no narration and falls back to the media element', async () => {
    stubObjectUrl();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([]), { status: 200 })),
    );

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const url = 'https://server.example.com/audio/empty.mp3';

    await expect(player.play('tts_s0_a1', url)).resolves.toBe(true);
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
    expect((player as unknown as { audio: { src: string } | null }).audio?.src).toBe(url);
  });
});
