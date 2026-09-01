import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPendingMediaTasks,
  getPendingMediaTask,
  listPendingMediaTasks,
  pruneSettledPendingMedia,
  registerPendingMedia,
  setPendingMediaStage,
  settlePendingMedia,
} from '@/lib/server/agent-runtime/pending-media';

describe('pending media registry', () => {
  afterEach(() => {
    clearPendingMediaTasks();
  });

  it('registers a generating task and settles it done', () => {
    const task = registerPendingMedia({
      ref: 'gen_vid_abc12345',
      type: 'video',
      stageId: 'stage-1',
      sessionId: 'session-1',
      provider: 'seedance',
    });
    expect(task.status).toBe('generating');
    expect(task.startedAt).toBeGreaterThan(0);

    setPendingMediaStage(task.ref, 'persist');
    expect(getPendingMediaTask(task.ref)?.stage).toBe('persist');

    settlePendingMedia(task.ref, {
      status: 'done',
      src: '/api/classroom-media/stage-1/media/v.mp4',
      mime: 'video/mp4',
    });
    const settled = getPendingMediaTask(task.ref);
    expect(settled).toMatchObject({
      status: 'done',
      src: '/api/classroom-media/stage-1/media/v.mp4',
      mime: 'video/mp4',
    });
    expect(settled?.settledAt).toBeGreaterThanOrEqual(task.startedAt);
  });

  it('settles a task failed with a structured error code', () => {
    registerPendingMedia({ ref: 'gen_vid_deadbeef', type: 'video', stageId: 'stage-1' });
    settlePendingMedia('gen_vid_deadbeef', {
      status: 'failed',
      errorCode: 'provider-or-storage-error',
    });
    expect(getPendingMediaTask('gen_vid_deadbeef')).toMatchObject({
      status: 'failed',
      errorCode: 'provider-or-storage-error',
    });
  });

  it('ignores settles and stage advances for unknown or settled refs', () => {
    settlePendingMedia('gen_vid_unknown', { status: 'failed', errorCode: 'timeout' });
    setPendingMediaStage('gen_vid_unknown', 'persist');
    expect(getPendingMediaTask('gen_vid_unknown')).toBeUndefined();

    registerPendingMedia({ ref: 'gen_vid_once', type: 'video', stageId: 'stage-1' });
    settlePendingMedia('gen_vid_once', { status: 'failed', errorCode: 'timeout' });
    // A second settle (e.g. a racing timeout after success) must not flip it.
    settlePendingMedia('gen_vid_once', { status: 'done', src: '/late.mp4' });
    setPendingMediaStage('gen_vid_once', 'patch');
    expect(getPendingMediaTask('gen_vid_once')).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
    });
    expect(getPendingMediaTask('gen_vid_once')?.src).toBeUndefined();
  });

  it('keeps the first entry on a duplicate ref registration', () => {
    const first = registerPendingMedia({
      ref: 'gen_vid_dup',
      type: 'video',
      stageId: 'stage-1',
    });
    const second = registerPendingMedia({
      ref: 'gen_vid_dup',
      type: 'video',
      stageId: 'stage-2',
    });
    expect(second).toBe(first);
    expect(getPendingMediaTask('gen_vid_dup')?.stageId).toBe('stage-1');
  });

  it('lists snapshots and prunes settled entries only', () => {
    registerPendingMedia({ ref: 'gen_vid_a', type: 'video', stageId: 'stage-1' });
    registerPendingMedia({ ref: 'gen_vid_b', type: 'video', stageId: 'stage-1' });
    settlePendingMedia('gen_vid_a', { status: 'done', src: '/a.mp4' });

    const listed = listPendingMediaTasks();
    expect(listed.map((task) => task.ref)).toEqual(['gen_vid_a', 'gen_vid_b']);
    // Snapshots are copies: mutating them must not touch the registry.
    listed[0]!.status = 'failed';
    expect(getPendingMediaTask('gen_vid_a')?.status).toBe('done');

    expect(pruneSettledPendingMedia()).toBe(1);
    expect(listPendingMediaTasks().map((task) => task.ref)).toEqual(['gen_vid_b']);
  });
});
