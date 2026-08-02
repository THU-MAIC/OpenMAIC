import type { PPTVideoElement } from '@openmaic/dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRestoredMediaTasks } from '@/lib/classroom/load-classroom';
import {
  selectVideoMediaTaskForElement,
  videoMediaRefForResolution,
} from '@/components/slide-renderer/components/element/VideoElement/useResolvedVideoMedia';
import { renderableMediaUrl, resolveMediaRef } from '@/lib/media/resolve-media-ref';
import type { MediaFileRecord } from '@/lib/utils/database';

const stageId = 'restored-video-stage';
const legacyRef = 'gen_vid_1';

function videoElement(): PPTVideoElement {
  return {
    id: 'video-element',
    type: 'video',
    src: legacyRef,
    mediaRef: legacyRef,
    left: 0,
    top: 0,
    width: 100,
    height: 56,
    rotate: 0,
    autoplay: false,
  };
}

function videoRecord(ref: string, error?: string): MediaFileRecord {
  const blob = new Blob(error ? [] : ['video'], { type: 'video/mp4' });
  return {
    id: `${stageId}:${ref}`,
    stageId,
    type: 'video',
    blob,
    mimeType: 'video/mp4',
    size: blob.size,
    prompt: 'video',
    params: '{}',
    error,
    createdAt: 1,
  };
}

function resolveRestoredVideo(records: readonly MediaFileRecord[]) {
  const element = videoElement();
  const tasks = buildRestoredMediaTasks(stageId, records);
  const task = selectVideoMediaTaskForElement(tasks, element, stageId);
  const resolution = resolveMediaRef(videoMediaRefForResolution(element), task);
  return { task, resolution, src: renderableMediaUrl(resolution) };
}

describe('restored classroom video resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back from a legacy ref to the only stored video', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stored-video');

    const result = resolveRestoredVideo([videoRecord('gen_vid_unique_legacy')]);

    expect(result.task?.elementId).toBe('gen_vid_unique_legacy');
    expect(result.resolution).toEqual({ kind: 'url', url: 'blob:stored-video' });
    expect(result.src).toBe('blob:stored-video');
  });

  it('does not guess between multiple stored videos', () => {
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first-video')
      .mockReturnValueOnce('blob:second-video');

    const result = resolveRestoredVideo([
      videoRecord('gen_vid_first_legacy'),
      videoRecord('gen_vid_second_legacy'),
    ]);

    expect(result.task).toBeUndefined();
    expect(result.resolution).toEqual({ kind: 'placeholder' });
    expect(result.src).toBeUndefined();
  });

  it('does not fall back when the exact legacy ref failed', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:other-video');

    const result = resolveRestoredVideo([
      videoRecord(legacyRef, 'Generation failed'),
      videoRecord('gen_vid_other_success'),
    ]);

    expect(result.task).toMatchObject({ elementId: legacyRef, status: 'failed' });
    expect(result.resolution).toEqual({ kind: 'failed', retryable: true });
    expect(result.src).toBeUndefined();
  });
});
