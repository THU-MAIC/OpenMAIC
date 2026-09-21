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

async function runClassroomTts(scenes: Scene[]) {
  const { generateTTSForClassroom } = await loadClassroomTts();
  const pending = generateTTSForClassroom(scenes, 'cls-tts', 'http://localhost');
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

  it('uses a 1000ms default interval when TTS_MIN_INTERVAL_MS is unset', async () => {
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

    expect(startedAt[1]! - startedAt[0]!).toBe(1000);
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

  it('keeps the widened interval for later actions and resets the per-action retry count', async () => {
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
    expect(
      startedAt.map((time, index) => (index === 0 ? 0 : time - startedAt[index - 1]!)),
    ).toEqual([0, 2000, 2000, 4000]);
    expect(logLines.filter((line) => line.includes('(retry 1/5)')).length).toBe(2);
    expect(logLines.some((line) => line.includes('widening spacing to 4000ms (retry 1/5)'))).toBe(
      true,
    );
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

  it('returns undefined and skips synthesis when no server TTS provider is configured', async () => {
    vi.stubEnv('TTS_MINIMAX_API_KEY', '');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    vi.resetModules();

    const coverage = await runClassroomTts([speechScene([{ id: 'action_0', text: 'silent' }])]);

    expect(coverage).toBeUndefined();
    expect(ttsMocks.generateTTS).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(logLines.some((line) => line.includes('TTS generation complete'))).toBe(false);
    expect(logLines.some((line) => line.includes('TTS generation INCOMPLETE'))).toBe(false);
  });
});
