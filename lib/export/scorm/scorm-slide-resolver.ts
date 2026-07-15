// lib/export/scorm/scorm-slide-resolver.ts
//
// Slides can reference AI-generated media through placeholder `src` values
// (`gen_img_*` / `gen_vid_*`) that the live app resolves at render time via
// the media-generation store. `slideToPng` renders the raw DSL, so those
// placeholders must be rewritten to real object URLs before snapshotting —
// otherwise the exported PNG shows broken images. Mirrors the resolution
// logic used by the PPTX exporter (`use-export-pptx.ts`).

import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';

/**
 * Return a deep-enough copy of `slide` with media placeholders resolved to
 * blob object URLs. Elements whose media never finished generating keep their
 * placeholder src (the snapshot shows the slide without that asset, matching
 * the PPTX exporter's skip behavior).
 */
export function resolveSlideMedia(slide: Slide): Slide {
  const tasks = useMediaGenerationStore.getState().tasks;

  const resolveSrc = (src: string | undefined, mediaRef?: string): string | undefined => {
    const lookupKey =
      mediaRef || (typeof src === 'string' && isMediaPlaceholder(src) ? src : undefined);
    if (!lookupKey) return src;
    const task = tasks[lookupKey];
    if (task?.status === 'done' && task.objectUrl) return task.objectUrl;
    return src;
  };

  const elements = slide.elements.map((el) => {
    if (el.type === 'image' && typeof el.src === 'string' && isMediaPlaceholder(el.src)) {
      return { ...el, src: resolveSrc(el.src) ?? el.src };
    }
    if (el.type === 'video') {
      const resolved = resolveSrc(el.src, el.mediaRef);
      const task = el.mediaRef ? tasks[el.mediaRef] : undefined;
      return {
        ...el,
        ...(resolved ? { src: resolved } : {}),
        // Prefer the generated poster so the static snapshot shows a frame
        // instead of an empty video box.
        ...(task?.poster ? { poster: task.poster } : {}),
      };
    }
    return el;
  });

  const background =
    slide.background?.image?.src && isMediaPlaceholder(slide.background.image.src)
      ? {
          ...slide.background,
          image: {
            ...slide.background.image,
            src: resolveSrc(slide.background.image.src) ?? slide.background.image.src,
          },
        }
      : slide.background;

  return { ...slide, elements, ...(background ? { background } : {}) };
}
