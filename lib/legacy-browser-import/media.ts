/**
 * Media bytes that exist only in this browser's legacy stores, moved to the
 * server's asset pool the way the app's own paths move them.
 *
 * A course carries a reference the server cannot serve when its bytes are in
 * one of the old stores:
 *
 * - an allocated id (`ast_...`) from the browser asset pool (`maic-asset-pool`)
 *   of a browser-only build;
 * - a generation placeholder (`gen_img_*` / `gen_vid_*`) or an import-minted
 *   id whose bytes are in the old `mediaFiles` table under
 *   `<legacy course id>:<ref>`;
 * - a derived narration key (`tts_s<order>_<action>`) or other opaque audio id
 *   whose bytes are in the old `audioFiles` table.
 *
 * Each such reference is uploaded through `commitToPool` (the one client-side
 * "bytes to pool, id to document" sequence) and written back through the
 * existing funnels -- `persistGeneratedMediaReference` for slide media,
 * `persistNarrationReference` for speech -- which rewrite the document under
 * the per-course document lock and keep an open editor in step. Nothing here
 * invents a reference format: the document ends up exactly as the normal save
 * path would have left it.
 *
 * A refusal for want of room keeps the bytes where the app's own retry looks
 * for them, when such a path exists: a placeholder's bytes go to the device
 * cache's `mediaFiles` (the media pass adopts them instead of calling a
 * provider), narration to the device cache's `audioFiles` (narration adoption
 * uploads it on the next open). A reference with no such path stays pending in
 * the ledger and the importer retries it on a later load; its bytes are still
 * in the legacy store, which the importer never changes.
 */
import { rowBelongsToAction } from '@/lib/audio/adopt-cached-narration';
import { persistNarrationReference } from '@/lib/audio/persist-narration-reference';
import { db, mediaFileKey } from '@/lib/device-storage/database';
import type { AppDocument } from '@/lib/document-store';
import {
  readLegacyAudioFile,
  readLegacyMediaFiles,
  type AudioFileRecord,
  type MediaFileRecord,
} from '@/lib/legacy-browser-storage';
import {
  commitToPool,
  type PoolCommitOutcome,
  type RefusedPoolBytes,
} from '@/lib/media/commit-to-pool';
import { putAsset } from '@/lib/media/asset-pool';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { persistGeneratedMediaReference } from '@/lib/media/persist-media-reference';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import {
  slideMediaReferenceSlots,
  type SlideMediaReferenceKind,
} from '@/lib/media/slide-media-slots';

import { failureOrStop } from './errors';
import type { CourseEntry } from './ledger';
import type { LegacySources } from './sources';

/** Every media reference a document holds, with where it is held. */
export interface DocumentMediaRefs {
  /** Slide media slots (canvas, scene and stage whiteboards): ref -> slot kinds. */
  readonly slides: Map<string, Set<SlideMediaReferenceKind>>;
  /** Speech actions: audio id -> the action text (for the ownership check). */
  readonly speech: Map<string, string>;
}

export function collectDocumentMediaRefs(document: AppDocument): DocumentMediaRefs {
  const slides = new Map<string, Set<SlideMediaReferenceKind>>();
  const speech = new Map<string, string>();
  const visit = (slide: Parameters<typeof slideMediaReferenceSlots>[0]) => {
    for (const slot of slideMediaReferenceSlots(slide)) {
      const ref = slot.read();
      if (!ref) continue;
      let kinds = slides.get(ref);
      if (!kinds) slides.set(ref, (kinds = new Set()));
      kinds.add(slot.kind);
    }
  };
  for (const slide of document.stage.whiteboard ?? []) visit(slide);
  for (const scene of document.scenes) {
    if (scene.content?.type === 'slide') visit(scene.content.canvas);
    for (const whiteboard of scene.whiteboards ?? []) visit(whiteboard);
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.audioId) continue;
      if (!speech.has(action.audioId)) speech.set(action.audioId, action.text ?? '');
    }
  }
  return { slides, speech };
}

/** A reference that could name bytes only a legacy store holds. */
function isLocalReference(ref: string): boolean {
  return ref !== '' && !isConcreteMediaAddress(ref);
}

export interface MediaFillContext {
  /** The course's server id. */
  readonly stageId: string;
  /** The id the legacy stores know the course by. */
  readonly legacyStageId: string;
  readonly sources: LegacySources;
  /** Whether the server's pool already serves this allocated id. */
  readonly assetExists: (ref: string) => Promise<boolean>;
  readonly entry: CourseEntry;
  /** Persist the ledger after each settled reference. */
  readonly checkpoint: () => void;
}

export interface MediaFillResult {
  converted: number;
  pending: number;
}

type Upload =
  | {
      readonly family: 'slide';
      readonly ref: string;
      readonly bytes: Blob;
      readonly mimeType: string;
      readonly poster?: Blob;
      readonly retain?: (refused: RefusedPoolBytes) => Promise<void>;
    }
  | {
      readonly family: 'speech';
      readonly ref: string;
      readonly bytes: Blob;
      readonly mimeType: string;
      readonly durationSeconds?: number;
      readonly retain?: (refused: RefusedPoolBytes) => Promise<void>;
    };

function blobOf(value: unknown): Blob | undefined {
  return value instanceof Blob && value.size > 0 ? value : undefined;
}

/** Where the media pass looks for bytes a full store refused (placeholder-keyed). */
function retainMediaRow(stageId: string, ref: string, row: MediaFileRecord) {
  return async (): Promise<void> => {
    const id = mediaFileKey(stageId, ref);
    // A row the device cache already has is newer than the legacy copy.
    if (await db.mediaFiles.get(id)) return;
    await db.mediaFiles.put({ ...row, id, stageId });
  };
}

/** Where narration adoption looks for bytes (keyed by the derived id, scoped by course). */
function retainNarrationRow(stageId: string, row: AudioFileRecord) {
  return async (): Promise<void> => {
    if (await db.audioFiles.get(row.id)) return;
    await db.audioFiles.put({ ...row, stageId });
  };
}

async function planUploads(document: AppDocument, context: MediaFillContext): Promise<Upload[]> {
  const { slides, speech } = collectDocumentMediaRefs(document);
  const { sources, legacyStageId, stageId, entry } = context;
  const mediaRows = new Map<string, MediaFileRecord>();
  for (const row of await readLegacyMediaFiles(legacyStageId)) {
    const prefix = `${legacyStageId}:`;
    mediaRows.set(row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id, row);
  }

  const poolBlob = async (ref: string): Promise<Blob | undefined> => {
    if (!sources.assets || !(await sources.assets.exists(ref))) return undefined;
    // The server already serves it: a course from a server build, or a
    // reference an earlier run converted and a later edit brought back.
    if (await context.assetExists(ref)) return undefined;
    return blobOf(await sources.assets.readBlob(ref));
  };

  const uploads: Upload[] = [];
  for (const [ref, kinds] of slides) {
    if (!isLocalReference(ref) || entry.media?.[ref]?.status === 'failed') continue;
    if (mayNameAPoolAsset(ref)) {
      const bytes = await poolBlob(ref);
      if (bytes) {
        uploads.push({
          family: 'slide',
          ref,
          bytes,
          mimeType: bytes.type || 'application/octet-stream',
        });
      }
      continue;
    }
    const row = mediaRows.get(ref);
    const bytes = blobOf(row?.blob);
    if (row && bytes) {
      uploads.push({
        family: 'slide',
        ref,
        bytes,
        mimeType: bytes.type || row.mimeType,
        ...(blobOf(row.poster) ? { poster: row.poster } : {}),
        // Only a generation placeholder has a retry path that reads these
        // bytes back: the media pass adopts the cached row for it.
        ...(isGeneratedMediaPlaceholder(ref) ? { retain: retainMediaRow(stageId, ref, row) } : {}),
      });
      continue;
    }
    if (kinds.has('audio-src')) {
      // Slide audio an import put in the narration table.
      const audio = await readLegacyAudioFile(ref);
      const audioBytes = blobOf(audio?.blob);
      if (audio && audioBytes && (audio.stageId === undefined || audio.stageId === legacyStageId)) {
        uploads.push({
          family: 'slide',
          ref,
          bytes: audioBytes,
          mimeType: audioBytes.type || `audio/${audio.format}`,
        });
      }
    }
  }

  for (const [ref, text] of speech) {
    if (!isLocalReference(ref) || entry.media?.[ref]?.status === 'failed') continue;
    if (mayNameAPoolAsset(ref)) {
      const bytes = await poolBlob(ref);
      if (bytes) {
        uploads.push({ family: 'speech', ref, bytes, mimeType: bytes.type || 'audio/mpeg' });
      }
      continue;
    }
    const row = await readLegacyAudioFile(ref);
    const bytes = blobOf(row?.blob);
    if (!row || !bytes) continue;
    // The table is keyed by audio id alone, so two courses can hold the same
    // derived key; narration adoption's ownership rule decides, unchanged.
    if (!rowBelongsToAction(row, legacyStageId, { derivedRef: ref, text })) continue;
    uploads.push({
      family: 'speech',
      ref,
      bytes,
      mimeType: bytes.type || `audio/${row.format}`,
      ...(row.duration === undefined ? {} : { durationSeconds: row.duration }),
      retain: retainNarrationRow(stageId, row),
    });
  }
  return uploads;
}

async function commitUpload(upload: Upload, stageId: string): Promise<PoolCommitOutcome<unknown>> {
  if (upload.family === 'speech') {
    return commitToPool<boolean>({
      stageId,
      slot: upload.ref,
      bytes: upload.bytes,
      mimeType: upload.mimeType,
      ...(upload.durationSeconds === undefined
        ? {}
        : { meta: { durationSeconds: upload.durationSeconds } }),
      ...(upload.retain ? { retain: upload.retain } : {}),
      writeBack: (assetId) => persistNarrationReference(stageId, upload.ref, assetId),
      mirror: async () => undefined,
    });
  }
  // A poster that cannot be stored costs the poster, not the video.
  let posterAssetId: string | undefined;
  if (upload.poster) {
    posterAssetId = await putAsset(
      upload.poster,
      { contentType: upload.poster.type || 'image/jpeg' },
      { stageId },
    ).catch(() => undefined);
  }
  return commitToPool({
    stageId,
    slot: upload.ref,
    bytes: upload.bytes,
    mimeType: upload.mimeType,
    ...(upload.retain ? { retain: upload.retain } : {}),
    writeBack: (assetId) =>
      persistGeneratedMediaReference({
        stageId,
        placeholderRef: upload.ref,
        assetId,
        ...(posterAssetId ? { posterAssetId } : {}),
      }),
    mirror: async () => undefined,
  });
}

/**
 * Upload every reference of `document` whose bytes only a legacy store holds,
 * and write the allocated ids back. `document` is the server's current copy;
 * the write-back re-reads it under the document lock.
 */
export async function fillLegacyMedia(
  document: AppDocument,
  context: MediaFillContext,
): Promise<MediaFillResult> {
  const { entry } = context;
  const uploads = await planUploads(document, context);
  let converted = 0;
  let pending = 0;
  const settle = (
    ref: string,
    outcome: { status: 'pending' | 'failed'; reason: string } | null,
  ) => {
    const media = (entry.media ??= {});
    if (outcome) media[ref] = outcome;
    else delete media[ref];
    context.checkpoint();
  };

  for (const upload of uploads) {
    let outcome: PoolCommitOutcome<unknown>;
    try {
      outcome = await commitUpload(upload, context.stageId);
    } catch (error) {
      // The write-back threw: the bytes are stored, the document write is not
      // known to have landed. A later run finds the reference still in the
      // document (and uploads again) or finds it converted.
      const failure = failureOrStop(error);
      const permanent = failure.kind === 'permanent' || failure.kind === 'forbidden';
      settle(upload.ref, { status: permanent ? 'failed' : 'pending', reason: failure.reason });
      if (!permanent) pending += 1;
      continue;
    }
    if (outcome.status === 'stored') {
      converted += 1;
      settle(upload.ref, null);
      continue;
    }
    if (outcome.status === 'refused-retained') {
      if (upload.retain) {
        // The app's own retry path now holds the bytes; the importer is done
        // with this reference.
        settle(upload.ref, {
          status: 'failed',
          reason: `${outcome.code}: kept in the device cache for the app's retry`,
        });
      } else {
        pending += 1;
        settle(upload.ref, { status: 'pending', reason: outcome.code });
      }
      continue;
    }
    const failure = failureOrStop(outcome.error);
    const permanent = failure.kind === 'permanent' || failure.kind === 'forbidden';
    if (!permanent) pending += 1;
    settle(upload.ref, { status: permanent ? 'failed' : 'pending', reason: failure.reason });
  }

  // References that were pending but are no longer candidates (converted by
  // the app, or edited away) are settled.
  const planned = new Set(uploads.map((upload) => upload.ref));
  for (const [ref, outcome] of Object.entries(entry.media ?? {})) {
    if (outcome.status === 'pending' && !planned.has(ref)) settle(ref, null);
  }
  return { converted, pending };
}
