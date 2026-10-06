/**
 * Pure preparation of a classroom manifest for the standalone HTML player.
 *
 * The manifest is the same one the `.maic.zip` export writes. The standalone
 * file has no archive next to it, so this step makes the embedded copy
 * self-contained:
 *
 * - every slide image, background, shape pattern and video poster is replaced
 *   by a `data:` URI (or dropped when its bytes could not be resolved), so
 *   the player never names a network address;
 * - video and audio sources are dropped (P1 ships no audio/video bytes; a
 *   video shows its poster frame only);
 * - interactive HTML is patched for iframe display exactly as the classroom
 *   does, and whiteboards plus the media index (both of which only describe
 *   payloads that are not embedded) are left out.
 */
import type { PPTElement, Slide } from '@openmaic/dsl';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import type { ClassroomManifest, ManifestScene } from '../classroom-zip-types';
import { orderManifestScenes } from './order-scenes';

/** Which slot of a slide a media reference was found in. */
export type StandaloneMediaRole = 'image' | 'background' | 'pattern' | 'poster' | 'video';

export interface StandaloneMediaReference {
  ref: string;
  role: StandaloneMediaRole;
}

/** Resolved bytes, as `data:` URIs, keyed by the reference the document holds. */
export interface StandaloneMediaResolution {
  /** ref → data URI for every image/background/pattern/poster ref that resolved. */
  readonly dataUris: ReadonlyMap<string, string>;
  /** Video ref (`src` or `mediaRef`) → data URI of the poster captured for that video. */
  readonly videoPosters?: ReadonlyMap<string, string>;
}

export interface PreparedStandaloneManifest {
  manifest: ClassroomManifest;
  /** Image-like refs (not video/audio sources) that had to be dropped. */
  unresolved: string[];
}

export function isDataUri(value: string | undefined): value is string {
  return typeof value === 'string' && /^data:/i.test(value.trimStart());
}

function slidesOf(scene: ManifestScene): Slide[] {
  return scene.content.type === 'slide' ? [scene.content.canvas] : [];
}

/**
 * Every media reference the player would display, in document order. The
 * caller resolves these to bytes; `video` refs are listed only so their
 * captured posters can be looked up.
 */
export function collectStandaloneMediaReferences(
  manifest: Pick<ClassroomManifest, 'scenes'>,
): StandaloneMediaReference[] {
  const refs: StandaloneMediaReference[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined, role: StandaloneMediaRole) => {
    if (!ref || isDataUri(ref)) return;
    const key = `${role}\u0000${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ref, role });
  };
  for (const scene of manifest.scenes) {
    for (const slide of slidesOf(scene)) {
      if (slide.background?.type === 'image') add(slide.background.image?.src, 'background');
      for (const element of slide.elements ?? []) {
        if (element.type === 'image') add(element.src, 'image');
        if (element.type === 'shape') add(element.pattern, 'pattern');
        if (element.type === 'video') {
          add(element.poster, 'poster');
          add(element.src, 'video');
          add(element.mediaRef, 'video');
        }
      }
    }
  }
  return refs;
}

function prepareElement(
  element: PPTElement,
  resolve: (ref: string | undefined) => string | undefined,
  media: StandaloneMediaResolution,
): PPTElement {
  switch (element.type) {
    case 'image':
      return { ...element, src: resolve(element.src) ?? '' };
    case 'shape': {
      if (!element.pattern) return element;
      const pattern = resolve(element.pattern);
      const { pattern: _dropped, ...rest } = element;
      return pattern ? { ...rest, pattern } : rest;
    }
    case 'video': {
      const { mediaRef, poster: rawPoster, src, ...rest } = element;
      const poster =
        resolve(rawPoster) ??
        (src ? media.videoPosters?.get(src) : undefined) ??
        (mediaRef ? media.videoPosters?.get(mediaRef) : undefined);
      return { ...rest, src: '', ...(poster ? { poster } : {}) };
    }
    case 'audio':
      return { ...element, src: '' };
    default:
      return element;
  }
}

function prepareSlide(
  slide: Slide,
  resolve: (ref: string | undefined) => string | undefined,
  media: StandaloneMediaResolution,
): Slide {
  let background = slide.background;
  if (background?.type === 'image' && background.image) {
    const src = resolve(background.image.src);
    background = src
      ? { ...background, image: { ...background.image, src } }
      : { ...background, type: 'solid', image: undefined };
  }
  return {
    ...slide,
    ...(background ? { background } : {}),
    elements: (slide.elements ?? []).map((element) => prepareElement(element, resolve, media)),
  };
}

function prepareScene(
  scene: ManifestScene,
  resolve: (ref: string | undefined) => string | undefined,
  media: StandaloneMediaResolution,
): ManifestScene {
  const { whiteboards: _whiteboards, ...rest } = scene;
  const content = scene.content;
  if (content.type === 'slide') {
    return {
      ...rest,
      content: { ...content, canvas: prepareSlide(content.canvas, resolve, media) },
    };
  }
  if (content.type === 'interactive') {
    // Inline HTML is the only form that works offline; a URL-only scene keeps
    // no address at all and the player shows it as unavailable.
    const { url: _url, ...interactive } = content;
    return {
      ...rest,
      content: content.html
        ? { ...interactive, html: patchHtmlForIframe(content.html) }
        : { ...interactive, html: undefined },
    };
  }
  return rest;
}

export function prepareStandaloneManifest(
  manifest: ClassroomManifest,
  media: StandaloneMediaResolution,
): PreparedStandaloneManifest {
  const unresolved = new Set<string>();
  const resolve = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    if (isDataUri(ref)) return ref;
    const dataUri = media.dataUris.get(ref);
    if (dataUri) return dataUri;
    unresolved.add(ref);
    return undefined;
  };
  const scenes = orderManifestScenes(manifest.scenes).map((scene) =>
    prepareScene(scene, resolve, media),
  );
  return {
    manifest: { ...manifest, scenes, mediaIndex: {} },
    unresolved: [...unresolved],
  };
}
