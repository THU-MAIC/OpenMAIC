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

type MediaTaskMatch<T extends MediaTaskLookupEntry> = readonly [key: string, task: T];

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

function matchMediaTaskForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTElement,
  stageId: string | undefined,
): MediaTaskMatch<T> | undefined {
  const ref = mediaTaskRefForElement(element);
  if (!ref || !stageId) return undefined;

  const targeted = tasks[element.id];
  if (targeted?.stageId === stageId) return [element.id, targeted];

  const exact = tasks[ref];
  if (exact) return exact.stageId === stageId ? [ref, exact] : undefined;

  return Object.entries(tasks).find(
    ([, candidate]) => candidate.stageId === stageId && candidate.placeholderRef === ref,
  );
}

/** Shared task lookup used by direct elements and resolved-slide consumers. */
export function resolveMediaTaskForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTElement,
  stageId: string | undefined,
): T | undefined {
  return matchMediaTaskForElement(tasks, element, stageId)?.[1];
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
 * First claim every task selected by normal lookup. Recovery then pairs the
 * sole unmatched legacy video with the sole unclaimed completed video task.
 * Exact failures are normal matches, so they remain authoritative.
 */
export function withDocumentLegacyVideoRecovery<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  documentElements: readonly PPTElement[],
  stageId: string,
): Record<string, T> {
  const videoElements = documentElements.filter((element) => element.type === 'video');
  const matchedElements = new Set<PPTElement>();
  const consumedTaskKeys = new Set<string>();

  for (const element of videoElements) {
    const match = matchMediaTaskForElement(tasks, element, stageId);
    if (!match) continue;
    matchedElements.add(element);
    consumedTaskKeys.add(match[0]);
  }

  const candidates = Object.entries(tasks).filter(
    ([taskKey, candidate]) =>
      candidate.stageId === stageId &&
      candidate.type === 'video' &&
      candidate.status === 'done' &&
      !consumedTaskKeys.has(taskKey),
  );
  const unmatchedLegacyVideos = videoElements.filter(
    (element) => isLegacySequentialVideoElement(element) && !matchedElements.has(element),
  );

  if (unmatchedLegacyVideos.length !== 1 || candidates.length !== 1) {
    return { ...tasks };
  }

  const ref = mediaTaskRefForElement(unmatchedLegacyVideos[0]);
  const [taskKey, task] = candidates[0];
  if (!ref) return { ...tasks };

  return {
    ...tasks,
    [taskKey]: { ...task, placeholderRef: ref },
  };
}
