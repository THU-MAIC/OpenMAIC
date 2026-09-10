import type { PPTElement, PPTVideoElement, Slide } from '@openmaic/dsl';
import type { Scene, Stage } from '@/lib/types/stage';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';

export interface MediaTaskLookupEntry {
  readonly stageId: string;
  readonly type: 'image' | 'video';
  readonly status: 'pending' | 'generating' | 'done' | 'failed';
  readonly placeholderRef?: string;
  readonly objectUrl?: string;
  readonly poster?: string;
}

export interface VideoMediaTaskResolution<T extends MediaTaskLookupEntry> {
  /** Concrete src wins; otherwise this is mediaRef or the legacy opaque src. */
  readonly sourceRef: string | undefined;
  /** Opaque identity retained for retry and diagnostics, even when src is concrete. */
  readonly mediaRef: string | undefined;
  /** Task that governs this element's source, suppressed when concrete src wins. */
  readonly task: T | undefined;
  /** Explicit element poster wins, then the generated task poster. */
  readonly posterRef: string | undefined;
  /** Task-shaped binding for a generated poster's last-known bytes. */
  readonly posterTask: (T & { readonly objectUrl: string }) | undefined;
}

type MediaTaskMatch<T extends MediaTaskLookupEntry> = readonly [key: string, task: T];

/**
 * Look up a media task without allowing inherited Object.prototype members to
 * masquerade as direct hits. The placeholder fallback supports tasks that
 * were re-keyed to an allocated asset id while retaining their document ref.
 */
export function lookupMediaTask<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  ref: string | undefined,
  stageId?: string,
  placeholderFallback = true,
): T | undefined {
  if (!ref) return undefined;
  // Own-property direct hit: AssetRef is an unconstrained string, so a ref can
  // legitimately be "__proto__" or "constructor"; an inherited Object.prototype
  // member must neither masquerade as a task nor shadow the placeholder
  // fallback below.
  const direct = Object.hasOwn(tasks, ref) ? tasks[ref] : undefined;
  const task =
    direct ??
    (placeholderFallback
      ? Object.values(tasks).find(
          (candidate) =>
            candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
        )
      : undefined);
  return task && (!stageId || task.stageId === stageId) ? task : undefined;
}

/** Shared lookup for non-element media such as slide backgrounds. */
export function resolveMediaTaskForRef<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  ref: string | undefined,
  stageId: string | undefined,
  targetElementId?: string,
): T | undefined {
  if (!ref || !stageId || isConcreteMediaAddress(ref)) return undefined;
  const targeted = lookupMediaTask(tasks, targetElementId, stageId, false);
  return targeted ?? lookupMediaTask(tasks, ref, stageId);
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

function matchMediaTaskForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTElement,
  stageId: string | undefined,
): MediaTaskMatch<T> | undefined {
  const ref = mediaTaskRefForElement(element);
  if (!ref || !stageId) return undefined;

  const targeted = lookupMediaTask(tasks, element.id, stageId, false);
  if (targeted) return [element.id, targeted];

  const task = lookupMediaTask(tasks, ref, stageId);
  if (!task) return undefined;
  if (Object.hasOwn(tasks, ref) && tasks[ref] === task) return [ref, task];
  const fallbackKey = Object.entries(tasks).find(([, candidate]) => candidate === task)?.[0];
  return fallbackKey ? [fallbackKey, task] : undefined;
}

/** Shared task lookup used by direct elements and resolved-slide consumers. */
export function resolveMediaTaskForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTElement,
  stageId: string | undefined,
): T | undefined {
  return matchMediaTaskForElement(tasks, element, stageId)?.[1];
}

/**
 * Resolve the complete media binding for one video element.
 *
 * This is the single owner of source precedence, logical-reference selection,
 * element-aware task lookup, and poster selection for video consumers.
 */
export function resolveVideoMediaForElement<T extends MediaTaskLookupEntry>(
  tasks: Readonly<Record<string, T>>,
  element: PPTVideoElement,
  stageId: string | undefined,
  documentElements?: readonly PPTElement[],
): VideoMediaTaskResolution<T> {
  const effectiveTasks =
    stageId && documentElements
      ? withDocumentLegacyVideoRecovery(tasks, documentElements, stageId)
      : tasks;
  const mediaRef = mediaTaskRefForElement(element);
  const concreteSrc = element.src && isConcreteMediaAddress(element.src) ? element.src : undefined;
  const sourceRef = concreteSrc ?? mediaRef ?? element.src;
  const task = concreteSrc
    ? undefined
    : resolveMediaTaskForElement(effectiveTasks, element, stageId);
  const posterRef = element.poster ?? task?.poster;
  // A task-owned poster is carried as a binding whenever it is the effective
  // poster. An element with no poster of its own falls back to the task's
  // generated poster URL, so that URL must travel with a task binding for the
  // manifest guard's task-ownership exemption to admit it; an opaque element
  // poster ref keeps the task's runtime poster URL as its bytes fallback. A
  // concrete explicit element poster stays element-owned and never borrows the
  // task binding.
  const posterTask =
    task?.poster && (!element.poster || !isConcreteMediaAddress(element.poster))
      ? ({ ...task, objectUrl: task.poster } as T & { readonly objectUrl: string })
      : undefined;

  return { sourceRef, mediaRef, task, posterRef, posterTask };
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
  const addSlide = (slide: Pick<Slide, 'background' | 'elements'>) => {
    const seen = new Set<PPTElement>();
    for (const slot of slideMediaReferenceSlots(slide)) {
      if (slot.element && !seen.has(slot.element)) {
        seen.add(slot.element);
        elements.push(slot.element);
      }
    }
  };

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
