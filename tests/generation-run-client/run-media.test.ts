import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
  },
}));

import {
  applyRunMedia,
  mediaTaskOfRun,
  registerRunMediaRetry,
} from '@/lib/generation-run-client/run-media';
import { resolveMediaRef } from '@/lib/media/resolve-media-ref';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const stageId = 'stage-run-media';

beforeEach(() => useMediaGenerationStore.setState({ tasks: {} }));
afterEach(() => useMediaGenerationStore.setState({ tasks: {} }));

describe('a run’s media in the classroom', () => {
  it('renders each run state the way the classroom renders its own tasks', () => {
    const at = (state: Parameters<typeof mediaTaskOfRun>[2]) =>
      resolveMediaRef('gen_img_1', mediaTaskOfRun(stageId, 'gen_img_1', state, undefined));
    expect(at({ mediaType: 'image', status: 'pending', seq: 1 })).toEqual({ kind: 'pending' });
    expect(at({ mediaType: 'image', status: 'generating', seq: 1 })).toEqual({ kind: 'pending' });
    expect(at({ mediaType: 'image', status: 'disabled', seq: 1 })).toEqual({ kind: 'disabled' });
    expect(at({ mediaType: 'image', status: 'failed', message: 'x', seq: 1 })).toEqual({
      kind: 'failed',
      retryable: true,
    });
    expect(
      at({
        mediaType: 'image',
        status: 'failed',
        errorCode: 'CONTENT_SENSITIVE',
        message: 'x',
        seq: 1,
      }),
    ).toEqual({ kind: 'failed', retryable: false });
    // Done names the allocated asset, which the renderers lease.
    expect(
      mediaTaskOfRun(
        stageId,
        'gen_img_1',
        { mediaType: 'image', status: 'done', assetId: 'asset-1', seq: 1 },
        undefined,
      ),
    ).toMatchObject({ status: 'done', objectUrl: 'asset-1' });
  });

  it('mirrors the run into the media store', () => {
    applyRunMedia(stageId, {
      gen_img_1: { mediaType: 'image', status: 'generating', seq: 1 },
      gen_vid_1: { mediaType: 'video', status: 'failed', message: 'timeout', seq: 2 },
    });
    const tasks = useMediaGenerationStore.getState().tasks;
    expect(tasks.gen_img_1).toMatchObject({ status: 'generating', stageId, type: 'image' });
    expect(tasks.gen_vid_1).toMatchObject({ status: 'failed', error: 'timeout', type: 'video' });
  });

  it('sends Retry to the run, not to a provider', async () => {
    const retry = vi.fn(async () => {});
    const unregister = registerRunMediaRetry(stageId, retry);
    applyRunMedia(stageId, {
      gen_img_1: { mediaType: 'image', status: 'failed', message: 'x', seq: 1 },
    });
    await retryMediaTask('gen_img_1');
    expect(retry).toHaveBeenCalledWith('gen_img_1');
    expect(useMediaGenerationStore.getState().tasks.gen_img_1?.status).toBe('pending');

    // A refused command puts the failure back.
    retry.mockRejectedValueOnce(new Error('conflict'));
    applyRunMedia(stageId, {
      gen_img_1: { mediaType: 'image', status: 'failed', message: 'x', seq: 3 },
    });
    await retryMediaTask('gen_img_1');
    expect(useMediaGenerationStore.getState().tasks.gen_img_1?.status).toBe('failed');

    // A failure Retry cannot change is not retried.
    retry.mockClear();
    applyRunMedia(stageId, {
      gen_img_2: { mediaType: 'image', status: 'failed', errorCode: 'CONTENT_SENSITIVE', seq: 4 },
    });
    await retryMediaTask('gen_img_2');
    expect(retry).not.toHaveBeenCalled();
    unregister();
  });
});
