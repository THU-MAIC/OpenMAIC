import type { PPTVideoElement } from '@openmaic/dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRestoredMediaTasks } from '@/lib/classroom/load-classroom';
import { renderableMediaUrl, resolveMediaRef } from '@/lib/media/resolve-media-ref';
import type { MediaFileRecord } from '@/lib/utils/database';
import {
  resolveMediaTaskForElement,
  resolveVideoMediaForElement,
  withDocumentLegacyVideoRecovery,
  type MediaTaskLookupEntry,
} from '@/lib/media/media-task-resolution';
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

function lookupTask(
  status: MediaTaskLookupEntry['status'],
  placeholderRef?: string,
): MediaTaskLookupEntry {
  return { stageId, type: 'video', status, placeholderRef };
}

function resolveRestoredVideo(
  records: readonly MediaFileRecord[],
  elements: readonly PPTVideoElement[] = [videoElement()],
) {
  const element = elements[0];
  const tasks = buildRestoredMediaTasks(stageId, records, elements);
  const binding = resolveVideoMediaForElement(tasks, element, stageId);
  const task = binding.task;
  const resolution = resolveMediaRef(binding.sourceRef, task);
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

  it('applies document-scoped legacy recovery through the unified video resolver', () => {
    const element = videoElement();
    const uniqueTask = lookupTask('done');
    const binding = resolveVideoMediaForElement(
      { gen_vid_unique_legacy: uniqueTask },
      element,
      stageId,
      [element],
    );

    expect(binding.task).toMatchObject({ status: 'done', placeholderRef: legacyRef });
  });

  it('keeps a concrete explicit poster ahead of a completed task poster', () => {
    const element = {
      ...videoElement(),
      poster: 'https://cdn.example/explicit-poster.jpg',
    };
    const task = {
      ...lookupTask('done'),
      objectUrl: 'blob:video',
      poster: 'blob:generated-poster',
    };

    const binding = resolveVideoMediaForElement({ [legacyRef]: task }, element, stageId);

    expect(binding.posterRef).toBe(element.poster);
    expect(binding.posterTask).toBeUndefined();
  });

  it('keeps a concrete explicit poster visible while its video task is pending', () => {
    const element = {
      ...videoElement(),
      poster: 'https://cdn.example/explicit-poster.jpg',
    };
    const task = {
      ...lookupTask('pending'),
      poster: 'blob:last-generated-poster',
      retryCount: 0,
    };

    const binding = resolveVideoMediaForElement({ [legacyRef]: task }, element, stageId);

    expect(binding.posterRef).toBe(element.poster);
    expect(binding.posterTask).toBeUndefined();
    expect(resolveMediaRef(binding.posterRef, binding.posterTask)).toEqual({
      kind: 'raw',
      value: element.poster,
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
      const binding = resolveVideoMediaForElement(tasks, element, stageId);
      const task = binding.task;
      const resolution = resolveMediaRef(binding.sourceRef, task);
      expect(task).toBeUndefined();
      expect(resolution).toEqual({ kind: 'placeholder' });
      expect(renderableMediaUrl(resolution)).toBeUndefined();
    }
  });

  it('does not recover an unmatched legacy element from a task owned by an exact match', () => {
    const exactRef = 'gen_vid_unique_legacy';
    const owner = videoElement(exactRef, 'video-a');
    const unmatched = videoElement('gen_vid_1', 'video-b');
    const tasks = buildRestoredMediaTasks(stageId, [videoRecord(exactRef)], [owner, unmatched]);

    expect(resolveMediaTaskForElement(tasks, owner, stageId)?.elementId).toBe(exactRef);
    expect(resolveMediaTaskForElement(tasks, unmatched, stageId)).toBeUndefined();
    expect(tasks[exactRef].placeholderRef).toBeUndefined();
  });

  it.each(['targeted key', 'placeholderRef'] as const)(
    'does not recover from a task owned through its %s',
    (matchMode) => {
      const taskKey = 'gen_vid_unique_legacy';
      const ownerRef = 'gen_vid_owner';
      const owner = videoElement(ownerRef, matchMode === 'targeted key' ? taskKey : 'video-a');
      const unmatched = videoElement('gen_vid_1', 'video-b');
      const tasks = {
        [taskKey]: lookupTask('done', matchMode === 'placeholderRef' ? ownerRef : undefined),
      };
      const recovered = withDocumentLegacyVideoRecovery(tasks, [owner, unmatched], stageId);

      expect(resolveMediaTaskForElement(recovered, owner, stageId)).toBe(recovered[taskKey]);
      expect(resolveMediaTaskForElement(recovered, unmatched, stageId)).toBeUndefined();
      expect(recovered[taskKey].placeholderRef).toBe(
        matchMode === 'placeholderRef' ? ownerRef : undefined,
      );
    },
  );

  const recoveryMatrix = (
    ['matched exactly', 'unmatched', 'unmatched with failure row'] as const
  ).flatMap((elementState) =>
    (['consumed by another element', 'free'] as const).flatMap((taskOwnership) =>
      ([1, 2] as const).map((candidateCount) => ({
        elementState,
        taskOwnership,
        candidateCount,
        shouldRecover:
          elementState === 'unmatched' && taskOwnership === 'free' && candidateCount === 1,
      })),
    ),
  );

  it.each(recoveryMatrix)(
    'recovery matrix: $elementState, task $taskOwnership, $candidateCount candidate(s)',
    ({ elementState, taskOwnership, candidateCount, shouldRecover }) => {
      const subjectRef = 'gen_vid_1';
      const subject = videoElement(subjectRef, 'subject-video');
      const tasks: Record<string, MediaTaskLookupEntry> = {};
      const elements: PPTVideoElement[] = [subject];

      if (elementState === 'matched exactly') tasks[subjectRef] = lookupTask('pending');
      if (elementState === 'unmatched with failure row') {
        tasks[subjectRef] = lookupTask('failed');
      }

      for (let index = 1; index <= candidateCount; index += 1) {
        const taskKey = `gen_vid_candidate_${index}`;
        tasks[taskKey] = lookupTask('done');
        if (taskOwnership === 'consumed by another element') {
          elements.push(videoElement(taskKey, `owner-${index}`));
        }
      }

      const recovered = withDocumentLegacyVideoRecovery(tasks, elements, stageId);
      const rebound = Object.entries(recovered).filter(
        ([taskKey, task]) => taskKey.startsWith('gen_vid_candidate_') && task.placeholderRef,
      );

      expect(rebound).toHaveLength(shouldRecover ? 1 : 0);
      if (shouldRecover) expect(rebound[0][1].placeholderRef).toBe(subjectRef);
    },
  );

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
