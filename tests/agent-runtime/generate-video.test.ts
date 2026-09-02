import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';

import {
  buildCourseAllowlist,
  buildDslCourseToolset,
} from '@/lib/server/agent-runtime/course-tools';
import { MAX_GENERATED_VIDEO_BYTES } from '@/lib/server/agent-runtime/generate-video';
import {
  clearPendingMediaTasks,
  getPendingMediaTask,
} from '@/lib/server/agent-runtime/pending-media';
import type { MediaReadyLifecycleData } from '@/lib/agent-runtime/lifecycle';

const mocks = vi.hoisted(() => ({
  recordGenerationUsage: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));
vi.mock('node:fs', () => ({ promises: { mkdir: mocks.mkdir, writeFile: mocks.writeFile } }));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));
vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.log }));

import {
  buildGenerateVideoTool,
  defaultPersistGeneratedVideo,
  GenerateVideoParams,
  patchStageVideoPlaceholder,
} from '@/lib/server/agent-runtime/generate-video';
import { makeDocument, makeSlideScene } from './_stage-fixtures';
import { createFakeDocumentStore } from './_fake-document-store';
import type { AppScene } from '@/lib/types/stage';

const providerConfig = {
  providerId: 'seedance' as const,
  apiKey: 'test-key',
  baseUrl: 'https://ark.cn-beijing.volces.com',
  model: 'doubao-seedance-1-5-pro-251215',
};

const configured = () => ({ seedance: { models: [providerConfig.model] } });

function courseDeps(overrides: Record<string, unknown> = {}) {
  return {
    store: {} as never,
    onCheckpoint: () => undefined,
    sessionId: 'session-owner',
    stageAccess: async () => ({ kind: 'owned' as const }),
    ...overrides,
  };
}

/** A provider promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ToolResult = {
  isError?: boolean;
  content: { text: string }[];
  details: Record<string, unknown>;
};

describe('generate_video tool', () => {
  beforeEach(() => {
    clearPendingMediaTasks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    clearPendingMediaTasks();
  });

  it('validates the provider-supported request shape', () => {
    expect(
      Check(GenerateVideoParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope rotating slowly',
        aspectRatio: '9:16',
        durationSec: 5,
        resolution: '720p',
      }),
    ).toBe(true);
    expect(Check(GenerateVideoParams, { stageId: 'stage-owner', prompt: '' })).toBe(false);
    expect(Check(GenerateVideoParams, { prompt: 'motion' })).toBe(false);
    expect(
      Check(GenerateVideoParams, {
        stageId: 'stage-owner',
        prompt: 'motion',
        resolution: '4k',
      }),
    ).toBe(false);
  });

  it('is absent from registration and the allowlist when no provider is configured', () => {
    const deps = courseDeps({
      getConfiguredVideoProviders: () => ({}),
      resolveVideoProviderConfig: () => providerConfig,
    });
    expect(buildDslCourseToolset(deps).map((tool) => tool.name)).not.toContain('generate_video');
    expect(buildCourseAllowlist(deps)).not.toContain('generate_video');
  });

  it('registers when a configured provider has its required API key', () => {
    const deps = courseDeps({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
    });
    expect(buildDslCourseToolset(deps).map((tool) => tool.name)).toContain('generate_video');
    expect(buildCourseAllowlist(deps)).toContain('generate_video');
  });

  it('fails loud when the server resolves no model for a model-bearing provider', async () => {
    const generateConfiguredVideo = vi.fn();
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: () => ({ seedance: { models: [] } }),
      resolveVideoProviderConfig: () => ({
        providerId: 'seedance',
        apiKey: 'test-key',
        model: undefined,
      }),
      generateConfiguredVideo,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no model is configured');
    expect(result.details.reason).toBe('missing-model');
    // Never a silent adapter default: the provider is not called, and no
    // background job is registered.
    expect(generateConfiguredVideo).not.toHaveBeenCalled();
  });

  it('returns immediately with a placeholder while the provider runs in the background', async () => {
    const providerCall = deferred<{
      url: string;
      duration: number;
      width: number;
      height: number;
    }>();
    const generateConfiguredVideo = vi.fn().mockReturnValue(providerCall.promise);
    const persistGeneratedVideo = vi.fn().mockResolvedValue({
      src: '/api/classroom-media/stage-owner/media/generated-abc.webm',
      mime: 'video/webm',
    });
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
      persistGeneratedVideo,
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A microscope rotating slowly',
      aspectRatio: '16:9',
      durationSec: 5,
      resolution: '720p',
    })) as ToolResult;

    // The tool call never awaited the still-pending provider promise.
    expect(result.isError).toBeUndefined();
    const ref = result.details.ref as string;
    expect(ref).toMatch(/^gen_vid_[\w-]+$/);
    expect(result.details).toEqual({ ref, stageId: 'stage-owner', status: 'generating' });
    expect(result.content[0].text).toContain('background');
    expect(result.content[0].text).toContain('patch_stage');
    // The job kicked off synchronously (provider called) and is registered.
    expect(generateConfiguredVideo).toHaveBeenCalledWith(
      providerConfig,
      expect.objectContaining({
        prompt: 'A microscope rotating slowly',
        aspectRatio: '16:9',
        duration: 5,
        resolution: '720p',
        stageId: 'stage-owner',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(getPendingMediaTask(ref)).toMatchObject({
      status: 'generating',
      stageId: 'stage-owner',
      sessionId: 'session-owner',
      provider: 'seedance',
    });
    // Nothing has completed yet: no persist, no event.
    expect(persistGeneratedVideo).not.toHaveBeenCalled();
    expect(emitMediaReady).not.toHaveBeenCalled();

    providerCall.resolve({
      url: 'https://cdn.example.com/generated/lesson.webm',
      duration: 5,
      width: 1280,
      height: 720,
    });
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));

    expect(persistGeneratedVideo).toHaveBeenCalledWith({
      result: expect.objectContaining({ url: 'https://cdn.example.com/generated/lesson.webm' }),
      stageId: 'stage-owner',
      signal: expect.any(AbortSignal),
    });
    // The completion event is provider-neutral, keyed by the placeholder ref.
    expect(emitMediaReady).toHaveBeenCalledWith('session-owner', {
      ref,
      stageId: 'stage-owner',
      status: 'done',
      src: '/api/classroom-media/stage-owner/media/generated-abc.webm',
      mime: 'video/webm',
      durationSec: 5,
    } satisfies MediaReadyLifecycleData);
    expect(getPendingMediaTask(ref)).toMatchObject({ status: 'done' });
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', unit: 'second', quantity: 5 }),
    );
    expect(mocks.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/call-1[\s\S]*provider=seedance/),
    );
  });

  it('patches the persisted page element carrying the placeholder when the job completes', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push(
      {
        id: 'el-video',
        type: 'video',
        left: 0,
        top: 0,
        width: 400,
        height: 225,
        // The agent patches the placeholder on AFTER the tool returns; seeded
        // below once the ref is known.
        mediaRef: 'gen_vid_pending',
      },
      {
        id: 'el-other',
        type: 'video',
        left: 0,
        top: 0,
        width: 400,
        height: 225,
        src: 'https://cdn.example.com/existing.mp4',
      },
    );
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));

    const providerCall = deferred<{
      url: string;
      duration: number;
      width: number;
      height: number;
    }>();
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      backgroundStore: fake.store,
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: vi.fn().mockReturnValue(providerCall.promise),
      persistGeneratedVideo: vi.fn().mockResolvedValue({
        src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
        mime: 'video/mp4',
      }),
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    const ref = result.details.ref as string;
    // The agent's follow-up patch_stage: the element now carries the ref.
    const seeded = fake.docs.get('stage-owner')!.scenes[0]!;
    const element = (seeded.content as { canvas: { elements: { mediaRef?: string }[] } }).canvas
      .elements[0]!;
    element.mediaRef = ref;

    providerCall.resolve({
      url: 'https://cdn.example.com/generated/lesson.mp4',
      duration: 4,
      width: 1280,
      height: 720,
    });
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));

    const persisted = await fake.store.getScene('stage-owner', 'scene-1');
    const elements = (persisted!.content as { canvas: { elements: unknown[] } }).canvas
      .elements as { id: string; src?: string; mediaRef?: string }[];
    // The placeholder element got the concrete src; the other video is untouched.
    expect(elements[0]).toMatchObject({
      id: 'el-video',
      mediaRef: ref,
      src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
    });
    expect(elements[1]).toMatchObject({
      id: 'el-other',
      src: 'https://cdn.example.com/existing.mp4',
    });
    expect(emitMediaReady).toHaveBeenCalledWith(
      'session-owner',
      expect.objectContaining({ ref, status: 'done' }),
    );
  });

  it('still reports done when the document patch fails after persist', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'el-video',
      type: 'video',
      mediaRef: 'gen_vid_pending',
    });
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));
    vi.spyOn(fake.store, 'putScene').mockRejectedValue(new Error('write failed'));

    const providerCall = deferred<{
      url: string;
      duration: number;
      width: number;
      height: number;
    }>();
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      backgroundStore: fake.store,
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: vi.fn().mockReturnValue(providerCall.promise),
      persistGeneratedVideo: vi.fn().mockResolvedValue({
        src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
        mime: 'video/mp4',
      }),
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    const ref = result.details.ref as string;
    // The agent's follow-up patch_stage: the element now carries the ref, so
    // the completion patch really attempts the (failing) write.
    const seeded = fake.docs.get('stage-owner')!.scenes[0]!;
    (
      seeded.content as { canvas: { elements: { mediaRef?: string }[] } }
    ).canvas.elements[0]!.mediaRef = ref;

    providerCall.resolve({
      url: 'https://cdn.example.com/generated/lesson.mp4',
      duration: 4,
      width: 1280,
      height: 720,
    });
    // The asset is persisted and downloadable: a patch failure is logged, not
    // rebranded as a generation failure.
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
    expect(emitMediaReady).toHaveBeenCalledWith(
      'session-owner',
      expect.objectContaining({ ref, status: 'done' }),
    );
    expect(getPendingMediaTask(ref)).toMatchObject({ status: 'done' });
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Document patch failed'),
      expect.any(Error),
    );
  });

  it('skips the document patch silently when nothing references the placeholder anymore', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));

    const providerCall = deferred<{
      url: string;
      duration: number;
      width: number;
      height: number;
    }>();
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      backgroundStore: fake.store,
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: vi.fn().mockReturnValue(providerCall.promise),
      persistGeneratedVideo: vi.fn().mockResolvedValue({
        src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
        mime: 'video/mp4',
      }),
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    providerCall.resolve({
      url: 'https://cdn.example.com/generated/lesson.mp4',
      duration: 4,
      width: 1280,
      height: 720,
    });
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));

    // No scene write happened, but the done event still carries the src.
    const persisted = await fake.store.getScene('stage-owner', 'scene-1');
    expect(
      (persisted!.content as { canvas: { elements: unknown[] } }).canvas.elements,
    ).toHaveLength(0);
    expect(emitMediaReady).toHaveBeenCalledWith(
      'session-owner',
      expect.objectContaining({
        ref: result.details.ref,
        status: 'done',
        src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
      }),
    );
  });

  it('emits a failed event when the provider errors in the background', async () => {
    const generateConfiguredVideo = vi.fn().mockRejectedValue(new Error('content rejected'));
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
      emitMediaReady,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    // The tool call itself succeeded — the failure arrives as an event.
    expect(result.isError).toBeUndefined();
    const ref = result.details.ref as string;

    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
    // The failure payload is provider-neutral: the raw provider message never
    // reaches the transcript; it stays in the server-side log correlated by
    // the tool-call id.
    expect(emitMediaReady).toHaveBeenCalledWith('session-owner', {
      ref,
      stageId: 'stage-owner',
      status: 'failed',
      errorCode: 'provider-or-storage-error',
    } satisfies MediaReadyLifecycleData);
    expect(getPendingMediaTask(ref)).toMatchObject({
      status: 'failed',
      errorCode: 'provider-or-storage-error',
    });
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/call-1[\s\S]*provider=seedance[\s\S]*content rejected/),
      expect.any(Error),
    );
  });

  it('emits a failed timeout event when the provider exceeds the job budget', async () => {
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: () => new Promise(() => undefined),
      emitMediaReady,
      timeoutMs: 5,
    });
    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    expect(result.isError).toBeUndefined();

    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
    expect(emitMediaReady).toHaveBeenCalledWith(
      'session-owner',
      expect.objectContaining({
        ref: result.details.ref,
        status: 'failed',
        errorCode: 'timeout',
      }),
    );
  });

  it('keeps the background job running when the caller signal aborts after the tool returned', async () => {
    const providerCall = deferred<{
      url: string;
      duration: number;
      width: number;
      height: number;
    }>();
    const emitMediaReady = vi.fn();
    const controller = new AbortController();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo: vi.fn().mockReturnValue(providerCall.promise),
      persistGeneratedVideo: vi.fn().mockResolvedValue({
        src: '/api/classroom-media/stage-owner/media/generated-abc.mp4',
        mime: 'video/mp4',
      }),
      emitMediaReady,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'motion' },
      controller.signal,
    )) as ToolResult;
    expect(result.isError).toBeUndefined();
    // A cancelled chat must not orphan a billable provider job: the detached
    // job runs on its own timeout signal and still completes.
    controller.abort();
    providerCall.resolve({
      url: 'https://cdn.example.com/generated/lesson.mp4',
      duration: 4,
      width: 1280,
      height: 720,
    });
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
    expect(emitMediaReady).toHaveBeenCalledWith(
      'session-owner',
      expect.objectContaining({ ref: result.details.ref, status: 'done' }),
    );
  });

  it('still refuses to start when the caller signal is already aborted', async () => {
    const generateConfiguredVideo = vi.fn();
    const tool = buildGenerateVideoTool({
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute('call-1', { stageId: 'stage-owner', prompt: 'motion' }, controller.signal),
    ).rejects.toThrow('aborted');
    expect(generateConfiguredVideo).not.toHaveBeenCalled();
  });

  it('materializes a provider download URL through classroom media', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from('real-video-bytes'), {
          headers: { 'content-type': 'video/quicktime' },
        }),
      ),
    );
    await expect(
      defaultPersistGeneratedVideo({
        result: {
          url: 'https://cdn.example.com/generated/lesson.mov',
          duration: 6,
          width: 1280,
          height: 720,
        },
        stageId: 'stage-owner',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      src: expect.stringMatching(
        /^\/api\/classroom-media\/stage-owner\/media\/generated-[a-f0-9]{64}\.mov$/,
      ),
      mime: 'video/quicktime',
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.mov$/),
      Buffer.from('real-video-bytes'),
    );
  });

  it('fails loud when the generated video exceeds the byte cap', async () => {
    // The declared content-length trips the cap before any body is buffered.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(MAX_GENERATED_VIDEO_BYTES + 1),
          },
        }),
      ),
    );
    await expect(
      defaultPersistGeneratedVideo({
        result: {
          url: 'https://cdn.example.com/generated/lesson.mp4',
          duration: 5,
          width: 1280,
          height: 720,
        },
        stageId: 'stage-owner',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`Download exceeded the ${MAX_GENERATED_VIDEO_BYTES}-byte response limit`);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not register when the only configured provider is force-disabled', () => {
    const deps = courseDeps({
      getConfiguredVideoProviders: () => ({ seedance: { disabled: true } }),
      resolveVideoProviderConfig: () => providerConfig,
    });
    // The capability gate resolves enabledness through the resolver: a
    // force-disabled provider never registers the tool (#665).
    expect(buildDslCourseToolset(deps).map((tool) => tool.name)).not.toContain('generate_video');
    expect(buildCourseAllowlist(deps)).not.toContain('generate_video');
  });

  it('skips a force-disabled provider in the selector even when it has a key', async () => {
    const generateConfiguredVideo = vi.fn().mockResolvedValue({
      url: 'https://cdn.example.com/generated/lesson.webm',
      duration: 5,
      width: 1280,
      height: 720,
    });
    const persistGeneratedVideo = vi.fn().mockResolvedValue({
      src: 'ast_generated-video',
      mime: 'video/webm',
    });
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      // seedance is force-disabled; kling is the only enabled entry, so the
      // selector must pick kling (#665).
      getConfiguredVideoProviders: () => ({
        seedance: { disabled: true, models: ['doubao-seedance-1-5-pro-251215'] },
        kling: { models: ['kling-v1-6'] },
      }),
      resolveVideoProviderConfig: () => ({
        providerId: 'kling',
        apiKey: 'test-key',
        baseUrl: 'https://api-beijing.klingai.com',
        model: 'kling-v1-6',
      }),
      generateConfiguredVideo,
      persistGeneratedVideo,
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(generateConfiguredVideo).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'kling' }),
      expect.anything(),
    );
    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
  });

  it('keeps provider identity and raw errors out of the completion event (server log only)', async () => {
    const generateConfiguredVideo = vi
      .fn()
      .mockRejectedValue(new Error('ark.cn-beijing.volces.com account suspended'));
    const emitMediaReady = vi.fn();
    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: configured,
      resolveVideoProviderConfig: () => providerConfig,
      generateConfiguredVideo,
      emitMediaReady,
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'motion',
    })) as ToolResult;
    expect(result.isError).toBeUndefined();

    await vi.waitFor(() => expect(emitMediaReady).toHaveBeenCalledTimes(1));
    const payload = emitMediaReady.mock.calls[0]![1] as MediaReadyLifecycleData;
    expect(payload.status).toBe('failed');
    expect(payload.errorCode).toBe('provider-or-storage-error');
    expect(JSON.stringify(payload)).not.toContain('seedance');
    expect(JSON.stringify(payload)).not.toContain('volces');
    // The provider id and the raw exception stay in the server-side log,
    // correlated by the tool-call id.
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/call-1[\s\S]*provider=seedance[\s\S]*account suspended/),
      expect.any(Error),
    );
  });
});

describe('patchStageVideoPlaceholder', () => {
  it('rewrites video elements addressing the placeholder via mediaRef or src', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push(
      { id: 'by-ref', type: 'video', mediaRef: 'gen_vid_abc' },
      { id: 'by-src', type: 'video', src: 'gen_vid_abc' },
      { id: 'other', type: 'video', src: 'https://cdn.example.com/x.mp4' },
      // The user swapped in their own concrete src while the job ran: the
      // stale mediaRef must not pull the generated video back over it.
      {
        id: 'user-swap',
        type: 'video',
        mediaRef: 'gen_vid_abc',
        src: 'https://cdn.example.com/user.mp4',
      },
      // Regeneration: the agent re-pointed mediaRef at a new job while the
      // element still carries the previous generated src — that one is
      // replaced (it would otherwise keep rendering the old video).
      {
        id: 'regenerated',
        type: 'video',
        mediaRef: 'gen_vid_abc',
        src: '/api/classroom-media/stage-owner/media/old.mp4',
      },
      // The classic pipeline persists the absolute form of the same URL.
      {
        id: 'regenerated-abs',
        type: 'video',
        mediaRef: 'gen_vid_abc',
        src: 'https://app.example.com/api/classroom-media/stage-owner/media/old.mp4',
      },
      // A user's pick copied from ANOTHER stage's generated media is theirs.
      {
        id: 'other-stage-pick',
        type: 'video',
        mediaRef: 'gen_vid_abc',
        src: '/api/classroom-media/other-stage/media/pick.mp4',
      },
      { id: 'empty-src', type: 'video', mediaRef: 'gen_vid_abc', src: '' },
      { id: 'img', type: 'image', src: 'gen_img_abc' },
    );
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));

    const patched = await patchStageVideoPlaceholder(
      fake.store,
      'stage-owner',
      'gen_vid_abc',
      '/api/classroom-media/stage-owner/media/v.mp4',
    );

    expect(patched).toBe(1);
    const persisted = await fake.store.getScene('stage-owner', 'scene-1');
    const elements = (persisted!.content as { canvas: { elements: unknown[] } }).canvas
      .elements as { id: string; src?: string }[];
    expect(elements[0]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
    expect(elements[1]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
    expect(elements[2]?.src).toBe('https://cdn.example.com/x.mp4');
    expect(elements[3]?.src).toBe('https://cdn.example.com/user.mp4');
    expect(elements[4]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
    expect(elements[5]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
    expect(elements[6]?.src).toBe('/api/classroom-media/other-stage/media/pick.mp4');
    expect(elements[7]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
    // Image placeholders belong to the (still synchronous) image flow.
    expect(elements[8]?.src).toBe('gen_img_abc');
  });

  it('applies the swap to the freshest scene so a concurrent edit survives', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'v',
      type: 'video',
      mediaRef: 'gen_vid_abc',
    });
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));

    // An unrelated edit lands after the candidate scan but before the write;
    // the patch must not resurrect the stale snapshot it was computed from.
    const originalLoad = fake.store.loadDocument.bind(fake.store);
    vi.spyOn(fake.store, 'loadDocument').mockImplementation(async (stageId: string) => {
      const doc = await originalLoad(stageId);
      const current = fake.docs.get('stage-owner');
      const edited = current?.scenes[0];
      if (current && edited) {
        fake.docs.set(
          'stage-owner',
          makeDocument('stage-owner', 'Course', [
            { ...edited, title: 'Edited meanwhile' } as AppScene,
          ]),
        );
      }
      return doc;
    });

    const patched = await patchStageVideoPlaceholder(
      fake.store,
      'stage-owner',
      'gen_vid_abc',
      '/api/classroom-media/stage-owner/media/v.mp4',
    );

    expect(patched).toBe(1);
    const persisted = await fake.store.getScene('stage-owner', 'scene-1');
    expect(persisted?.title).toBe('Edited meanwhile');
    const elements = (persisted!.content as { canvas: { elements: unknown[] } }).canvas
      .elements as { id: string; src?: string }[];
    expect(elements[0]?.src).toBe('/api/classroom-media/stage-owner/media/v.mp4');
  });

  it('does not resurrect a placeholder element removed by a concurrent edit', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', 'stage-owner', 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'v',
      type: 'video',
      mediaRef: 'gen_vid_abc',
    });
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', [scene]));

    // The element carrying the placeholder is deleted after the candidate
    // scan but before the write; the patch must skip, not resurrect it.
    const originalLoad = fake.store.loadDocument.bind(fake.store);
    vi.spyOn(fake.store, 'loadDocument').mockImplementation(async (stageId: string) => {
      const doc = await originalLoad(stageId);
      const current = fake.docs.get('stage-owner');
      const edited = current?.scenes[0];
      if (current && edited) {
        const content = edited.content as { canvas: { elements: unknown[] } };
        fake.docs.set(
          'stage-owner',
          makeDocument('stage-owner', 'Course', [
            {
              ...edited,
              content: { ...edited.content, canvas: { ...content.canvas, elements: [] } },
            } as unknown as AppScene,
          ]),
        );
      }
      return doc;
    });

    const patched = await patchStageVideoPlaceholder(
      fake.store,
      'stage-owner',
      'gen_vid_abc',
      '/api/classroom-media/stage-owner/media/v.mp4',
    );

    expect(patched).toBe(0);
    const persisted = await fake.store.getScene('stage-owner', 'scene-1');
    expect(
      (persisted!.content as { canvas: { elements: unknown[] } }).canvas.elements,
    ).toHaveLength(0);
  });

  it('returns 0 for a missing document or an unreferenced placeholder', async () => {
    const fake = createFakeDocumentStore();
    await expect(
      patchStageVideoPlaceholder(fake.store, 'missing', 'gen_vid_abc', '/x.mp4'),
    ).resolves.toBe(0);
    fake.docs.set('stage-owner', makeDocument('stage-owner', 'Course', []));
    await expect(
      patchStageVideoPlaceholder(fake.store, 'stage-owner', 'gen_vid_abc', '/x.mp4'),
    ).resolves.toBe(0);
  });
});
