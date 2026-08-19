/**
 * Asset manifest — the standardized answer to "which assets does this document
 * reference?".
 *
 * ZIP, PPTX, and video export used to re-derive that set independently, and
 * the ZIP even derived it from a full scan of the local media tables, which
 * swept unreferenced rows into the archive. They now consume this enumeration.
 * The manifest is the set of references a document *touches*,
 * classified by role, with optional per-asset metadata layered on by the caller.
 *
 * An entry's `ref` is the reference exactly as the document holds it -- an
 * allocated asset id, a legacy placeholder, or a concrete URL. The enumeration
 * is deliberately not a content hash and not a resolution result: it is the
 * id-based reference set, so two exports of an unchanged document produce the
 * same manifest, and a reference whose bytes live nowhere still appears (it is
 * referenced; whether bytes resolve is a separate question each export answers
 * through its own resolver).
 *
 * The enumeration itself is pure and IO-free over the document: no DOM or
 * storage imports. Optional metadata enrichment is a caller-supplied callback;
 * it may perform caller-controlled work but must not mutate the document.
 */
import type { Action } from './action.js';
import type { Slide } from './slides.js';
import { slideMediaSlotDescriptors, type SlideMediaSlotKind } from './slide-media-slots.js';
import { isSlideContent, type Scene, type SceneType, type Stage } from './stage.js';

/** The role a referenced asset plays in the document. */
export type AssetKind = 'image' | 'video' | 'audio' | 'poster' | 'background';

/**
 * Provenance and byte metadata an export can attach to a manifest entry.
 *
 * Every field is optional: the enumeration is over the document, and a
 * referenced asset may have no stored record to read metadata from (bytes
 * pending, pruned, or never written locally). `durationSeconds` is seconds to
 * match the TTS-time duration the audio records already store.
 */
export interface AssetManifestMetadata {
  /** Size of the stored bytes, when known. */
  readonly byteSize?: number;
  /** MIME type of the stored bytes, e.g. `image/png`. */
  readonly mimeType?: string;
  /** Playback duration in seconds, for audio/video assets that recorded one. */
  readonly durationSeconds?: number;
  /** Voice the narration was synthesized with, for speech audio. */
  readonly voice?: string;
  /** Generation prompt the asset was produced from, for generated media. */
  readonly prompt?: string;
}

/**
 * One manifest entry: a reference the document touches, the role it plays
 * there, and whatever metadata the caller could supply for it.
 */
export interface AssetManifestEntry extends AssetManifestMetadata {
  /** The reference exactly as the document holds it. */
  readonly ref: string;
  readonly kind: AssetKind;
}

export interface AssetManifest {
  /**
   * One entry per distinct (reference, kind) pair, in document order (stage
   * whiteboard, then each scene's canvas, whiteboards and speech actions, then
   * the stage's video-manifest keys). The first occurrence of each pair keeps
   * its ordering slot.
   */
  readonly entries: readonly AssetManifestEntry[];
  /**
   * Logical owners per reference. An owner is the element, background, or
   * speech action holding the reference, so a video element repeating one ref
   * in both `src` and `mediaRef` counts once while its poster counts
   * separately -- the same accounting duplication-safe byte replacement uses.
   */
  readonly referenceCounts: ReadonlyMap<string, number>;
}

/** The document slice the enumeration reads: a stage plus its scenes. */
export interface AssetManifestDocument {
  readonly stage: Pick<Stage, 'whiteboard' | 'videoManifest'>;
  readonly scenes: readonly Scene<Action, { type: SceneType }>[];
}

export interface EnumerateAssetManifestOptions {
  /**
   * Supply per-asset metadata. Called once per distinct (reference, kind) pair;
   * return `undefined` when nothing is known. Only defined values are copied
   * onto the entry.
   */
  readonly metadata?: (ref: string, kind: AssetKind) => AssetManifestMetadata | undefined;
}

function manifestKind(slotKind: SlideMediaSlotKind): AssetKind {
  switch (slotKind) {
    case 'background-image':
      return 'background';
    case 'image-src':
      return 'image';
    case 'video-src':
    case 'video-media-ref':
      return 'video';
    case 'video-poster':
      return 'poster';
    case 'audio-src':
      return 'audio';
  }
}

/**
 * Enumerate the asset manifest of one document.
 *
 * The traversal order is the document's own: stage whiteboard slides first,
 * then scenes in order (canvas, whiteboards, speech actions), then the stage's
 * video-manifest keys. That order is what makes `entries` deterministic for a
 * fixed document, which the serialized views built on top (the ZIP
 * `mediaIndex`) rely on.
 */
export function enumerateAssetManifest(
  document: AssetManifestDocument,
  options: EnumerateAssetManifestOptions = {},
): AssetManifest {
  const kindsByRef = new Map<string, Set<AssetKind>>();
  const orderedPairs: Array<{ ref: string; kind: AssetKind }> = [];
  const ownerKeysByRef = new Map<string, Set<string>>();

  const record = (ref: string, kind: AssetKind, ownerKey: string) => {
    let kinds = kindsByRef.get(ref);
    if (!kinds) {
      kinds = new Set<AssetKind>();
      kindsByRef.set(ref, kinds);
    }
    if (!kinds.has(kind)) {
      kinds.add(kind);
      orderedPairs.push({ ref, kind });
    }
    let owners = ownerKeysByRef.get(ref);
    if (!owners) {
      owners = new Set<string>();
      ownerKeysByRef.set(ref, owners);
    }
    owners.add(ownerKey);
  };

  const visitSlide = (slide: Pick<Slide, 'background' | 'elements'>, scopeKey: string) => {
    for (const slot of slideMediaSlotDescriptors(slide)) {
      if (!slot.ref) continue;
      // Structural positions, rather than user-controlled ids, make owners
      // collision-free even for documents whose scene or element ids repeat.
      const ownerKey =
        slot.elementIndex !== undefined
          ? `${scopeKey}:element:${slot.elementIndex}`
          : `${scopeKey}:background`;
      record(
        slot.ref,
        manifestKind(slot.kind),
        slot.kind === 'video-poster' ? `${ownerKey}:poster` : ownerKey,
      );
    }
  };

  const stage = document.stage;
  for (let index = 0; index < (stage.whiteboard ?? []).length; index += 1) {
    const slide = stage.whiteboard![index];
    visitSlide(slide, `stage-whiteboard:${index}`);
  }

  for (let sceneIndex = 0; sceneIndex < document.scenes.length; sceneIndex += 1) {
    const scene = document.scenes[sceneIndex];
    if (isSlideContent(scene.content)) {
      visitSlide(scene.content.canvas, `scene:${sceneIndex}:canvas`);
    }
    for (let index = 0; index < (scene.whiteboards ?? []).length; index += 1) {
      const slide = scene.whiteboards![index];
      visitSlide(slide, `scene:${sceneIndex}:whiteboard:${index}`);
    }
    for (let index = 0; index < (scene.actions ?? []).length; index += 1) {
      const action = scene.actions![index];
      if (action.type !== 'speech' || !action.audioId) continue;
      record(action.audioId, 'audio', `scene:${sceneIndex}:speech:${index}`);
    }
  }

  // The video manifest names generated stage-level videos by the mediaRef a
  // PPTVideoElement would carry; each key is a referenced video asset. It is
  // an index over that asset, not another byte owner: replacement ownership
  // remains the element/background/action accounting described above. A
  // manifest-only ref is therefore enumerated but has no provable owner and
  // correctly cannot qualify for in-place replacement.
  for (const ref of Object.keys(stage.videoManifest ?? {})) {
    let kinds = kindsByRef.get(ref);
    if (!kinds) {
      kinds = new Set<AssetKind>();
      kindsByRef.set(ref, kinds);
    }
    if (!kinds.has('video')) {
      kinds.add('video');
      orderedPairs.push({ ref, kind: 'video' });
    }
  }

  const entries: AssetManifestEntry[] = [];
  for (const { ref, kind } of orderedPairs) {
    const metadata = options.metadata?.(ref, kind);
    entries.push({
      ref,
      kind,
      ...(metadata?.byteSize !== undefined ? { byteSize: metadata.byteSize } : {}),
      ...(metadata?.mimeType !== undefined ? { mimeType: metadata.mimeType } : {}),
      ...(metadata?.durationSeconds !== undefined
        ? { durationSeconds: metadata.durationSeconds }
        : {}),
      ...(metadata?.voice !== undefined ? { voice: metadata.voice } : {}),
      ...(metadata?.prompt !== undefined ? { prompt: metadata.prompt } : {}),
    });
  }

  const referenceCounts = new Map(
    [...ownerKeysByRef].map(([ref, owners]) => [ref, owners.size] as const),
  );

  return { entries, referenceCounts };
}
