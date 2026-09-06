/**
 * Browser-only mode must behave exactly as it did before any of this existed.
 *
 * The concurrency work — serial passes, awaiting a predecessor, the
 * document-based skip — is all for a durable, shared document, where an extra
 * provider call costs the operator money and an extra `putAsset` costs storage.
 * In browser-only mode the same overlap costs a duplicate download, which is
 * what the code has always done, so none of it applies. These tests pin the
 * three shapes the concurrency work touches — overlapping passes, a retry
 * during a pass, and an abort followed by a new pass — against that behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
  putAsset: vi.fn(),
  removeAsset: vi.fn(),
  serverBacked: vi.fn(),
  stageState: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: mocks.settings } }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: mocks.stageState } }));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { put: mocks.mediaPut, delete: mocks.mediaDelete } },
}));
vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.putAsset,
  removeAsset: mocks.removeAsset,
}));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

import {
  generateMediaForOutlines,
  resetMediaPassesForTests,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

const stageId = 'browser-stage';

function outlineWith(order: number, elementId: string, prompt: string): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: 'Scene',
    description: 'Scene',
    keyPoints: ['media'],
    order,
    mediaGenerations: [{ type: 'image', prompt, elementId }],
  } as SceneOutline;
}

describe('browser-only media orchestration is untouched', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let prompts: string[];

  beforeEach(() => {
    resetMediaPassesForTests();
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.putAsset.mockReset();
    mocks.removeAsset.mockReset();
    // The whole point: the seam is off.
    mocks.serverBacked.mockReset().mockReturnValue(false);
    mocks.stageState.mockReset().mockReturnValue({ stage: null, scenes: [] });
    mocks.settings.mockReset().mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'p',
      imageModelId: 'm',
      imageProvidersConfig: {},
      videoProviderId: 'p',
      videoModelId: 'm',
      videoProvidersConfig: {},
    });
    useMediaGenerationStore.setState({ tasks: {} });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });

    prompts = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        prompts.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt);
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetMediaPassesForTests();
    resetProxyMediaFailureCache();
    vi.unstubAllGlobals();
  });

  it('never reaches the pool, the document or the permission gate', async () => {
    await generateMediaForOutlines([outlineWith(1, 'gen_img_1', 'one')], stageId);

    expect(prompts).toEqual(['one']);
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks.gen_img_1?.status).toBe('done');
  });

  // No serialization: two passes run concurrently, exactly as before. The
  // second one skips on task status alone, which is the historical rule.
  it('skips an already-done element on task status, with no waiting', async () => {
    const outlines = [outlineWith(1, 'gen_img_1', 'one')];

    await generateMediaForOutlines(outlines, stageId);
    await generateMediaForOutlines(outlines, stageId);

    expect(prompts).toEqual(['one']);
  });

  it('skips a permanently failed element on task status', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'failed',
          prompt: 'one',
          params: {},
          errorCode: 'CONTENT_SENSITIVE',
          retryCount: 0,
          stageId,
        },
      },
    });

    await generateMediaForOutlines([outlineWith(1, 'gen_img_1', 'one')], stageId);

    expect(prompts).toEqual([]);
  });

  it('lets a Retry during a pass through, and finishes both', async () => {
    let releaseSecond: (() => void) | undefined;
    const secondInFlight = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(prompt);
        if (prompt === 'one' && prompts.filter((p) => p === 'one').length === 1) {
          return new Response(JSON.stringify({ success: false, error: 'transient' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (prompt === 'two') await secondInFlight;
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const pass = generateMediaForOutlines(
      [outlineWith(1, 'gen_img_1', 'one'), outlineWith(2, 'gen_img_2', 'two')],
      stageId,
    );
    for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
    expect(useMediaGenerationStore.getState().tasks.gen_img_1?.status).toBe('failed');

    const retried = retryMediaTask('gen_img_1');
    releaseSecond?.();
    await Promise.all([pass, retried]);

    expect(prompts.filter((prompt) => prompt === 'one')).toHaveLength(2);
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.values(tasks).some((task) => task.status === 'pending')).toBe(false);
    expect(Object.values(tasks).filter((task) => task.status === 'done')).toHaveLength(2);
  });

  // An abort here is not followed by any waiting, and the replacement collects
  // on task status alone — the elements the aborted pass never reached are
  // still `pending`, which is not a skip reason in this mode.
  it('collects the unreached elements of an aborted pass, without serializing', async () => {
    const outlines = [
      outlineWith(1, 'gen_img_1', 'one'),
      outlineWith(2, 'gen_img_2', 'two'),
      outlineWith(3, 'gen_img_3', 'three'),
    ];
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/generate/image') {
        prompts.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt);
        calls += 1;
        if (calls === 1) {
          await firstInFlight;
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        }
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/proxy-media') {
        return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const first = new AbortController();
    const pass1 = generateMediaForOutlines(outlines, stageId, first.signal).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    first.abort();
    const pass2 = generateMediaForOutlines(outlines, stageId).catch(() => undefined);

    releaseFirst?.();
    await Promise.all([pass1, pass2]);

    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.values(tasks).some((task) => task.status === 'pending')).toBe(false);
    expect(prompts).toContain('two');
    expect(prompts).toContain('three');
    expect(mocks.putAsset).not.toHaveBeenCalled();
  });
});
