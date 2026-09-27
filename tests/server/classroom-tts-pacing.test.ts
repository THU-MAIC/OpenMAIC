import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/types/stage';

const ttsMocks = vi.hoisted(() => ({
  generateTTS: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (_filePath: string, _data: Uint8Array) => undefined),
}));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return {
    ...actual,
    generateTTS: (...args: unknown[]) => ttsMocks.generateTTS(...args),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: fsMocks.mkdir,
      writeFile: fsMocks.writeFile,
    },
  };
});

const TTS_PREFIXES = [
  'TTS_OPENAI',
  'TTS_AZURE',
  'TTS_GLM',
  'TTS_QWEN',
  'TTS_VOXCPM',
  'TTS_DOUBAO',
  'TTS_ELEVENLABS',
  'TTS_LEMONADE',
  'TTS_MINIMAX',
] as const;

const CLIP = new Uint8Array([1, 2, 3, 4]);

function speechScene(
  speeches: Array<{ id: string; text: string }>,
  extras: Array<{ id: string; type: string }> = [],
): Scene {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 2,
    actions: [
      ...extras,
      ...speeches.map((speech) => ({
        id: speech.id,
        type: 'speech' as const,
        text: speech.text,
      })),
    ],
  } as unknown as Scene;
}

function speechAction(scene: Scene, id: string) {
  const action = scene.actions?.find((candidate) => candidate.id === id);
  return action as { id: string; audioId?: string; audioUrl?: string } | undefined;
}

async function loadClassroomTts() {
  const media = await import('@/lib/server/classroom-media-generation');
  const tts = await import('@/lib/audio/tts-providers');
  return {
    generateTTSForClassroom: media.generateTTSForClassroom,
    TTSRateLimitError: tts.TTSRateLimitError,
  };
}

async function runClassroomTts(
  scenes: Scene[],
  signal?: AbortSignal,
  onProgress?: (progress: { written: number; total: number }) => void,
) {
  const { generateTTSForClassroom } = await loadClassroomTts();
  const pending = generateTTSForClassroom(
    scenes,
    'cls-tts',
    'http://localhost',
    signal,
    onProgress,
  );
  await vi.runAllTimersAsync();
  return pending;
}

describe('generateTTSForClassroom pacing and coverage', () => {
  const logLines: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ttsMocks.generateTTS.mockReset();
    fsMocks.mkdir.mockClear();
    fsMocks.writeFile.mockClear();
    logLines.length = 0;

    for (const prefix of TTS_PREFIXES) {
      vi.stubEnv(`${prefix}_API_KEY`, '');
      vi.stubEnv(`${prefix}_BASE_URL`, '');
      vi.stubEnv(`${prefix}_ENABLED`, 'false');
    }
    vi.stubEnv('TTS_MINIMAX_API_KEY', 'test-minimax-key');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'true');
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '1000');

    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((line?: unknown) => {
        logLines.push(String(line));
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('spaces successful clips by TTS_MIN_INTERVAL_MS and records full coverage', async () => {
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      return { audio: CLIP, format: 'mp3' };
    });
    const scene = speechScene(
      [
        { id: 'action_0', text: 'first line' },
        { id: 'action_1', text: 'second line' },
      ],
      [{ id: 'spot', type: 'spotlight' }],
    );

    const coverage = await runClassroomTts([scene]);

    expect(coverage).toEqual({ written: 2, total: 2 });
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBe(1000);
    expect(speechAction(scene, 'action_0')).toMatchObject({
      audioId: 'tts_s2_action_0',
      audioUrl: 'http://localhost/api/classroom-media/cls-tts/audio/tts_s2_action_0.mp3',
    });
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2);
    const [filePath, bytes] = fsMocks.writeFile.mock.calls[0]!;
    expect(String(filePath)).toMatch(/tts_s2_action_0\.mp3$/);
    expect(bytes).toEqual(CLIP);
    expect(logLines.some((line) => line.includes('TTS generation complete: 2 clips written'))).toBe(
      true,
    );
    expect(logLines.some((line) => line.includes('TTS generation INCOMPLETE'))).toBe(false);
  });

  it('uses a 0ms default interval when TTS_MIN_INTERVAL_MS is unset', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '');
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      return { audio: CLIP, format: 'mp3' };
    });

    await runClassroomTts([
      speechScene([
        { id: 'action_0', text: 'one' },
        { id: 'action_1', text: 'two' },
      ]),
    ]);

    expect(startedAt[1]! - startedAt[0]!).toBe(0);
  });

  it('does not wait between clips when TTS_MIN_INTERVAL_MS is 0', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '0');
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      return { audio: CLIP, format: 'mp3' };
    });

    await runClassroomTts([
      speechScene([
        { id: 'action_0', text: 'one' },
        { id: 'action_1', text: 'two' },
      ]),
    ]);

    expect(startedAt[1]! - startedAt[0]!).toBe(0);
  });

  it('backs off from a positive floor after a rate limit when TTS_MIN_INTERVAL_MS is 0', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '0');
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length <= 2) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });

    const coverage = await runClassroomTts([speechScene([{ id: 'action_0', text: 'retry me' }])]);

    expect(coverage).toEqual({ written: 1, total: 1 });
    expect(startedAt).toHaveLength(3);
    // Configured spacing stays 0 for successes. The first rate-limit delay is
    // 2× the 1000ms floor, then the next retry doubles that delay.
    expect(startedAt[1]! - startedAt[0]!).toBe(2000);
    expect(startedAt[2]! - startedAt[1]!).toBe(4000);
    expect(logLines.some((line) => line.includes('widening spacing to 2000ms (retry 1/5)'))).toBe(
      true,
    );
    expect(logLines.some((line) => line.includes('widening spacing to 4000ms (retry 2/5)'))).toBe(
      true,
    );
  });

  it('waits the full widened back-off after a slow rate-limited response', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });

    const coverage = await runClassroomTts([speechScene([{ id: 'action_0', text: 'slow limit' }])]);

    expect(coverage).toEqual({ written: 1, total: 1 });
    expect(startedAt).toHaveLength(2);
    // The failed request took 5000ms and the widened spacing is 2000ms.
    // That elapsed time must not cancel the back-off.
    expect(startedAt[1]! - startedAt[0]!).toBe(7000);
  });

  it('honours Retry-After when it is longer than the widened spacing', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded', 7000);
      }
      return { audio: CLIP, format: 'mp3' };
    });

    const coverage = await runClassroomTts([
      speechScene([{ id: 'action_0', text: 'retry after' }]),
    ]);

    expect(coverage).toEqual({ written: 1, total: 1 });
    expect(startedAt[1]! - startedAt[0]!).toBe(7000);
  });

  it('keeps the widened spacing when Retry-After is shorter than that delay', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded', 500);
      }
      return { audio: CLIP, format: 'mp3' };
    });

    await runClassroomTts([speechScene([{ id: 'action_0', text: 'short retry after' }])]);

    expect(startedAt[1]! - startedAt[0]!).toBe(2000);
  });

  it('does not spend the back-off budget on successful clip spacing', async () => {
    vi.stubEnv('TTS_BACKOFF_BUDGET_MS', '0');
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      return { audio: CLIP, format: 'mp3' };
    });

    const coverage = await runClassroomTts([
      speechScene([
        { id: 'action_0', text: 'one' },
        { id: 'action_1', text: 'two' },
      ]),
    ]);

    expect(coverage).toEqual({ written: 2, total: 2 });
    expect(startedAt[1]! - startedAt[0]!).toBe(1000);
  });

  it('marks remaining clips failed once the TTS back-off budget is exhausted', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '0');
    vi.stubEnv('TTS_BACKOFF_BUDGET_MS', '3000');
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
    });
    const scene = speechScene([
      { id: 'action_0', text: 'first' },
      { id: 'action_1', text: 'second' },
    ]);

    const coverage = await runClassroomTts([scene]);

    // First delay is 2000ms and fits. The next delay is 4000ms and does not,
    // so the second clip is never requested.
    expect(startedAt).toEqual([0, 2000].map((offset) => startedAt[0]! + offset));
    expect(startedAt).toHaveLength(2);
    expect(coverage).toEqual({ written: 0, total: 2 });
    expect(speechAction(scene, 'action_0')?.audioId).toBeUndefined();
    expect(speechAction(scene, 'action_1')?.audioId).toBeUndefined();
    expect(ttsMocks.generateTTS).toHaveBeenCalledTimes(2);
    expect(logLines.some((line) => line.includes('TTS back-off budget exhausted'))).toBe(true);
    expect(
      logLines.some((line) =>
        line.includes('TTS generation INCOMPLETE: 0 written, 2 speech actions left silent'),
      ),
    ).toBe(true);
  });

  it('rejects a rate-limit back-off wait when the caller signal aborts', async () => {
    const { TTSRateLimitError, generateTTSForClassroom } = await loadClassroomTts();
    ttsMocks.generateTTS.mockRejectedValue(new TTSRateLimitError('MiniMax', 'rate limit exceeded'));
    const controller = new AbortController();
    const pending = generateTTSForClassroom(
      [speechScene([{ id: 'action_0', text: 'cancel me' }])],
      'cls-tts',
      'http://localhost',
      controller.signal,
    );
    const settled = pending.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await Promise.race([
      settled,
      vi.advanceTimersByTimeAsync(2000).then(() => 'still-sleeping' as const),
    ]);

    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(ttsMocks.generateTTS).toHaveBeenCalledTimes(1);
  });

  it('doubles spacing after a rate limit and retries the same action', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });
    const scene = speechScene([{ id: 'action_0', text: 'retry me' }]);

    const coverage = await runClassroomTts([scene]);

    expect(coverage).toEqual({ written: 1, total: 1 });
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBe(2000);
    expect(speechAction(scene, 'action_0')?.audioId).toBe('tts_s2_action_0');
    expect(
      logLines.some((line) =>
        line.includes(
          'TTS rate limited for tts_s2_action_0; widening spacing to 2000ms (retry 1/5)',
        ),
      ),
    ).toBe(true);
    expect(logLines.some((line) => line.includes('TTS generation complete: 1 clips written'))).toBe(
      true,
    );
  });

  it('steps spacing down after a successful clip and resets the per-action retry count', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1 || startedAt.length === 3) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });

    const coverage = await runClassroomTts([
      speechScene([
        { id: 'action_0', text: 'first' },
        { id: 'action_1', text: 'second' },
      ]),
    ]);

    expect(coverage).toEqual({ written: 2, total: 2 });
    expect(startedAt).toHaveLength(4);
    // Base spacing is 1000. The first limit widens to 2000. One success steps
    // that back to 1500, and the next limit widens from 1500 to 3000.
    expect(
      startedAt.map((time, index) => (index === 0 ? 0 : time - startedAt[index - 1]!)),
    ).toEqual([0, 2000, 1500, 3000]);
    expect(logLines.filter((line) => line.includes('(retry 1/5)')).length).toBe(2);
    expect(logLines.some((line) => line.includes('widening spacing to 3000ms (retry 1/5)'))).toBe(
      true,
    );
  });

  it('decays maxed spacing across a long course and heartbeats inside the stale window', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '0');
    const { TTSRateLimitError } = await loadClassroomTts();
    const clipCount = 16;
    const startedAt: number[] = [];
    const heartbeats: Array<{ written: number; total: number; at: number }> = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length <= 4) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });

    const started = Date.now();
    const coverage = await runClassroomTts(
      [
        speechScene(
          Array.from({ length: clipCount }, (_, index) => ({
            id: `action_${index}`,
            text: `line ${index}`,
          })),
        ),
      ],
      undefined,
      (progress) => {
        heartbeats.push({ ...progress, at: Date.now() });
      },
    );

    expect(coverage).toEqual({ written: clipCount, total: clipCount });
    expect(
      startedAt.map((time, index) => (index === 0 ? 0 : time - startedAt[index - 1]!)),
    ).toEqual([
      0, 2000, 4000, 8000, 15000, 7500, 3750, 1875, 937, 468, 234, 117, 58, 29, 14, 7, 3, 1, 0, 0,
    ]);
    expect(heartbeats.map((beat) => beat.written)).toEqual(
      Array.from({ length: clipCount }, (_, index) => index + 1),
    );
    expect(heartbeats.every((beat) => beat.total === clipCount)).toBe(true);
    // classroom-job-store fails a running job after 30 minutes without updatedAt.
    // Heartbeats are what move that timestamp while clips are still being paced.
    const staleWindowMs = 30 * 60 * 1000;
    const marks = [started, ...heartbeats.map((beat) => beat.at)];
    for (let index = 1; index < marks.length; index += 1) {
      expect(marks[index]! - marks[index - 1]!).toBeLessThan(staleWindowMs);
    }
    expect(heartbeats.length).toBe(clipCount);
  });

  it('skips only the current clip when Retry-After exceeds the remaining back-off budget', async () => {
    vi.stubEnv('TTS_MIN_INTERVAL_MS', '0');
    vi.stubEnv('TTS_BACKOFF_BUDGET_MS', '5000');
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded', 60_000);
      }
      return { audio: CLIP, format: 'mp3' };
    });
    const scene = speechScene([
      { id: 'action_0', text: 'huge retry' },
      { id: 'action_1', text: 'still tried' },
    ]);

    const coverage = await runClassroomTts([scene]);

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBe(2000);
    expect(coverage).toEqual({ written: 1, total: 2 });
    expect(speechAction(scene, 'action_0')?.audioId).toBeUndefined();
    expect(speechAction(scene, 'action_1')?.audioId).toBe('tts_s2_action_1');
    expect(ttsMocks.generateTTS).toHaveBeenCalledTimes(2);
    expect(
      logLines.some((line) =>
        line.includes(
          'TTS Retry-After 60000ms exceeds remaining back-off budget for tts_s2_action_0; leaving this clip silent',
        ),
      ),
    ).toBe(true);
    expect(logLines.some((line) => line.includes('leaving remaining speech silent'))).toBe(false);
    expect(logLines.some((line) => line.includes('TTS back-off budget exhausted'))).toBe(false);
  });

  it('gives up after 5 rate-limit retries and still narrates the next action', async () => {
    const { TTSRateLimitError } = await loadClassroomTts();
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length <= 6) {
        throw new TTSRateLimitError('MiniMax', 'rate limit exceeded');
      }
      return { audio: CLIP, format: 'mp3' };
    });
    const scene = speechScene([
      { id: 'action_0', text: 'lost' },
      { id: 'action_1', text: 'kept' },
    ]);

    const coverage = await runClassroomTts([scene]);

    expect(startedAt).toHaveLength(7);
    expect(
      startedAt.map((time, index) => (index === 0 ? 0 : time - startedAt[index - 1]!)),
    ).toEqual([0, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(coverage).toEqual({ written: 1, total: 2 });
    expect(speechAction(scene, 'action_0')?.audioId).toBeUndefined();
    expect(speechAction(scene, 'action_1')?.audioId).toBe('tts_s2_action_1');
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(
      logLines.some((line) =>
        line.includes('TTS generation INCOMPLETE: 1 written, 1 speech actions left silent'),
      ),
    ).toBe(true);
    expect(logLines.some((line) => line.includes('retries exhausted'))).toBe(true);
    expect(logLines.some((line) => line.includes('(retry 6/5)'))).toBe(false);
  });

  it('does not retry or widen spacing for a generic error that mentions 1002', async () => {
    const startedAt: number[] = [];
    ttsMocks.generateTTS.mockImplementation(async () => {
      startedAt.push(Date.now());
      if (startedAt.length === 1) {
        throw new Error(
          'MiniMax TTS error: No audio returned. Response: {"base_resp":{"status_code":1002,"status_msg":"rate limit exceeded(RPM)"}}',
        );
      }
      return { audio: CLIP, format: 'mp3' };
    });
    const scene = speechScene([
      { id: 'action_0', text: 'generic failure' },
      { id: 'action_1', text: 'continues' },
    ]);

    const coverage = await runClassroomTts([scene]);

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBe(1000);
    expect(coverage).toEqual({ written: 1, total: 2 });
    expect(logLines.some((line) => line.includes('widening spacing'))).toBe(false);
    expect(
      logLines.some((line) =>
        line.includes('TTS generation INCOMPLETE: 1 written, 1 speech actions left silent'),
      ),
    ).toBe(true);
  });

  it('reports zero coverage when TTS is enabled but no server provider is configured', async () => {
    vi.stubEnv('TTS_MINIMAX_API_KEY', '');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    vi.resetModules();

    const coverage = await runClassroomTts([speechScene([{ id: 'action_0', text: 'silent' }])]);

    expect(coverage).toEqual({ written: 0, total: 1 });
    expect(ttsMocks.generateTTS).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(logLines.some((line) => line.includes('TTS generation complete'))).toBe(false);
    expect(
      logLines.some((line) =>
        line.includes('TTS generation INCOMPLETE: 0 written, 1 speech actions left silent'),
      ),
    ).toBe(true);
  });

  it('counts a generated run after the provider speech split', async () => {
    vi.stubEnv('TTS_MINIMAX_API_KEY', '');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    vi.stubEnv('TTS_GLM_API_KEY', 'test-glm-key');
    vi.stubEnv('TTS_GLM_ENABLED', 'true');
    vi.resetModules();
    ttsMocks.generateTTS.mockResolvedValue({ audio: CLIP, format: 'mp3' });
    const long = '句子。'.repeat(400);
    const scene = speechScene([{ id: 'action_0', text: long }]);
    const { splitLongSpeechActions } = await import('@/lib/audio/tts-utils');
    const expected = splitLongSpeechActions(
      [{ id: 'action_0', type: 'speech', text: long } as never],
      'glm-tts',
    ).length;

    const coverage = await runClassroomTts([scene]);

    expect(expected).toBeGreaterThan(1);
    expect(coverage).toEqual({ written: expected, total: expected });
    expect(ttsMocks.generateTTS).toHaveBeenCalledTimes(expected);
    expect(scene.actions?.filter((action) => action.type === 'speech')).toHaveLength(expected);
  });

  it('counts a skipped provider run with the same post-split total', async () => {
    vi.stubEnv('TTS_MINIMAX_API_KEY', '');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    vi.stubEnv('TTS_GLM_API_KEY', 'test-glm-key');
    vi.stubEnv('TTS_GLM_ENABLED', 'true');
    vi.resetModules();
    const providerConfig = await import('@/lib/server/provider-config');
    vi.spyOn(providerConfig, 'resolveTTSApiKey').mockReturnValue('');
    const long = '句子。'.repeat(400);
    const scene = speechScene([{ id: 'action_0', text: long }]);
    const { splitLongSpeechActions } = await import('@/lib/audio/tts-utils');
    const expected = splitLongSpeechActions(
      [{ id: 'action_0', type: 'speech', text: long } as never],
      'glm-tts',
    ).length;

    const coverage = await runClassroomTts([scene]);

    expect(expected).toBeGreaterThan(1);
    expect(coverage).toEqual({ written: 0, total: expected });
    expect(ttsMocks.generateTTS).not.toHaveBeenCalled();
    expect(scene.actions?.filter((action) => action.type === 'speech')).toHaveLength(expected);
    expect(
      logLines.some((line) =>
        line.includes(
          `TTS generation INCOMPLETE: 0 written, ${expected} speech actions left silent`,
        ),
      ),
    ).toBe(true);
  });

  it('counts an unconfigured TTS skip from the stored speech actions', async () => {
    vi.stubEnv('TTS_MINIMAX_API_KEY', '');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    vi.resetModules();
    const scene = speechScene([{ id: 'action_0', text: '句子。'.repeat(400) }]);

    const coverage = await runClassroomTts([scene]);

    expect(coverage).toEqual({ written: 0, total: 1 });
    expect(scene.actions?.filter((action) => action.type === 'speech')).toHaveLength(1);
    expect(ttsMocks.generateTTS).not.toHaveBeenCalled();
  });
});
