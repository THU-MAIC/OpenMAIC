/**
 * Pure preparation of a classroom manifest for the standalone HTML player.
 *
 * The manifest is the same one the `.maic.zip` export writes. The standalone
 * file has no archive next to it, so this step makes the embedded copy
 * self-contained:
 *
 * - slide rich text (text, shape text, table cells, LaTeX snapshots) is run
 *   through the persistence sanitizer: the renderer injects it into the
 *   player's own document, and the export reads working state that has not
 *   crossed the persistence boundary yet. Inline formulas are re-rendered from
 *   their source and dropped resources are reported (see `rich-text.ts`);
 * - every slide image, background, shape pattern, chart point image and video
 *   poster is replaced by a `data:` URI (or dropped when its bytes could not
 *   be resolved), so the player never names a network address;
 * - video and audio sources are dropped (P1 ships no audio/video bytes; a
 *   video shows its poster frame only);
 * - interactive HTML is patched for iframe display exactly as the classroom
 *   does;
 * - PBL content is resolved to the representation the classroom shows and
 *   reduced to its briefing;
 * - data the player does not use is left out: whiteboards, playback actions,
 *   multi-agent settings, the agent roster, the video manifest and the media
 *   index (which only describes archive payloads).
 */
import type { PPTElement, Slide } from '@openmaic/dsl';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { sanitizeSlideRichText } from './rich-text';
import { pblBriefing } from '../pbl-briefing';
import type { PBLContent, SlideContent } from '@/lib/types/stage';
import type { ClassroomManifest, ManifestScene } from '../classroom-zip-types';
import { orderManifestScenes } from './order-scenes';

/** Which slot of a slide a media reference was found in. */
export type StandaloneMediaRole =
  | 'image'
  | 'background'
  | 'pattern'
  | 'chart-image'
  | 'poster'
  | 'video';

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
        if (element.type === 'chart') {
          for (const series of element.importedStyle?.series ?? []) {
            for (const image of Object.values(series?.pointImages ?? {})) {
              add(image, 'chart-image');
            }
          }
        }
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

interface MediaResolver {
  /** The data URI for a ref, recording the ref as unresolved when there is none. */
  resolve(ref: string | undefined): string | undefined;
  /** The data URI for a ref, without recording a miss. */
  lookup(ref: string | undefined): string | undefined;
  markUnresolved(ref: string): void;
}

function prepareElement(
  element: PPTElement,
  media: StandaloneMediaResolution,
  resolver: MediaResolver,
): PPTElement {
  const { resolve, lookup } = resolver;
  switch (element.type) {
    case 'image':
      return { ...element, src: resolve(element.src) ?? '' };
    case 'shape': {
      if (!element.pattern) return element;
      const pattern = resolve(element.pattern);
      const { pattern: _dropped, ...rest } = element;
      return pattern ? { ...rest, pattern } : rest;
    }
    case 'chart': {
      if (!element.importedStyle?.series) return element;
      const series = element.importedStyle.series.map((entry) => {
        if (!entry?.pointImages) return entry;
        const pointImages: Record<string, string> = {};
        for (const [point, image] of Object.entries(entry.pointImages)) {
          const src = resolve(image);
          if (src) pointImages[point] = src;
        }
        return { ...entry, pointImages };
      });
      return { ...element, importedStyle: { ...element.importedStyle, series } };
    }
    case 'video': {
      const { mediaRef, poster: rawPoster, src, ...rest } = element;
      // The element's own poster first, then the frame captured for the
      // video; a poster ref counts as unresolved only when neither exists.
      const poster =
        lookup(rawPoster) ??
        (src ? media.videoPosters?.get(src) : undefined) ??
        (mediaRef ? media.videoPosters?.get(mediaRef) : undefined);
      if (!poster && rawPoster) resolver.markUnresolved(rawPoster);
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
  media: StandaloneMediaResolution,
  resolver: MediaResolver,
): Slide {
  let background = slide.background;
  if (background?.type === 'image' && background.image) {
    const src = resolver.resolve(background.image.src);
    background = src
      ? { ...background, image: { ...background.image, src } }
      : { ...background, type: 'solid', image: undefined };
  }
  return {
    ...slide,
    ...(background ? { background } : {}),
    elements: (slide.elements ?? []).map((element) => prepareElement(element, media, resolver)),
  };
}

/**
 * The PBL scene reduced to its briefing (see `pblBriefing`): the player reads
 * only these fields.
 */
function preparePblContent(content: PBLContent): PBLContent {
  const briefing = pblBriefing(content);
  if (!briefing) return { type: 'pbl' };
  // A briefing projection, not a runnable project.
  return { type: 'pbl', projectV2: briefing as unknown as PBLContent['projectV2'] };
}

function prepareScene(
  scene: ManifestScene,
  media: StandaloneMediaResolution,
  resolver: MediaResolver,
): ManifestScene {
  const rest: ManifestScene = {
    type: scene.type,
    title: scene.title,
    order: scene.order,
    content: scene.content,
  };
  const content = scene.content;
  if (content.type === 'slide') {
    const { content: sanitized, discarded } = sanitizeSlideRichText(content as SlideContent);
    for (const resource of discarded) resolver.markUnresolved(resource);
    return {
      ...rest,
      content: { ...sanitized, canvas: prepareSlide(sanitized.canvas, media, resolver) },
    };
  }
  if (content.type === 'pbl') {
    return { ...rest, content: preparePblContent(content) };
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
  const lookup = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    if (isDataUri(ref)) return ref;
    return media.dataUris.get(ref);
  };
  const resolver: MediaResolver = {
    lookup,
    resolve: (ref) => {
      const dataUri = lookup(ref);
      if (!dataUri && ref) unresolved.add(ref);
      return dataUri;
    },
    markUnresolved: (ref) => unresolved.add(ref),
  };
  const scenes = orderManifestScenes(manifest.scenes).map((scene) =>
    prepareScene(scene, media, resolver),
  );
  const { videoManifest: _videoManifest, ...stage } = manifest.stage;
  return {
    manifest: { ...manifest, stage, agents: [], scenes, mediaIndex: {} },
    unresolved: [...unresolved],
  };
}
