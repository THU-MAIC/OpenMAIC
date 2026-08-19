import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import type { ManifestAction } from './classroom-zip-types';
import { db } from '@/lib/utils/database';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { fetchMediaUrl } from '@/lib/media/fetch-media-url';
import { mapWithConcurrency } from '@/lib/media/convert-legacy-asset-refs';
import { mediaRefFromRecordId, resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';

// ─── Export: Collect Media ─────────────────────────────────────

export interface CollectedAudio {
  zipPath: string;
  record: AudioFileRecord;
}

export interface CollectedMedia {
  zipPath: string;
  record: MediaFileRecord;
  elementId: string;
}

export async function collectAudioFiles(scenes: Scene[]): Promise<CollectedAudio[]> {
  const audioIds = new Set<string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && (action as SpeechAction).audioId) {
        audioIds.add((action as SpeechAction).audioId!);
      }
    }
  }
  const collected: CollectedAudio[] = [];
  for (const audioId of audioIds) {
    const record = await db.audioFiles.get(audioId);
    // The pool answers first: after a stable-id regeneration whose mirror write
    // failed, the row holds the superseded narration.
    const blob = await resolveAudioBlob(audioId);
    // A row with no usable bytes -- an evicted row (empty blob, no pool
    // resolve) -- must not ship an empty audio file. It produces no zip
    // path, so the URL rescue in collectLegacyAudioForExport sees the id as
    // missing and fetches the live co-present URL instead.
    if (blob && blob.size > 0) {
      const ext = record?.format || 'mp3';
      const resolved = (record ? { ...record, blob } : { id: audioId, blob }) as AudioFileRecord;
      collected.push({ zipPath: `audio/${audioId}.${ext}`, record: resolved });
    }
  }
  return collected;
}

/**
 * A same-id replacement commits the new bytes to the pool first; if the
 * compatibility write then fails, the task records
 * `MEDIA_COMPATIBILITY_STORE_LAGGED` and the document deliberately keeps the
 * same reference. Rendering and the other export paths resolve the pool, so the
 * ZIP must too -- otherwise it ships media the classroom no longer shows. The
 * ZIP predates the `response.ok` validation the other export paths added and
 * keeps that laxity, but a zero-byte pool answer is not usable bytes: the
 * compatibility row stays the fallback rather than shipping an empty file.
 */
async function pooledBytesForRef(ref: string): Promise<Blob | null> {
  return resolveStoredBytes(ref, {
    fetchPolicy: { requireOk: false, requireNonEmpty: true },
  });
}

export async function collectMediaFiles(stageId: string): Promise<CollectedMedia[]> {
  const records = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  // A converted asset exists as two rows: the legacy row (keyed by the
  // original gen_* placeholder) and the allocated-id compatibility mirror
  // (placeholderRef retained). The document now references the mirror, so the
  // ZIP must ship each logical asset once -- the mirror -- and skip the legacy
  // row it mirrors: importing the archive would otherwise materialize an
  // unreferenced duplicate and inflate the round trip. Audio avoids this by
  // deriving its rows from the document's speech actions instead of
  // enumerating the table.
  const supersededLegacyRefs = new Set(
    records
      .map((row) => mediaRefFromRecordId(row.id))
      .filter((ref) => records.some((row) => row.placeholderRef === ref)),
  );
  const collected: CollectedMedia[] = [];
  for (const record of records) {
    const elementId = mediaRefFromRecordId(record.id);
    if (supersededLegacyRefs.has(elementId)) continue;
    const ext = record.mimeType?.split('/')[1] || 'jpg';
    const pooled = await pooledBytesForRef(elementId);
    collected.push({
      zipPath: `media/${elementId}.${ext}`,
      record: pooled ? { ...record, blob: pooled } : record,
      elementId,
    });
  }
  return collected;
}

// ─── Export: Action Serialization ──────────────────────────────

/** Bytes fetched from a legacy audio URL during export, with its assigned archive path. */
export interface LegacyAudioBlob {
  zipPath: string;
  blob: Blob;
  format: string;
}

/**
 * Fetch the legacy audio URLs no local row backs, so an unconverted
 * document's narration still reaches the archive: the field itself never
 * enters the manifest, so its bytes must. Cross-origin URLs go through the
 * same-origin media proxy (CORS-locked exactly where an <audio> element
 * would still play), unique URLs first, then a bounded concurrent fetch so a
 * stalled endpoint costs one timeout rather than one per clip. URLs that
 * will not fetch are skipped -- the same outcome the converter gives a dead
 * URL.
 */
export async function collectLegacyAudioForExport(
  scenes: readonly Scene[],
  audioIdToPath: Map<string, string>,
): Promise<{ audioUrlToPath: Map<string, string>; blobs: LegacyAudioBlob[] }> {
  const uniqueLegacyUrls = new Set<string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech') continue;
      const legacyUrl = (action as { audioUrl?: string }).audioUrl;
      if (!legacyUrl) continue;
      const stampedId = (action as SpeechAction).audioId;
      if (stampedId && audioIdToPath.has(stampedId)) continue;
      uniqueLegacyUrls.add(legacyUrl);
    }
  }
  const blobs: LegacyAudioBlob[] = [];
  const audioUrlToPath = new Map<string, string>();
  const fetched = await mapWithConcurrency([...uniqueLegacyUrls], 4, async (url) => {
    try {
      const response = await fetchMediaUrl(url, 15_000);
      if (!response.ok) return { url, blob: null };
      const blob = await response.blob();
      // Zero-byte responses are not narration: skip the entry (the same
      // outcome the converter gives an unusable URL) rather than archiving
      // an empty file.
      return { url, blob: blob.size > 0 ? blob : null };
    } catch {
      return { url, blob: null };
    }
  });
  for (const { url, blob } of fetched) {
    if (!blob) continue;
    const format = blob.type.split('/')[1] || 'mp3';
    const zipPath = `audio/legacy-${blobs.length + 1}.${format}`;
    audioUrlToPath.set(url, zipPath);
    blobs.push({ zipPath, blob, format });
  }
  return { audioUrlToPath, blobs };
}

export function actionsToManifest(
  actions: Action[],
  audioIdToPath: Map<string, string>,
  agentIdToIndex: Map<string, number> = new Map(),
  audioUrlToPath: Map<string, string> = new Map(),
): ManifestAction[] {
  return actions.map((action) => {
    if (action.type === 'speech') {
      const speech = action as SpeechAction;
      // A legacy audioUrl never enters the manifest: the type is gone from
      // the contract, but an unconverted document can still carry one at
      // runtime, and a bare rest-spread would export it. Its bytes travel
      // instead, fetched at export time and mapped to their own zip path.
      const {
        audioId,
        audioUrl: _legacyAudioUrl,
        ...rest
      } = speech as SpeechAction & {
        audioUrl?: string;
      };
      const audioRef =
        (audioId ? audioIdToPath.get(audioId) : undefined) ??
        (_legacyAudioUrl ? audioUrlToPath.get(_legacyAudioUrl) : undefined);
      return {
        ...rest,
        ...(audioRef ? { audioRef } : {}),
      } as ManifestAction;
    }
    if (action.type === 'discussion') {
      const discussion = action as DiscussionAction;
      const { agentId, ...rest } = discussion;
      const agentIndex = agentId ? agentIdToIndex.get(agentId) : undefined;
      return {
        ...rest,
        ...(agentIndex !== undefined ? { agentIndex } : agentId ? { agentId } : {}),
      } as ManifestAction;
    }
    return action as ManifestAction;
  });
}

// ─── Import: Reference Rewriting ───────────────────────────────

interface RewriteManifestActionOptions {
  agentIds?: string[];
  fallbackDiscussionAgentIndex?: number;
}

/**
 * Speech references that would dangle in the exported ZIP: an audioId with no
 * archive row and no recovered fallback. A legacy audioUrl that WAS recovered
 * travels under its own zip path (`actionsToManifest` maps the action to it),
 * so the same narration must not also be flagged missing under a phantom
 * `audio/${audioId}.mp3` path.
 */
export function collectMissingAudioRefs(
  scenes: readonly Scene[],
  audioIdToPath: Map<string, string>,
  audioUrlToPath: Map<string, string>,
): Array<{ audioId: string; missingPath: string }> {
  const missing: Array<{ audioId: string; missingPath: string }> = [];
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech') continue;
      const speech = action as SpeechAction & { audioUrl?: string };
      const audioId = speech.audioId;
      if (!audioId || audioIdToPath.has(audioId)) continue;
      if (speech.audioUrl && audioUrlToPath.has(speech.audioUrl)) continue;
      missing.push({ audioId, missingPath: `audio/${audioId}.mp3` });
    }
  }
  return missing;
}

export function rewriteAudioRefsToIds(
  actions: ManifestAction[],
  audioRefMap: Record<string, string>,
  options: RewriteManifestActionOptions = {},
): Action[] {
  return actions.map((action) => {
    if (action.type === 'speech' && 'audioRef' in action) {
      const { audioRef, ...rest } = action;
      const audioId = audioRef ? audioRefMap[audioRef] : undefined;
      return {
        ...rest,
        ...(audioId ? { audioId } : {}),
      } as Action;
    }
    if (action.type === 'discussion') {
      const {
        agentIndex,
        agentId: legacyAgentId,
        ...rest
      } = action as ManifestAction & { type: 'discussion'; agentIndex?: number; agentId?: string };
      const indexedAgentId =
        typeof agentIndex === 'number' ? options.agentIds?.[agentIndex] : undefined;
      const preservedLegacyAgentId =
        legacyAgentId && (!options.agentIds?.length || options.agentIds.includes(legacyAgentId))
          ? legacyAgentId
          : undefined;
      const fallbackAgentId =
        typeof options.fallbackDiscussionAgentIndex === 'number'
          ? options.agentIds?.[options.fallbackDiscussionAgentIndex]
          : undefined;

      return {
        ...rest,
        ...(indexedAgentId || preservedLegacyAgentId || fallbackAgentId
          ? { agentId: indexedAgentId || preservedLegacyAgentId || fallbackAgentId }
          : {}),
      } as Action;
    }
    return action as Action;
  });
}
