'use client';

import { useMemo } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
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

export interface ResolvedSlideMediaEntry {
  readonly ref: string | undefined;
  readonly resolution: MediaResolution;
  readonly posterResolution?: MediaResolution;
  readonly task?: MediaTask;
}

export interface ResolvedSlideMedia {
  readonly slide: Slide;
  readonly byElementId: Readonly<Record<string, ResolvedSlideMediaEntry>>;
}

function mediaTaskKeyFor(el: PPTElement): string | undefined {
  if (el.type === 'video') {
    return (
      getVideoMediaRefForElement(el) ??
      (el.src && !isConcreteMediaAddress(el.src) ? el.src : undefined)
    );
  }
  if (el.type === 'image' && el.src && !isConcreteMediaAddress(el.src)) return el.src;
  return undefined;
}

function taskForRef(
  tasks: Record<string, MediaTask>,
  ref: string | undefined,
  stageId: string | undefined,
): MediaTask | undefined {
  if (!ref || !stageId || isConcreteMediaAddress(ref)) return undefined;
  const direct = tasks[ref];
  if (direct?.stageId === stageId) return direct;
  return Object.values(tasks).find(
    (candidate) => candidate.stageId === stageId && candidate.placeholderRef === ref,
  );
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
  const elements = slide.elements.map((element) => {
    if (element.type !== 'image' && element.type !== 'video') return element;

    const taskKey = mediaTaskKeyFor(element);
    const task = taskForRef(tasks, taskKey, stageId);
    const ref = element.type === 'video' ? (taskKey ?? element.src) : element.src;
    const resolution = resolveMediaRef(
      ref,
      task,
      leaseFor(ref, options.assetLeases, options.assetUrls),
      element.type === 'image' ? options.imageGenerationDisabled : options.videoGenerationDisabled,
    );

    let posterResolution: MediaResolution | undefined;
    if (element.type === 'video' && (element.poster !== undefined || task?.poster)) {
      const posterRef = element.poster ?? task?.poster;
      posterResolution = resolveMediaRef(
        posterRef,
        element.poster && task?.poster ? { ...task, objectUrl: task.poster } : undefined,
        leaseFor(element.poster, options.assetLeases, options.assetUrls),
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
    slide: elements.every((element, index) => element === slide.elements[index])
      ? slide
      : { ...slide, elements },
    byElementId,
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
        const key = mediaTaskKeyFor(element);
        const task = taskForRef(state.tasks, key, stageId);
        if (!task) return `${key ?? ''}|`;
        return `${key}|${task.status}|${task.objectUrl ?? ''}|${task.poster ?? ''}|${task.errorCode ?? ''}|`;
      })
      .join('');
  });

  const refs = useMemo(() => {
    if (!stageId) return [];
    const values: string[] = [];
    for (const element of slide.elements) {
      if (element.type === 'image' || element.type === 'video') {
        const source = mediaTaskKeyFor(element) ?? element.src;
        if (source && !isConcreteMediaAddress(source)) values.push(source);
      }
      if (element.type === 'video' && element.poster && !isConcreteMediaAddress(element.poster)) {
        values.push(element.poster);
      }
    }
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
