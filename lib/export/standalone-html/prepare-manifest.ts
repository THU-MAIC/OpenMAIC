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
 * - video sources are replaced by the key of their embedded bytes when the
 *   export carries them (`mediaRef`, resolved through the player's media
 *   table), and dropped otherwise, so the video shows its poster frame only;
 *   audio elements keep no source;
 * - playback actions are reduced to what the offline player replays (see
 *   {@link prepareStandaloneActions}): narration keeps its text and, when the
 *   bytes ship, its `audioRef` key; whiteboard actions and agent internals
 *   are left out;
 * - interactive HTML is patched for iframe display exactly as the classroom
 *   does;
 * - PBL content is resolved to the representation the classroom shows and
 *   reduced to its briefing;
 * - data the player does not use is left out: whiteboards, multi-agent
 *   settings, the agent roster, the video manifest and the media index
 *   (which only describes archive payloads).
 *
 * Media bytes themselves never enter the manifest here: actions and video
 * elements name them by archive path, and the caller decides how those paths
 * resolve (embedded data blocks for the single file; a later variant can ship
 * the same paths as files next to the page).
 */
import type { PPTElement, Slide } from '@openmaic/dsl';
import type {
  DiscussionAction,
  LaserAction,
  PlayVideoAction,
  SpeechAction,
  SpotlightAction,
  WidgetAnnotationAction,
  WidgetHighlightAction,
  WidgetRevealAction,
  WidgetSetStateAction,
} from '@openmaic/dsl';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import {
  analyzeHtmlAssetInventory,
  applySourcePatches,
  replaceAttributePatch,
  type SourcePatch,
} from '../html-asset-inventory';
import { sanitizeSlideRichText } from './rich-text';
import { pblBriefing } from '../pbl-briefing';
import type { PBLContent, SlideContent } from '@/lib/types/stage';
import type { ClassroomManifest, ManifestAction, ManifestScene } from '../classroom-zip-types';
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

/**
 * Resolved sources keyed by the reference the document holds: `data:` URIs
 * for the single file, relative file paths for the ZIP variant. A `data:`
 * reference already in the document stays as it is unless `dataUris` maps it
 * (the ZIP variant ships inline images as files too).
 */
export interface StandaloneMediaResolution {
  /** ref → data URI for every image/background/pattern/poster ref that resolved. */
  readonly dataUris: ReadonlyMap<string, string>;
  /** Video ref (`src` or `mediaRef`) → data URI of the poster captured for that video. */
  readonly videoPosters?: ReadonlyMap<string, string>;
  /**
   * Chart point image ref → data URI, when chart images must stay inline
   * while `dataUris` names files (the ZIP variant): the chart renderer
   * embeds them in a `data:` SVG symbol, which cannot load a file.
   */
  readonly chartImages?: ReadonlyMap<string, string>;
  /**
   * Playback media whose bytes ship with the export, by archive path. Absent
   * (or empty) for an export without narration: speech then plays on the
   * reading timer and videos show their poster.
   */
  readonly playback?: StandalonePlaybackMedia;
}

export interface StandalonePlaybackMedia {
  /** Archive paths of narration audio whose bytes ship. */
  readonly audio: ReadonlySet<string>;
  /** Video ref (`src` or `mediaRef`) → archive path of its bytes. */
  readonly videos: ReadonlyMap<string, string>;
  /**
   * Bytes fetched at export time for paths the snapshot does not carry
   * (direct video URLs), by path.
   */
  readonly files?: ReadonlyMap<string, Blob>;
}

export interface PreparedStandaloneManifest {
  manifest: ClassroomManifest;
  /** Image-like refs (not video/audio sources) that had to be dropped. */
  unresolved: string[];
  /**
   * Archive paths of the playback media the prepared manifest names (speech
   * `audioRef`s and video `mediaRef`s), in first-use order. The caller ships
   * exactly these.
   */
  playbackMedia: string[];
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
  return collectMediaSlots(manifest, (ref) => !isDataUri(ref));
}

/**
 * The `data:` image sources already inline in the document, in the slots the
 * ZIP variant ships as files: images, backgrounds, shape patterns and video
 * posters. Chart point images are left out (they must stay inline).
 */
export function collectInlineImageSources(manifest: Pick<ClassroomManifest, 'scenes'>): string[] {
  return [
    ...new Set(
      collectMediaSlots(
        manifest,
        (ref, role) => isDataUri(ref) && role !== 'chart-image' && role !== 'video',
      ).map(({ ref }) => ref),
    ),
  ];
}

function collectMediaSlots(
  manifest: Pick<ClassroomManifest, 'scenes'>,
  keep: (ref: string, role: StandaloneMediaRole) => boolean,
): StandaloneMediaReference[] {
  const refs: StandaloneMediaReference[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined, role: StandaloneMediaRole) => {
    if (!ref || !keep(ref, role)) return;
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
  /** As `resolve`, for a chart point image (always inline). */
  resolveChartImage(ref: string | undefined): string | undefined;
  /** The data URI for a ref, without recording a miss. */
  lookup(ref: string | undefined): string | undefined;
  markUnresolved(ref: string): void;
  /** Record that the prepared manifest names this playback media path. */
  usePlaybackMedia(path: string): void;
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
          const src = resolver.resolveChartImage(image);
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
      // The bytes, when they ship, are named by their archive path; the
      // player resolves it through its media table.
      const videos = media.playback?.videos;
      const playable =
        (src ? videos?.get(src) : undefined) ?? (mediaRef ? videos?.get(mediaRef) : undefined);
      if (playable) resolver.usePlaybackMedia(playable);
      // Playback media was asked for but this clip has no bytes: report it
      // (the video falls back to its poster).
      else if (videos && (src || mediaRef)) resolver.markUnresolved((src || mediaRef)!);
      return {
        ...rest,
        src: '',
        ...(poster ? { poster } : {}),
        ...(playable ? { mediaRef: playable } : {}),
      };
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

/**
 * Action types the offline player replays. Whiteboard actions never reach a
 * generated scene (only live chat produces them) and the player has no
 * whiteboard, so they are left out with any type this build does not know.
 */
/** A replayed action as the standalone manifest carries it. */
export type StandaloneAction =
  | (Omit<SpeechAction, 'audioId'> & { audioRef?: string })
  | SpotlightAction
  | LaserAction
  | PlayVideoAction
  | DiscussionAction
  | WidgetHighlightAction
  | WidgetSetStateAction
  | WidgetAnnotationAction
  | WidgetRevealAction;

const REPLAYED_ACTION_TYPES = new Set<string>([
  'speech',
  'spotlight',
  'laser',
  'play_video',
  'discussion',
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
]);

/**
 * The scene's playback actions as the offline player replays them, each
 * reduced to the fields it reads:
 *
 * - speech keeps its text, and its `audioRef` only when those bytes ship
 *   (otherwise the player paces it with the reading timer);
 * - discussion keeps its topic only; the agent binding and prompt drive a
 *   live AI discussion the file cannot hold;
 * - effects, video and widget actions keep their targets.
 */
export function prepareStandaloneActions(
  actions: readonly ManifestAction[] | undefined,
  shippedAudio: ReadonlySet<string> | undefined,
  resolver?: Pick<MediaResolver, 'usePlaybackMedia'>,
): ManifestAction[] {
  const prepared: StandaloneAction[] = [];
  for (const entry of actions ?? []) {
    if (!entry || !REPLAYED_ACTION_TYPES.has(entry.type)) continue;
    // `ManifestAction` is an Omit over the action union, which keeps only the
    // common fields; read each action through its own member type.
    const action = entry as unknown as StandaloneAction;
    const base = { id: action.id };
    switch (action.type) {
      case 'speech': {
        const audioRef =
          action.audioRef && shippedAudio?.has(action.audioRef) ? action.audioRef : undefined;
        if (audioRef) resolver?.usePlaybackMedia(audioRef);
        prepared.push({
          ...base,
          type: 'speech',
          text: typeof action.text === 'string' ? action.text : '',
          ...(audioRef ? { audioRef } : {}),
        });
        break;
      }
      case 'spotlight':
        prepared.push({
          ...base,
          type: 'spotlight',
          elementId: action.elementId,
          ...(action.dimOpacity !== undefined ? { dimOpacity: action.dimOpacity } : {}),
        });
        break;
      case 'laser':
        prepared.push({
          ...base,
          type: 'laser',
          elementId: action.elementId,
          ...(action.color ? { color: action.color } : {}),
        });
        break;
      case 'play_video':
        prepared.push({ ...base, type: 'play_video', elementId: action.elementId });
        break;
      case 'discussion':
        prepared.push({ ...base, type: 'discussion', topic: action.topic ?? '' });
        break;
      case 'widget_highlight':
      case 'widget_annotation':
      case 'widget_reveal':
        prepared.push({
          ...base,
          type: action.type,
          target: action.target,
          ...(action.content ? { content: action.content } : {}),
        });
        break;
      case 'widget_setState':
        prepared.push({
          ...base,
          type: 'widget_setState',
          state: action.state ?? {},
          ...(action.content ? { content: action.content } : {}),
        });
        break;
    }
  }
  return prepared as unknown as ManifestAction[];
}

/** A media source that carries or fetches bytes: any `data:` URI, a web or blob URL. */
const MEDIA_PAYLOAD_URL = /^\s*(?:https?:|blob:|data:)/i;

/** How deep nested `srcdoc` documents are searched for media. */
const MAX_SRCDOC_DEPTH = 4;

/**
 * Remove the audio and video sources of an interactive page that carry or
 * fetch media bytes: the `src` of `<video>`, `<audio>` and the `<source>`
 * elements inside them, whatever MIME type a `data:` URI declares, also in
 * documents nested through `<iframe srcdoc>` (to a bounded depth). The
 * elements stay, so the page still lays out.
 */
export function stripMediaPayloads(html: string, depth = 0): string {
  const patches: SourcePatch[] = [];
  for (const asset of analyzeHtmlAssetInventory(html).attributeAssets) {
    if (!asset.attributeRange) continue;
    if (asset.kind === 'iframe-srcdoc') {
      if (depth >= MAX_SRCDOC_DEPTH) {
        // Too deep to inspect: drop the nested document rather than ship it unchecked.
        patches.push({ range: asset.attributeRange, replacement: '' });
        continue;
      }
      const nested = stripMediaPayloads(asset.url, depth + 1);
      if (nested !== asset.url) {
        const patch = replaceAttributePatch(asset, nested);
        if (patch) patches.push(patch);
      }
      continue;
    }
    const isMediaSource =
      asset.kind === 'video' ||
      asset.kind === 'audio' ||
      (asset.kind === 'source' &&
        (asset.parentTagName === 'video' || asset.parentTagName === 'audio'));
    if (isMediaSource && MEDIA_PAYLOAD_URL.test(asset.url)) {
      patches.push({ range: asset.attributeRange, replacement: '' });
    }
  }
  return patches.length > 0 ? applySourcePatches(html, patches) : html;
}

function prepareScene(
  scene: ManifestScene,
  media: StandaloneMediaResolution,
  resolver: MediaResolver,
): ManifestScene {
  const actions = prepareStandaloneActions(scene.actions, media.playback?.audio, resolver);
  const rest: ManifestScene = {
    type: scene.type,
    title: scene.title,
    order: scene.order,
    content: scene.content,
    ...(actions.length > 0 ? { actions } : {}),
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
    // Without playback media the file carries no audio or video payloads
    // anywhere: interactive pages keep their other assets, not their clips.
    const html = content.html && !media.playback ? stripMediaPayloads(content.html) : content.html;
    return {
      ...rest,
      content: html
        ? { ...interactive, html: patchHtmlForIframe(html) }
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
  const playbackMedia = new Set<string>();
  const lookup = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    return media.dataUris.get(ref) ?? (isDataUri(ref) ? ref : undefined);
  };
  const lookupChartImage = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    if (isDataUri(ref)) return ref;
    return media.chartImages?.get(ref) ?? media.dataUris.get(ref);
  };
  const resolved = (source: string | undefined, ref: string | undefined) => {
    if (!source && ref) unresolved.add(ref);
    return source;
  };
  const resolver: MediaResolver = {
    lookup,
    resolve: (ref) => resolved(lookup(ref), ref),
    resolveChartImage: (ref) => resolved(lookupChartImage(ref), ref),
    markUnresolved: (ref) => unresolved.add(ref),
    usePlaybackMedia: (path) => playbackMedia.add(path),
  };
  const scenes = orderManifestScenes(manifest.scenes).map((scene) =>
    prepareScene(scene, media, resolver),
  );
  const { videoManifest: _videoManifest, ...stage } = manifest.stage;
  return {
    manifest: { ...manifest, stage, agents: [], scenes, mediaIndex: {} },
    unresolved: [...unresolved],
    playbackMedia: [...playbackMedia],
  };
}
