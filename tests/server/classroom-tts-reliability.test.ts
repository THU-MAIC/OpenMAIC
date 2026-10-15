import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  generateTTS: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/lib/audio/tts-providers', () => ({
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) =>
        p.endsWith('server-providers.yml') ? false : actual.existsSync(p),
    },
    promises: {
      ...actual.promises,
      mkdir: mocks.mkdir,
      writeFile: mocks.writeFile,
    },
  };
});

const prefixes = [
  'TTS_OPENAI',
  'TTS_AZURE',
  'TTS_GLM',
  'TTS_QWEN',
  'TTS_VOXCPM',
  'TTS_DOUBAO',
  'TTS_ELEVENLABS',
  'TTS_MINIMAX',
  'TTS_LEMONADE',
  'TTS_BROWSER_NATIVE',
];
function scenes(texts: unknown[] = ['第一段讲解', '第二段讲解']): Scene[] {
  return [
    {
      id: 'scene-1',
      stageId: 'classroom-test',
      type: 'slide',
      order: 1,
      title: 'Test',
      actions: texts.map((text, i) => ({
        id: `speech-${i + 1}`,
        type: 'speech',
        text,
      })),
      content: { type: 'slide', canvas: { id: 'canvas-test', elements: [] } },
    },
  ] as unknown as Scene[];
}
// An inert PCM WAV fixture; it is not evidence of real provider speech synthesis.
function wavFixture(): Uint8Array {
  const bytes = new Uint8Array(92);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
function configure(prefix = 'TTS_OPENAI', model = 'operator-pinned-model') {
  vi.stubEnv(`${prefix}_API_KEY`, 'test-only-key');
  vi.stubEnv(`${prefix}_MODELS`, model);
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  for (const prefix of prefixes)
    for (const suffix of ['API_KEY', 'BASE_URL', 'MODELS', 'ENABLED'])
      vi.stubEnv(`${prefix}_${suffix}`, '');
  vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', '');
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.generateTTS.mockResolvedValue({ audio: wavFixture(), format: 'wav' });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('External requests are forbidden in this test');
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native classroom required speech audio', () => {
  test('uses actual server model resolution and reports all successful speech assets', async () => {
    configure();
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const first = input[0].actions?.[0];
    if (first?.type === 'speech') first.audioInvalidated = true;
    const report = await generateTTSForClassroom(input, 'classroom-test', 'http://localhost', {
      required: true,
    });
    expect(report).toMatchObject({
      status: 'completed',
      ready: true,
      required: true,
      inputSpeechCount: 2,
      total: 2,
      succeeded: 2,
      failed: 0,
      modelId: 'operator-pinned-model',
      failures: [],
    });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(2);
    expect(mocks.generateTTS.mock.calls[0][0]).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'operator-pinned-model',
      voice: 'alloy',
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveProperty('audioInvalidated');
    expect(input[0].actions?.map((a) => (a.type === 'speech' ? a.audioId : ''))).toEqual([
      'tts_s1_speech-1',
      'tts_s1_speech-2',
    ]);
    expect(JSON.stringify(report)).not.toContain('test-only-key');
    expect(JSON.stringify(report)).not.toContain('第一段讲解');
  });

  test('required mode cannot claim readiness with no configured or only force-disabled server providers', async () => {
    for (const disabled of [false, true]) {
      if (disabled) {
        configure();
        vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
      }
      vi.resetModules();
      const { generateTTSForClassroom, ClassroomTTSGenerationError } =
        await import('@/lib/server/classroom-media-generation');
      const result = await generateTTSForClassroom(
        scenes(['旁白']),
        'classroom-test',
        'http://localhost',
        { required: true },
      ).catch((error) => error);
      expect(result).toBeInstanceOf(ClassroomTTSGenerationError);
      expect(result.report).toMatchObject({
        ready: false,
        total: 1,
        succeeded: 0,
        failed: 1,
        reason: 'provider-unavailable',
      });
    }
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test('ordinary optional classrooms receive an honest unavailable report without changing graceful degradation', async () => {
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const report = await generateTTSForClassroom(
      scenes(['旁白']),
      'classroom-test',
      'http://localhost',
    );
    expect(report).toMatchObject({
      status: 'unavailable',
      ready: false,
      required: false,
      total: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  test('does not select a disabled provider or silently substitute its model', async () => {
    configure();
    vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
    configure('TTS_GLM', 'operator-glm-model');
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const report = await generateTTSForClassroom(
      scenes(['旁白']),
      'classroom-test',
      'http://localhost',
      { required: true },
    );
    expect(report.providerId).toBe('glm-tts');
    expect(mocks.generateTTS.mock.calls[0][0]).toMatchObject({
      providerId: 'glm-tts',
      modelId: 'operator-glm-model',
    });
  });

  test('Qwen operator pins use the existing resolver and disallowed catalog/clone combinations fail before a request', async () => {
    configure('TTS_QWEN', 'qwen3-tts-flash-2025-11-27');
    let media = await import('@/lib/server/classroom-media-generation');
    await media.generateTTSForClassroom(scenes(['旁白']), 'classroom-test', 'http://localhost', {
      required: true,
    });
    expect(mocks.generateTTS.mock.calls[0][0]).toMatchObject({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash-2025-11-27',
      voice: 'Cherry',
    });
    mocks.generateTTS.mockClear();
    vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', 'operator-clone');
    vi.stubEnv('TTS_QWEN_MODELS', 'operator-clone');
    vi.resetModules();
    media = await import('@/lib/server/classroom-media-generation');
    const error = await media
      .generateTTSForClassroom(scenes(['旁白']), 'classroom-test', 'http://localhost', {
        required: true,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(media.ClassroomTTSGenerationError);
    expect(error.report.reason).toBe('model-unavailable');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  test('one failed request prevents required readiness while counting all remaining speech and omitting private errors', async () => {
    configure();
    mocks.generateTTS.mockRejectedValueOnce(
      new Error('private-voice-sample student-name test-only-key'),
    );
    const { generateTTSForClassroom, ClassroomTTSGenerationError } =
      await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const error = await generateTTSForClassroom(input, 'classroom-test', 'http://localhost', {
      required: true,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ClassroomTTSGenerationError);
    expect(error.report).toMatchObject({
      status: 'partial',
      ready: false,
      total: 2,
      succeeded: 1,
      failed: 1,
      reason: 'incomplete',
    });
    expect(error.report.failures).toEqual([
      { sceneId: 'scene-1', actionId: 'speech-1', reason: 'synthesis-failed' },
    ]);
    expect(mocks.generateTTS).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.report)).not.toContain('private-voice-sample');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('student-name');
    expect(input[0].actions?.[0]).not.toHaveProperty('audioId');
    expect(input[0].actions?.[1]).toHaveProperty('audioId');
  });

  test('empty audio and failed persistence are not counted as successful speech assets', async () => {
    configure();
    mocks.generateTTS.mockResolvedValueOnce({
      audio: new Uint8Array(),
      format: 'mp3',
    });
    mocks.writeFile.mockRejectedValueOnce(new Error('private disk details'));
    const { generateTTSForClassroom, ClassroomTTSGenerationError } =
      await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const error = await generateTTSForClassroom(input, 'classroom-test', 'http://localhost', {
      required: true,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ClassroomTTSGenerationError);
    expect(error.report).toMatchObject({
      ready: false,
      total: 2,
      succeeded: 0,
      failed: 2,
    });
    expect(error.report.failures.map((f: { reason: string }) => f.reason)).toEqual([
      'empty-audio',
      'storage-failed',
    ]);
    expect(input[0].actions?.every((a) => !('audioId' in a))).toBe(true);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private disk details');
  });

  test('non-empty provider JSON or text cannot masquerade as required speech audio', async () => {
    configure();
    mocks.generateTTS.mockResolvedValueOnce({
      audio: new TextEncoder().encode('{"error":"private provider text"}'),
      format: 'mp3',
    });
    const media = await import('@/lib/server/classroom-media-generation');
    const error = await media
      .generateTTSForClassroom(scenes(['旁白']), 'classroom-test', 'http://localhost', {
        required: true,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(media.ClassroomTTSGenerationError);
    expect(error.report).toMatchObject({
      ready: false,
      succeeded: 0,
      failed: 1,
    });
    expect(error.report.failures[0].reason).toBe('invalid-audio');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(error.report)).not.toContain('private provider text');
  });

  test('unavailable storage fails before paid synthesis and invalid speech is never stringified', async () => {
    configure();
    mocks.mkdir.mockRejectedValueOnce(new Error('private path'));
    const media = await import('@/lib/server/classroom-media-generation');
    const storageError = await media
      .generateTTSForClassroom(scenes(['旁白']), 'classroom-test', 'http://localhost', {
        required: true,
      })
      .catch((e) => e);
    expect(storageError.report).toMatchObject({
      ready: false,
      failed: 1,
      reason: 'storage-unavailable',
    });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    const invalidError = await media
      .generateTTSForClassroom(
        scenes([{ private: 'student-info' }]),
        'classroom-test',
        'http://localhost',
        { required: true },
      )
      .catch((e) => e);
    expect(invalidError.report.failures[0].reason).toBe('invalid-speech');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(JSON.stringify(invalidError.report)).not.toContain('student-info');
  });

  test('prepare speech splitting before factual review and synthesize the exact prepared actions without further text changes', async () => {
    configure('TTS_GLM', 'operator-glm-model');
    const media = await import('@/lib/server/classroom-media-generation');
    const input = scenes(['甲'.repeat(1024) + '乙']);
    media.prepareClassroomSpeechForTTS(input);
    const prepared = input[0].actions?.map((a) => ({
      id: a.id,
      text: a.type === 'speech' ? a.text : '',
    }));
    expect(prepared).toHaveLength(2);
    const report = await media.generateTTSForClassroom(
      input,
      'classroom-test',
      'http://localhost',
      { required: true },
    );
    expect(report).toMatchObject({
      total: 2,
      succeeded: 2,
      failed: 0,
      ready: true,
    });
    expect(
      input[0].actions?.map((a) => ({
        id: a.id,
        text: a.type === 'speech' ? a.text : '',
      })),
    ).toEqual(prepared);
    expect(mocks.generateTTS.mock.calls.map((call) => call[1])).toEqual(
      prepared?.map((a) => a.text),
    );
  });

  test('required empty narration and VoxCPM auto voice cannot be reported as ready', async () => {
    const media = await import('@/lib/server/classroom-media-generation');
    const empty = await media
      .generateTTSForClassroom(scenes([]), 'classroom-test', 'http://localhost', { required: true })
      .catch((e) => e);
    expect(empty.report).toMatchObject({
      ready: false,
      total: 0,
      reason: 'no-speech',
    });
    configure('TTS_VOXCPM', 'voxcpm-vllm');
    vi.resetModules();
    const configured = await import('@/lib/server/classroom-media-generation');
    const noVoice = await configured
      .generateTTSForClassroom(scenes(['旁白']), 'classroom-test', 'http://localhost', {
        required: true,
      })
      .catch((e) => e);
    expect(noVoice.report.reason).toBe('voice-context-required');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });
});

describe('native classroom batch cancellation and budget', () => {
  test('a cancelled caller stops before any synthesis or disk work', async () => {
    configure();
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    const media = await import('@/lib/server/classroom-media-generation');
    const error = await media
      .generateTTSForClassroom(scenes(), 'classroom-test', 'http://localhost', {
        required: true,
        signal: controller.signal,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(media.ClassroomTTSGenerationError);
    expect(error.report).toMatchObject({
      ready: false,
      total: 2,
      succeeded: 0,
      failed: 2,
      reason: 'cancelled',
    });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test('the actual in-flight synthesis signal aborts and no remaining speech is requested or stored', async () => {
    configure();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    mocks.generateTTS.mockImplementationOnce((config: { signal?: AbortSignal }) => {
      requestSignal = config.signal;
      return new Promise((_resolve, reject) =>
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        }),
      );
    });
    const media = await import('@/lib/server/classroom-media-generation');
    const result = media
      .generateTTSForClassroom(scenes(), 'classroom-test', 'http://localhost', {
        required: true,
        signal: controller.signal,
      })
      .catch((e) => e);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    const error = await result;
    expect(error).toBeInstanceOf(media.ClassroomTTSGenerationError);
    expect(requestSignal?.aborted).toBe(true);
    expect(error.report).toMatchObject({
      ready: false,
      succeeded: 0,
      failed: 2,
      reason: 'cancelled',
    });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test('cancellation after synthesis wins before writing audio or starting the next paid request', async () => {
    configure();
    const controller = new AbortController();
    mocks.generateTTS.mockImplementationOnce(async () => {
      controller.abort(new DOMException('Caller cancelled', 'AbortError'));
      return { audio: wavFixture(), format: 'wav' };
    });
    const media = await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const error = await media
      .generateTTSForClassroom(input, 'classroom-test', 'http://localhost', {
        required: true,
        signal: controller.signal,
      })
      .catch((e) => e);
    expect(error.report).toMatchObject({
      ready: false,
      succeeded: 0,
      failed: 2,
      reason: 'cancelled',
    });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(input[0].actions?.every((a) => !('audioId' in a))).toBe(true);
  });

  test('the disk write receives the same budget signal and cancellation cannot publish audio references', async () => {
    configure();
    const controller = new AbortController();
    let writeSignal: AbortSignal | undefined;
    mocks.writeFile.mockImplementationOnce(
      async (_file: string, _data: Uint8Array, options: { signal?: AbortSignal }) => {
        writeSignal = options.signal;
        controller.abort(new DOMException('Caller cancelled', 'AbortError'));
      },
    );
    const media = await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const error = await media
      .generateTTSForClassroom(input, 'classroom-test', 'http://localhost', {
        required: true,
        signal: controller.signal,
      })
      .catch((e) => e);
    expect(writeSignal).toBe(mocks.generateTTS.mock.calls[0][0].signal);
    expect(writeSignal?.aborted).toBe(true);
    expect(error.report).toMatchObject({ ready: false, succeeded: 0, failed: 2 });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(input[0].actions?.every((a) => !('audioId' in a))).toBe(true);
  });

  test('one bounded local budget aborts the real request signal and caller cancellation takes priority', async () => {
    configure();
    const local = new AbortController();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => local.signal);
    let requestSignal: AbortSignal | undefined;
    mocks.generateTTS.mockImplementationOnce((config: { signal?: AbortSignal }) => {
      requestSignal = config.signal;
      return new Promise((_resolve, reject) =>
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        }),
      );
    });
    const media = await import('@/lib/server/classroom-media-generation');
    const result = media
      .generateTTSForClassroom(scenes(), 'classroom-test', 'http://localhost', {
        required: true,
        signal: caller.signal,
        timeoutMs: 999999999,
      })
      .catch((e) => e);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    local.abort(new DOMException('Local budget expired', 'TimeoutError'));
    caller.abort(new DOMException('Caller cancelled', 'AbortError'));
    const error = await result;
    expect(timeout).toHaveBeenCalledWith(180000);
    expect(requestSignal?.aborted).toBe(true);
    expect(error.report).toMatchObject({ ready: false, failed: 2, reason: 'cancelled' });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test('the required batch deadline alone aborts the in-flight request and accounts for unstarted speech', async () => {
    configure();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline.signal);
    let requestSignal: AbortSignal | undefined;
    mocks.generateTTS.mockImplementationOnce((config: { signal?: AbortSignal }) => {
      requestSignal = config.signal;
      return new Promise((_resolve, reject) =>
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        }),
      );
    });
    const media = await import('@/lib/server/classroom-media-generation');
    const input = scenes();
    const result = media
      .generateTTSForClassroom(input, 'classroom-test', 'http://localhost', { required: true })
      .catch((e) => e);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    deadline.abort(new DOMException('Batch budget expired', 'TimeoutError'));
    const error = await result;
    expect(timeout).toHaveBeenCalledWith(180000);
    expect(error).toBeInstanceOf(media.ClassroomTTSGenerationError);
    expect(requestSignal?.aborted).toBe(true);
    expect(error.report).toMatchObject({
      ready: false,
      total: 2,
      succeeded: 0,
      failed: 2,
      reason: 'timeout',
    });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(input[0].actions?.every((a) => !('audioId' in a))).toBe(true);
  });

  test('optional cancellation propagates as AbortError rather than a successful degraded report', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled', 'AbortError'));
    const media = await import('@/lib/server/classroom-media-generation');
    const error = await media
      .generateTTSForClassroom(scenes(), 'classroom-test', 'http://localhost', {
        signal: controller.signal,
      })
      .catch((e) => e);
    expect(error.name).toBe('AbortError');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  test('an explicitly empty model resolver cannot be replaced with a catalog model', async () => {
    configure();
    const providers = await import('@/lib/server/provider-config');
    vi.spyOn(providers, 'resolveTTSModel').mockReturnValue('');
    const media = await import('@/lib/server/classroom-media-generation');
    const error = await media
      .generateTTSForClassroom(scenes(), 'classroom-test', 'http://localhost', { required: true })
      .catch((e) => e);
    expect(error.report.reason).toBe('model-unavailable');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });
});
