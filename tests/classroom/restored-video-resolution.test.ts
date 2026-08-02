import type { PPTVideoElement } from '@openmaic/dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRestoredMediaTasks } from '@/lib/classroom/load-classroom';
import { videoMediaRefForResolution } from '@/components/slide-renderer/components/element/VideoElement/useResolvedVideoMedia';
import { renderableMediaUrl, resolveMediaRef } from '@/lib/media/resolve-media-ref';
import type { MediaFileRecord } from '@/lib/utils/database';
import { resolveMediaTaskForElement } from '@/lib/media/media-task-resolution';
import { resolveSlideMediaState } from '@/components/slide-renderer/use-resolved-slide';

const stageId = 'restored-video-stage';
const legacyRef = 'gen_vid_1';

function videoElement(ref = legacyRef, id = 'video-element'): PPTVideoElement {
  return {
    id,
    type: 'video',
    src: ref,
    mediaRef: ref,
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

function resolveRestoredVideo(
  records: readonly MediaFileRecord[],
  elements: readonly PPTVideoElement[] = [videoElement()],
) {
  const element = elements[0];
  const tasks = buildRestoredMediaTasks(stageId, records, elements);
  const task = resolveMediaTaskForElement(tasks, element, stageId);
  const resolution = resolveMediaRef(videoMediaRefForResolution(element), task);
  return { task, resolution, src: renderableMediaUrl(resolution) };
}

describe('restored classroom video resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back from a legacy ref to the only stored video', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stored-video');

    const result = resolveRestoredVideo([videoRecord('gen_vid_unique_legacy')]);

    expect(result.task?.elementId).toBe('gen_vid_unique_legacy');
    expect(result.task?.placeholderRef).toBe(legacyRef);
    expect(result.resolution).toEqual({ kind: 'url', url: 'blob:stored-video' });
    expect(result.src).toBe('blob:stored-video');

    const resolvedSlide = resolveSlideMediaState(
      {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          fontName: 'Arial',
          fontColor: '#111111',
          backgroundColor: '#ffffff',
          themeColors: ['#111111'],
        },
        elements: [videoElement()],
      },
      stageId,
      buildRestoredMediaTasks(stageId, [videoRecord('gen_vid_unique_legacy')], [videoElement()]),
    );
    expect(resolvedSlide.byElementId['video-element']).toMatchObject({
      task: { elementId: 'gen_vid_unique_legacy', placeholderRef: legacyRef },
      resolution: { kind: 'url', url: 'blob:stored-video' },
    });
  });

  it('does not map one stored row to two unmatched legacy elements', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stored-video');
    const elements = [videoElement('gen_vid_1', 'video-1'), videoElement('gen_vid_2', 'video-2')];
    const tasks = buildRestoredMediaTasks(
      stageId,
      [videoRecord('gen_vid_unique_legacy')],
      elements,
    );

    for (const element of elements) {
      const task = resolveMediaTaskForElement(tasks, element, stageId);
      const resolution = resolveMediaRef(videoMediaRefForResolution(element), task);
      expect(task).toBeUndefined();
      expect(resolution).toEqual({ kind: 'placeholder' });
      expect(renderableMediaUrl(resolution)).toBeUndefined();
    }
  });

  it('does not fall back when the exact legacy ref failed', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:other-video');

    const records = [
      videoRecord(legacyRef, 'Generation failed'),
      videoRecord('gen_vid_other_success'),
    ];
    const result = resolveRestoredVideo(records);

    expect(result.task).toMatchObject({ elementId: legacyRef, status: 'failed' });
    expect(result.resolution).toEqual({ kind: 'failed', retryable: true });
    expect(result.src).toBeUndefined();
    expect(
      buildRestoredMediaTasks(stageId, records, [videoElement()])['gen_vid_other_success']
        .placeholderRef,
    ).toBeUndefined();
  });
});
