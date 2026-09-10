import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import { buildCourseAudioAndDeckTools } from '@/lib/server/agent-runtime/course-edit/tools';
import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: () => 'sk-test',
  resolveTTSBaseUrl: () => 'https://gw.example.com/v1',
  resolveTTSModel: () => '',
}));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

/**
 * A provider transport that never settles on its own: it only rejects when the
 * request's AbortSignal aborts (the per-request timeout or the caller's
 * cancel), which is exactly how a real hung fetch behaves once the request
 * carries the signal. Records every request signal so tests can assert the
 * underlying request was actually aborted.
 */
function hungTransport(captured: AbortSignal[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const signal = (init as RequestInit | undefined)?.signal;
    if (signal) captured.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}

function makeStore(doc: CourseDocument | null): CourseStore {
  return {
    loadDocument: vi.fn(async () => doc),
    putScene: vi.fn(async () => {}),
    saveDocument: vi.fn(async () => {}),
  } as unknown as CourseStore;
}

function courseDoc(): CourseDocument {
  return {
    stage: { id: 'stage-a', name: 'A', generatedAgentConfigs: [] },
    scenes: [structuredClone(scene)],
  } as unknown as CourseDocument;
}

describe('TTS abort propagation and per-request timeout', () => {
  beforeEach(() => {
    mocks.providers.mockReset();
    mocks.persist.mockReset();
    mocks.providers.mockReturnValue({ 'openai-tts': { disabled: false } });
    mocks.persist.mockResolvedValue('https://openmaic.test/audio.mp3');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects at the per-request timeout with the retryable error when the provider hangs', async () => {
    const previous = process.env.TTS_REQUEST_TIMEOUT_MS;
    process.env.TTS_REQUEST_TIMEOUT_MS = '80';
    const captured: AbortSignal[] = [];
    const transport = hungTransport(captured);
    try {
      const error = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: false,
      }).catch((err: unknown) => err);

      // The hung provider fails the tool call with a clear retryable error
      // instead of wedging the session.
      expect(error).toBeInstanceOf(TTSRequestTimeoutError);
      expect(String(error)).toContain('timed out');
      expect(String(error)).toContain('Retry the tool call');
      expect(mocks.persist).not.toHaveBeenCalled();
      // The underlying request was aborted by the timeout bound.
      expect(captured).toHaveLength(1);
      expect(captured[0]?.aborted).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TTS_REQUEST_TIMEOUT_MS;
      else process.env.TTS_REQUEST_TIMEOUT_MS = previous;
      transport.mockRestore();
    }
  });

  it('aborts the in-flight provider request and rejects when the caller signal aborts', async () => {
    const captured: AbortSignal[] = [];
    const transport = hungTransport(captured);
    const controller = new AbortController();

    const promise = synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      signal: controller.signal,
    });

    // Wait until the provider request is actually in flight, then cancel.
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(captured[0]?.aborted).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
    transport.mockRestore();
  });

  it('generate_tts returns the interrupted shape when cancelled mid-synthesis', async () => {
    const captured: AbortSignal[] = [];
    const transport = hungTransport(captured);
    const store = makeStore(courseDoc());
    const tools = buildCourseAudioAndDeckTools({
      store,
      onCheckpoint: vi.fn(),
    } as never);
    const generateTts = tools.find((tool) => tool.name === 'generate_tts');
    if (!generateTts) throw new Error('generate_tts not registered');

    const controller = new AbortController();
    const promise = generateTts.execute(
      'call-1',
      { stageId: 'stage-a', order: 1 } as never,
      controller.signal,
    );

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    controller.abort();

    // The tool call does not hang and does not report success: it surfaces the
    // interrupted shape, which pi turns into the error tool result the runner
    // persists as "This tool call was interrupted".
    await expect(promise).rejects.toThrow(/aborted/i);
    expect(captured[0]?.aborted).toBe(true);
    transport.mockRestore();
  });
});
