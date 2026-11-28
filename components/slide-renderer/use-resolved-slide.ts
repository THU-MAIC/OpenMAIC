'use client';

import { useMemo } from 'react';
import type { Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { useAssetUrlLeases, type AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { mediaGenerationDisabled as isMediaGenerationDisabled } from '@/lib/model-settings/capabilities';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  withGenerationPermission,
  type MediaResolution,
} from '@/lib/media/resolve-media-ref';
import {
  mediaTaskRefForElement,
  resolveMediaTaskForRef,
  resolveMediaTaskForElement,
  resolveVideoMediaForElement,
} from '@/lib/media/media-task-resolution';

export interface ResolvedSlideMediaEntry {
  readonly ref: string | undefined;
  readonly resolution: MediaResolution;
  readonly posterResolution?: MediaResolution;
  readonly task?: MediaTask;
}

export interface ResolvedSlideMedia {
  readonly slide: Slide;
  readonly byElementId: Readonly<Record<string, ResolvedSlideMediaEntry>>;
  readonly backgroundResolution?: MediaResolution;
}

function leaseFor(
  ref: string | undefined,
  assetLeases: Readonly<Record<string, AssetUrlLeaseState>> | undefined,
  assetUrls: Readonly<Record<string, string>> | undefined,
): AssetUrlLeaseState {
  if (!ref || isConcreteMediaAddress(ref)) return MISSING_ASSET_LEASE;
  return (
    assetLeases?.[ref] ??
    (assetUrls?.[ref] ? { status: 'resolved', url: assetUrls[ref] } : MISSING_ASSET_LEASE)
  );
}

function isPoolLeasable(ref: string | undefined): ref is string {
  return !!ref && !isConcreteMediaAddress(ref) && mayNameAPoolAsset(ref);
}

/**
 * The reference whose lease paints an element's media. Normally the element's
 * own; but between a completion frame and the document catching up, the
 * element still names the generation placeholder, which the pool cannot hold,
 * while the task already names the allocated id. Leasing that id lets the media
 * show when the frame arrives instead of when the sync lands (#1522). It is only
 * ever a second choice: a leasable document reference always counts first.
 */
function paintLeaseRef(
  sourceRef: string | undefined,
  task: MediaTask | undefined,
): string | undefined {
  if (isPoolLeasable(sourceRef)) return sourceRef;
  return isPoolLeasable(task?.objectUrl) ? task.objectUrl : sourceRef;
}

export function resolveSlideMediaState(
  slide: Slide,
  stageId: string | undefined,
  tasks: Record<string, MediaTask>,
  options: {
    assetUrls?: Readonly<Record<string, string>>;
    assetLeases?: Readonly<Record<string, AssetUrlLeaseState>>;
    imageGenerationDisabled?: boolean;
    videoGenerationDisabled?: boolean;
    /** Whether this browser may start generation; false withdraws retry. */
    mayGenerate?: boolean;
  } = {},
): ResolvedSlideMedia {
  const mayGenerate = options.mayGenerate ?? true;
  const byElementId: Record<string, ResolvedSlideMediaEntry> = {};
  const backgroundRef =
    slide.background?.type === 'image' ? slide.background.image?.src : undefined;
  const backgroundTask = resolveMediaTaskForRef(tasks, backgroundRef, stageId);
  const backgroundResolution = backgroundRef
    ? withGenerationPermission(
        resolveMediaRef(
          backgroundRef,
          backgroundTask,
          leaseFor(backgroundRef, options.assetLeases, options.assetUrls),
          options.imageGenerationDisabled,
        ),
        mayGenerate,
      )
    : undefined;
  const backgroundSrc = backgroundResolution
    ? (renderableMediaUrl(backgroundResolution) ?? '')
    : undefined;
  const background =
    slide.background?.type === 'image' &&
    slide.background.image &&
    backgroundSrc !== undefined &&
    backgroundSrc !== slide.background.image.src
      ? {
          ...slide.background,
          image: { ...slide.background.image, src: backgroundSrc },
        }
      : slide.background;
  const elements = slide.elements.map((element) => {
    if (element.type === 'audio' && mayNameAPoolAsset(element.src)) {
      const lease = leaseFor(element.src, options.assetLeases, options.assetUrls);
      const resolution = resolveMediaRef(element.src, undefined, lease);
      return { ...element, src: renderableMediaUrl(resolution) ?? '' };
    }
    if (element.type !== 'image' && element.type !== 'video') return element;

    const videoBinding =
      element.type === 'video' ? resolveVideoMediaForElement(tasks, element, stageId) : undefined;
    const ref = videoBinding ? (videoBinding.mediaRef ?? videoBinding.sourceRef) : element.src;
    const sourceRef = videoBinding?.sourceRef ?? element.src;
    const task =
      videoBinding?.task ??
      (element.type === 'image' ? resolveMediaTaskForElement(tasks, element, stageId) : undefined);
    const resolution = withGenerationPermission(
      resolveMediaRef(
        sourceRef,
        task,
        leaseFor(paintLeaseRef(sourceRef, task), options.assetLeases, options.assetUrls),
        element.type === 'image'
          ? options.imageGenerationDisabled
          : options.videoGenerationDisabled,
      ),
      mayGenerate,
    );

    let posterResolution: MediaResolution | undefined;
    if (element.type === 'video' && videoBinding?.posterRef !== undefined) {
      posterResolution = withGenerationPermission(
        resolveMediaRef(
          videoBinding.posterRef,
          videoBinding.posterTask,
          leaseFor(videoBinding.posterRef, options.assetLeases, options.assetUrls),
        ),
        mayGenerate,
      );
    }

    if (element.id) byElementId[element.id] = { ref, resolution, posterResolution, task };
    const src = renderableMediaUrl(resolution) ?? '';
    if (element.type === 'image') return src === element.src ? element : { ...element, src };

    const poster = posterResolution ? renderableMediaUrl(posterResolution) : element.poster;
    if (src === element.src && poster === element.poster) return element;
    const next = { ...element, src };
    if (poster === undefined) delete next.poster;
    else next.poster = poster;
    return next;
  });

  return {
    slide:
      background === slide.background &&
      elements.every((element, index) => element === slide.elements[index])
        ? slide
        : { ...slide, background, elements },
    byElementId,
    backgroundResolution,
  };
}

export function resolveSlideMedia(
  slide: Slide,
  stageId: string | undefined,
  tasks: Record<string, MediaTask>,
  options: {
    assetUrls?: Readonly<Record<string, string>>;
    assetLeases?: Readonly<Record<string, AssetUrlLeaseState>>;
    imageGenerationDisabled?: boolean;
    videoGenerationDisabled?: boolean;
  } = {},
): Slide {
  return resolveSlideMediaState(slide, stageId, tasks, options).slide;
}

/**
 * Every reference on a slide that is worth asking the asset pool about.
 *
 * A slide carries media in image, audio, and video sources, as well as a
 * video poster and an image background. Each of them has to apply the
 * same two tests before a lease is opened: a concrete address (a URL or a data
 * URI) resolves itself, and a reference the pool never issued would only
 * answer 404. Collecting them here rather than inline in the hook is what
 * makes that rule testable: a site that forgets a test still renders correctly
 * while spending a request per element per load, so nothing else would fail.
 *
 * Pure over its inputs, and returns the references in slide order.
 */
export function poolLeasableSlideRefs(
  slide: Slide,
  stageId: string | undefined,
  tasks: Record<string, MediaTask>,
): string[] {
  if (!stageId) return [];
  const values: string[] = [];
  const consider = (ref: string | undefined): void => {
    if (!ref || isConcreteMediaAddress(ref) || !mayNameAPoolAsset(ref)) return;
    values.push(ref);
  };
  for (const element of slide.elements) {
    if (element.type === 'audio') consider(element.src);
    if (element.type === 'image') {
      const ref = mediaTaskRefForElement(element) ?? element.src;
      consider(ref);
      if (!isPoolLeasable(ref)) {
        consider(resolveMediaTaskForElement(tasks, element, stageId)?.objectUrl);
      }
    }
    if (element.type === 'video') {
      const binding = resolveVideoMediaForElement(tasks, element, stageId);
      consider(binding.sourceRef);
      if (!isPoolLeasable(binding.sourceRef)) consider(binding.task?.objectUrl);
      consider(binding.posterRef);
    }
  }
  consider(slide.background?.type === 'image' ? slide.background.image?.src : undefined);
  return values;
}

export function useResolvedSlideMedia(slide: Slide): ResolvedSlideMedia {
  const stageId = useMediaStageId();
  const capabilities = useModelCapabilities();
  const imageGenerationDisabled = isMediaGenerationDisabled(capabilities, 'image');
  const videoGenerationDisabled = isMediaGenerationDisabled(capabilities, 'video');
  const signature = useMediaGenerationStore((state) => {
    if (!stageId) return '';
    return slide.elements
      .map((element) => {
        const videoBinding =
          element.type === 'video'
            ? resolveVideoMediaForElement(state.tasks, element, stageId)
            : undefined;
        const key = videoBinding
          ? (videoBinding.mediaRef ?? videoBinding.sourceRef)
          : mediaTaskRefForElement(element);
        const task =
          element.type === 'video'
            ? videoBinding?.task
            : resolveMediaTaskForElement(state.tasks, element, stageId);
        if (!task) return `${key ?? ''}|`;
        return `${key}|${task.status}|${task.objectUrl ?? ''}|${task.poster ?? ''}|${task.errorCode ?? ''}|`;
      })
      .concat(
        slide.background?.type === 'image'
          ? (() => {
              const ref = slide.background.image?.src;
              const task = resolveMediaTaskForRef(state.tasks, ref, stageId);
              return `${ref ?? ''}|${task?.status ?? ''}|${task?.objectUrl ?? ''}|${task?.errorCode ?? ''}|`;
            })()
          : '',
      )
      .join('');
  });

  // The signature names each task's objectUrl, which may be the pool id to lease.
  const refs = useMemo(() => {
    void signature;
    return poolLeasableSlideRefs(slide, stageId, useMediaGenerationStore.getState().tasks);
  }, [slide, stageId, signature]);
  const assetLeases = useAssetUrlLeases(refs);
  const mayGenerate = useMayGenerateForStage(stageId);

  return useMemo(() => {
    if (!stageId) {
      return resolveSlideMediaState(
        slide,
        undefined,
        {},
        {
          imageGenerationDisabled,
          videoGenerationDisabled,
          mayGenerate,
        },
      );
    }
    void signature;
    return resolveSlideMediaState(slide, stageId, useMediaGenerationStore.getState().tasks, {
      assetLeases,
      imageGenerationDisabled,
      videoGenerationDisabled,
      mayGenerate,
    });
  }, [
    slide,
    stageId,
    signature,
    assetLeases,
    imageGenerationDisabled,
    videoGenerationDisabled,
    mayGenerate,
  ]);
}

export function useResolvedSlide(slide: Slide): Slide {
  return useResolvedSlideMedia(slide).slide;
}
