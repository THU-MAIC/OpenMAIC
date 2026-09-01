import { beforeEach, describe, expect, it, vi } from 'vitest';

// The media generation store imports Dexie at module scope; the fold under
// test never touches it, so a stub is enough.
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { where: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { lookupMediaTask, resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';
import { resolveMediaRef } from '@/lib/media/resolve-media-ref';
import { applyMediaReadyFrame, parseMediaReadyFrame } from '@/lib/workbench/media-lifecycle';
import type { PPTVideoElement } from '@openmaic/dsl';

const REF = 'gen_vid_abc12345';

function videoElement(overrides: Record<string, unknown> = {}): PPTVideoElement {
  return {
    id: 'el-video',
    type: 'video',
    left: 0,
    top: 0,
    width: 400,
    height: 225,
    rotate: 0,
    mediaRef: REF,
    ...overrides,
  } as unknown as PPTVideoElement;
}

describe('media_ready client fold', () => {
  beforeEach(() => {
    useMediaGenerationStore.setState({ tasks: {} });
  });

  it('parses only well-formed frames', () => {
    expect(parseMediaReadyFrame(null)).toBeNull();
    expect(parseMediaReadyFrame({})).toBeNull();
    expect(parseMediaReadyFrame({ ref: REF, stageId: 'stage-1', status: 'generating' })).toBeNull();
    // A done frame without a src is useless — the ref would stay a skeleton.
    expect(parseMediaReadyFrame({ ref: REF, stageId: 'stage-1', status: 'done' })).toBeNull();
    expect(
      parseMediaReadyFrame({
        ref: REF,
        stageId: 'stage-1',
        status: 'failed',
        errorCode: 'timeout',
      }),
    ).toEqual({ ref: REF, stageId: 'stage-1', status: 'failed', errorCode: 'timeout' });
    expect(
      parseMediaReadyFrame({
        ref: REF,
        stageId: 'stage-1',
        status: 'done',
        src: '/api/classroom-media/stage-1/media/v.mp4',
        mime: 'video/mp4',
        durationSec: 5,
      }),
    ).toEqual({
      ref: REF,
      stageId: 'stage-1',
      status: 'done',
      src: '/api/classroom-media/stage-1/media/v.mp4',
      mime: 'video/mp4',
      durationSec: 5,
    });
  });

  it('a placeholder-only video element renders the skeleton even with no task in the store', () => {
    // This is what makes the whole flow work before any frame arrives: the
    // element patched with gen_vid_* never renders as a broken video.
    const binding = resolveVideoMediaForElement(
      useMediaGenerationStore.getState().tasks,
      videoElement(),
      'stage-1',
    );
    expect(binding.task).toBeUndefined();
    expect(resolveMediaRef(binding.sourceRef, binding.task).kind).toBe('placeholder');
  });

  it('a done frame upserts a placeholder-keyed task that resolves the element', () => {
    const frame = parseMediaReadyFrame({
      ref: REF,
      stageId: 'stage-1',
      status: 'done',
      src: '/api/classroom-media/stage-1/media/v.mp4',
      mime: 'video/mp4',
      durationSec: 5,
    });
    applyMediaReadyFrame(frame!);

    const task = lookupMediaTask(useMediaGenerationStore.getState().tasks, REF, 'stage-1');
    expect(task).toMatchObject({
      elementId: REF,
      type: 'video',
      status: 'done',
      objectUrl: '/api/classroom-media/stage-1/media/v.mp4',
      params: { duration: 5 },
    });

    const binding = resolveVideoMediaForElement(
      useMediaGenerationStore.getState().tasks,
      videoElement(),
      'stage-1',
    );
    expect(binding.task?.status).toBe('done');
    expect(resolveMediaRef(binding.sourceRef, binding.task)).toEqual({
      kind: 'url',
      url: '/api/classroom-media/stage-1/media/v.mp4',
    });
  });

  it('a failed frame upserts the error state with the structured code', () => {
    applyMediaReadyFrame({
      ref: REF,
      stageId: 'stage-1',
      status: 'failed',
      errorCode: 'provider-or-storage-error',
    });

    const task = lookupMediaTask(useMediaGenerationStore.getState().tasks, REF, 'stage-1');
    expect(task).toMatchObject({ status: 'failed', errorCode: 'provider-or-storage-error' });

    const binding = resolveVideoMediaForElement(
      useMediaGenerationStore.getState().tasks,
      videoElement(),
      'stage-1',
    );
    expect(resolveMediaRef(binding.sourceRef, binding.task)).toEqual({
      kind: 'failed',
      retryable: true,
    });
  });

  it('settles a pre-existing task instead of duplicating it', () => {
    useMediaGenerationStore
      .getState()
      .enqueueTasks('stage-1', [
        { elementId: REF, type: 'video', prompt: 'a microscope', aspectRatio: '16:9' },
      ]);
    applyMediaReadyFrame({
      ref: REF,
      stageId: 'stage-1',
      status: 'done',
      src: '/api/classroom-media/stage-1/media/v.mp4',
    });

    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual([REF]);
    expect(tasks[REF]).toMatchObject({
      prompt: 'a microscope',
      status: 'done',
      objectUrl: '/api/classroom-media/stage-1/media/v.mp4',
    });
  });
});
