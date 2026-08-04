'use client';

import { useMemo } from 'react';
import type { Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useAssetUrlLeases, type AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
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

export function resolveSlideMediaState(
  slide: Slide,
  stageId: string | undefined,
  tasks: Record<string, MediaTask>,
  options: {
    assetUrls?: Readonly<Record<string, string>>;
    assetLeases?: Readonly<Record<string, AssetUrlLeaseState>>;
    imageGenerationDisabled?: boolean;
    videoGenerationDisabled?: boolean;
  } = {},
): ResolvedSlideMedia {
  const byElementId: Record<string, ResolvedSlideMediaEntry> = {};
  const backgroundRef =
    slide.background?.type === 'image' ? slide.background.image?.src : undefined;
  const backgroundTask = resolveMediaTaskForRef(tasks, backgroundRef, stageId);
  const backgroundResolution = backgroundRef
    ? resolveMediaRef(
        backgroundRef,
        backgroundTask,
        leaseFor(backgroundRef, options.assetLeases, options.assetUrls),
        options.imageGenerationDisabled,
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
    if (element.type !== 'image' && element.type !== 'video') return element;

    const videoBinding =
      element.type === 'video' ? resolveVideoMediaForElement(tasks, element, stageId) : undefined;
    const ref = videoBinding ? (videoBinding.mediaRef ?? videoBinding.sourceRef) : element.src;
    const sourceRef = videoBinding?.sourceRef ?? element.src;
    const task =
      videoBinding?.task ??
      (element.type === 'image' ? resolveMediaTaskForElement(tasks, element, stageId) : undefined);
    const resolution = resolveMediaRef(
      sourceRef,
      task,
      leaseFor(sourceRef, options.assetLeases, options.assetUrls),
      element.type === 'image' ? options.imageGenerationDisabled : options.videoGenerationDisabled,
    );

    let posterResolution: MediaResolution | undefined;
    if (element.type === 'video' && videoBinding?.posterRef !== undefined) {
      posterResolution = resolveMediaRef(
        videoBinding.posterRef,
        videoBinding.posterTask,
        leaseFor(videoBinding.posterRef, options.assetLeases, options.assetUrls),
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

export function useResolvedSlideMedia(slide: Slide): ResolvedSlideMedia {
  const stageId = useMediaStageId();
  const imageGenerationDisabled = useSettingsStore((state) => !state.imageGenerationEnabled);
  const videoGenerationDisabled = useSettingsStore((state) => !state.videoGenerationEnabled);
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

  const refs = useMemo(() => {
    if (!stageId) return [];
    const values: string[] = [];
    for (const element of slide.elements) {
      if (element.type === 'image') {
        const source = mediaTaskRefForElement(element) ?? element.src;
        if (source && !isConcreteMediaAddress(source)) values.push(source);
      }
      if (element.type === 'video') {
        const binding = resolveVideoMediaForElement(
          useMediaGenerationStore.getState().tasks,
          element,
          stageId,
        );
        if (binding.sourceRef && !isConcreteMediaAddress(binding.sourceRef)) {
          values.push(binding.sourceRef);
        }
        if (binding.posterRef && !isConcreteMediaAddress(binding.posterRef)) {
          values.push(binding.posterRef);
        }
      }
    }
    const backgroundRef =
      slide.background?.type === 'image' ? slide.background.image?.src : undefined;
    if (backgroundRef && !isConcreteMediaAddress(backgroundRef)) values.push(backgroundRef);
    return values;
  }, [slide, stageId]);
  const assetLeases = useAssetUrlLeases(refs);

  return useMemo(() => {
    if (!stageId) {
      return resolveSlideMediaState(
        slide,
        undefined,
        {},
        {
          imageGenerationDisabled,
          videoGenerationDisabled,
        },
      );
    }
    void signature;
    return resolveSlideMediaState(slide, stageId, useMediaGenerationStore.getState().tasks, {
      assetLeases,
      imageGenerationDisabled,
      videoGenerationDisabled,
    });
  }, [slide, stageId, signature, assetLeases, imageGenerationDisabled, videoGenerationDisabled]);
}

export function useResolvedSlide(slide: Slide): Slide {
  return useResolvedSlideMedia(slide).slide;
}
