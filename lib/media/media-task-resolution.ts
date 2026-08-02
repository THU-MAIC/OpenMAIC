import type { PPTElement, Slide } from '@openmaic/dsl';
import type { Scene, Stage } from '@/lib/types/stage';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';

export interface MediaTaskLookupEntry {
  readonly stageId: string;
  readonly type: 'image' | 'video';
  readonly status: 'pending' | 'generating' | 'done' | 'failed';
  readonly placeholderRef?: string;
}

export function mediaTaskRefForElement(element: PPTElement): string | undefined {
  if (element.type === 'video') {
    return (
      getVideoMediaRefForElement(element) ??
      (element.src && !isConcreteMediaAddress(element.src) ? element.src : undefined)
    );
  }
  if (element.type === 'image' && element.src && !isConcreteMediaAddress(element.src)) {
    return element.src;
  }
  return undefined;
}

/** Shared task lookup used by direct elements and resolved-slide consumers. */
export function resolveMediaTaskForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTElement,
  stageId: string | undefined,
): T | undefined {
  const ref = mediaTaskRefForElement(element);
  if (!ref || !stageId) return undefined;

  const targeted = tasks[element.id];
  if (targeted?.stageId === stageId) return targeted;

  const exact = tasks[ref];
  if (exact) return exact.stageId === stageId ? exact : undefined;

  return Object.values(tasks).find(
    (candidate) => candidate.stageId === stageId && candidate.placeholderRef === ref,
  );
}

function isLegacySequentialVideoElement(element: PPTElement): boolean {
  return element.type === 'video' && /^gen_vid_\d+$/i.test(mediaTaskRefForElement(element) ?? '');
}

/** Enumerate every slide element owned by a stage document. */
export function collectDocumentMediaElements(
  stage: Pick<Stage, 'whiteboard'> | null | undefined,
  scenes: readonly Scene[],
): PPTElement[] {
  const elements: PPTElement[] = [];
  const addSlide = (slide: Pick<Slide, 'elements'>) => elements.push(...slide.elements);

  for (const slide of stage?.whiteboard ?? []) addSlide(slide);
  for (const scene of scenes) {
    if (scene.content.type === 'slide') addSlide(scene.content.canvas);
    for (const slide of scene.whiteboards ?? []) addSlide(slide);
  }
  return elements;
}

/**
 * Seal the legacy singleton recovery once for the complete document.
 *
 * A completed row is rebound only when the document has one unmatched legacy
 * video element and the stage has one completed video row. Exact failures are
 * matches, so they remain authoritative and never enter the recovery set.
 */
export function withDocumentLegacyVideoRecovery<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  documentElements: readonly PPTElement[],
  stageId: string,
): Record<string, T> {
  const unmatchedLegacyVideos = documentElements.filter(
    (element) =>
      isLegacySequentialVideoElement(element) &&
      !resolveMediaTaskForElement(tasks, element, stageId),
  );
  const completedVideos = Object.entries(tasks).filter(
    ([, candidate]) =>
      candidate.stageId === stageId && candidate.type === 'video' && candidate.status === 'done',
  );

  if (unmatchedLegacyVideos.length !== 1 || completedVideos.length !== 1) {
    return { ...tasks };
  }

  const ref = mediaTaskRefForElement(unmatchedLegacyVideos[0]);
  const [taskKey, task] = completedVideos[0];
  if (!ref) return { ...tasks };

  return {
    ...tasks,
    [taskKey]: { ...task, placeholderRef: ref },
  };
}
