import { enumerateAssetManifest, type Slide } from '@openmaic/dsl';
import type { Scene, Stage } from '@/lib/types/stage';
import { slideMediaReferenceSlots } from './slide-media-slots';

export interface StageAssetDocument {
  readonly stage: Stage;
  readonly scenes: readonly Scene[];
}

export interface StageAssetRefs {
  readonly imageSrc: ReadonlySet<string>;
  readonly slideAudioSrc: ReadonlySet<string>;
  readonly videoSrc: ReadonlySet<string>;
  readonly videoMediaRef: ReadonlySet<string>;
  readonly poster: ReadonlySet<string>;
  readonly backgroundImage: ReadonlySet<string>;
  readonly stageWhiteboard: ReadonlySet<string>;
  readonly sceneWhiteboard: ReadonlySet<string>;
  readonly speechAudioId: ReadonlySet<string>;
  readonly videoManifestKey: ReadonlySet<string>;
  /** Refs held by renderable elements or speech cues (manifest metadata excluded). */
  readonly referenced: ReadonlySet<string>;
  /** Every document ref, including video-manifest metadata. */
  readonly document: ReadonlySet<string>;
  /** Logical owners per ref; video src+mediaRef on one element count once. */
  readonly referenceCounts: ReadonlyMap<string, number>;
}

export interface PersistedDocumentAssetRefs {
  /** Logical-owner totals across every supplied persisted document. */
  readonly referenceCounts: ReadonlyMap<string, number>;
  /** Per-document results from the same stage enumerator used by deletion. */
  readonly byDocument: ReadonlyMap<string, StageAssetRefs>;
}

function addValue(target: Set<string>, value: string | undefined): value is string {
  if (!value) return false;
  target.add(value);
  return true;
}

/**
 * Enumerate what a stage's document references, without performing I/O.
 *
 * Document refs only: the local media cache is not consulted, because the
 * question this answers — which ids does this document claim — is now asked of
 * the document alone. The server maintains the other direction (which entries
 * any document still claims) in its own reference table.
 *
 * Categories intentionally overlap: a whiteboard image belongs to both
 * `imageSrc` and its whiteboard category. `referenceCounts` counts the logical
 * owning element/action only once, which is what duplication-safe replacement
 * needs when a video repeats the same ref in both `src` and `mediaRef`.
 */
export function collectStageAssetRefs(document: StageAssetDocument | null): StageAssetRefs {
  const imageSrc = new Set<string>();
  const slideAudioSrc = new Set<string>();
  const videoSrc = new Set<string>();
  const videoMediaRef = new Set<string>();
  const poster = new Set<string>();
  const backgroundImage = new Set<string>();
  const stageWhiteboard = new Set<string>();
  const sceneWhiteboard = new Set<string>();
  const speechAudioId = new Set<string>();
  const videoManifestKey = new Set<string>();
  const referenced = new Set<string>();
  const visitSlide = (
    slide: Pick<Slide, 'id' | 'elements' | 'background'>,
    scope: 'scene' | 'stage-whiteboard' | 'scene-whiteboard',
  ) => {
    for (const slot of slideMediaReferenceSlots(slide)) {
      const ref = slot.read();
      if (!ref) continue;
      const whiteboardCategory =
        scope === 'stage-whiteboard'
          ? stageWhiteboard
          : scope === 'scene-whiteboard'
            ? sceneWhiteboard
            : undefined;

      if (slot.kind === 'background-image') addValue(backgroundImage, ref);
      else if (slot.kind === 'image-src') addValue(imageSrc, ref);
      else if (slot.kind === 'audio-src') addValue(slideAudioSrc, ref);
      else if (slot.kind === 'video-src') addValue(videoSrc, ref);
      else if (slot.kind === 'video-media-ref') addValue(videoMediaRef, ref);
      else addValue(poster, ref);
      referenced.add(ref);
      whiteboardCategory?.add(ref);
    }
  };

  if (document) {
    for (let index = 0; index < (document.stage.whiteboard ?? []).length; index += 1) {
      const slide = document.stage.whiteboard![index];
      visitSlide(slide, 'stage-whiteboard');
    }

    for (const scene of document.scenes) {
      if (scene.content.type === 'slide') {
        visitSlide(scene.content.canvas, 'scene');
      }
      for (let index = 0; index < (scene.whiteboards ?? []).length; index += 1) {
        const slide = scene.whiteboards![index];
        visitSlide(slide, 'scene-whiteboard');
      }
      for (let index = 0; index < (scene.actions ?? []).length; index += 1) {
        const action = scene.actions![index];
        if (action.type !== 'speech' || !action.audioId) continue;
        speechAudioId.add(action.audioId);
        referenced.add(action.audioId);
      }
    }

    for (const ref of Object.keys(document.stage.videoManifest ?? {})) {
      videoManifestKey.add(ref);
    }
  }

  const documentRefs = new Set([...referenced, ...videoManifestKey]);
  // Consume the DSL's position-keyed ownership accounting directly. Keeping
  // one implementation prevents user-controlled duplicate scene/slide/
  // element/action ids from collapsing distinct owners here.
  const referenceCounts = document
    ? new Map(enumerateAssetManifest(document).referenceCounts)
    : new Map<string, number>();

  return {
    imageSrc,
    slideAudioSrc,
    videoSrc,
    videoMediaRef,
    poster,
    backgroundImage,
    stageWhiteboard,
    sceneWhiteboard,
    speechAudioId,
    videoManifestKey,
    referenced,
    document: documentRefs,
    referenceCounts,
  };
}

/** Aggregate logical asset owners without introducing a second ref heuristic. */
export function collectPersistedDocumentAssetRefs(
  documents: readonly StageAssetDocument[],
): PersistedDocumentAssetRefs {
  const referenceCounts = new Map<string, number>();
  const byDocument = new Map<string, StageAssetRefs>();

  for (const document of documents) {
    const refs = collectStageAssetRefs(document);
    byDocument.set(document.stage.id, refs);
    for (const [ref, count] of refs.referenceCounts) {
      referenceCounts.set(ref, (referenceCounts.get(ref) ?? 0) + count);
    }
  }

  return { referenceCounts, byDocument };
}
