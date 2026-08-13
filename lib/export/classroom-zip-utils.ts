import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import type { ManifestAction } from './classroom-zip-types';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { AssetManifestEntry } from '@openmaic/dsl';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { fetchMediaUrl } from '@/lib/media/fetch-media-url';
import { mapWithConcurrency } from '@/lib/media/convert-legacy-asset-refs';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';

// ─── Export: Collect Media ─────────────────────────────────────

export interface CollectedAudio {
  zipPath: string;
  sourceRef: string;
  record: AudioFileRecord;
}

export interface CollectedMedia {
  zipPath: string;
  record: MediaFileRecord;
  elementId: string;
}

/**
 * Collect the bytes of every audio entry selected by the classroom export.
 * That set includes speech narration and reconstructable slide-audio refs, so
 * no table scan runs here and an orphan audio row cannot ride into the archive.
 * Bytes come only from the shared resolver (pool-first, with the
 * compatibility-row fallback inside it); the row read here supplies the
 * archive's format/duration/voice metadata.
 */
export async function collectAudioFiles(
  entries: readonly AssetManifestEntry[],
): Promise<CollectedAudio[]> {
  const collected: CollectedAudio[] = [];
  for (const entry of entries) {
    const audioId = entry.ref;
    // The pool answers first: after a stable-id regeneration whose mirror
    // write failed, the row holds the superseded narration. A ref whose bytes
    // resolve nowhere ships nothing; the caller marks it missing.
    const blob = await resolveAudioBlob(audioId);
    // A row with no usable bytes -- an evicted row (empty blob, no pool
    // resolve) -- must not ship an empty audio file.
    if (!blob || blob.size === 0) continue;
    const record = await db.audioFiles.get(audioId);
    const ext = record?.format || 'mp3';
    const resolved = (record ? { ...record, blob } : { id: audioId, blob }) as AudioFileRecord;
    collected.push({ zipPath: `audio/${audioId}.${ext}`, sourceRef: entry.ref, record: resolved });
  }
  return collected;
}

/**
 * Collect the bytes of every media entry (image/video/poster/background) in
 * the asset manifest. Only referenced assets are archived: the pre-manifest
 * implementation scanned the whole `mediaFiles` table for the stage, which
 * swept rows no document element still references into the ZIP.
 *
 * Bytes come from the shared resolver, pool-first with the supplied
 * compatibility record's blob as its legacy row-fallback level -- so a
 * same-id replacement whose mirror write lagged
 * (MEDIA_COMPATIBILITY_STORE_LAGGED) ships what the classroom renders, and a
 * referenced asset whose bytes exist only in the pool is collected with a
 * synthesized record. A failed row (error set, empty placeholder blob) yields
 * no bytes and ships no empty file. The ZIP predates the response validation
 * the other export paths added, so it keeps its historical lax fetch policy.
 */
export async function collectMediaFiles(
  stageId: string,
  entries: readonly AssetManifestEntry[],
): Promise<CollectedMedia[]> {
  const collected: CollectedMedia[] = [];
  for (const entry of entries) {
    const ref = entry.ref;
    const record = await db.mediaFiles.get(mediaFileKey(stageId, ref)).catch(() => undefined);
    const blob = await resolveStoredBytes(ref, {
      record,
      fetchPolicy: { requireOk: false, requireNonEmpty: true },
    });
    // Referenced but with bytes nowhere (pending generation, pruned, failed):
    // the archive simply lacks the file, as it did when no row existed.
    if (!blob) continue;
    const effective: MediaFileRecord = record
      ? { ...record, blob }
      : {
          id: mediaFileKey(stageId, ref),
          stageId,
          type: blob.type.startsWith('video/') ? 'video' : 'image',
          blob,
          mimeType: blob.type,
          size: blob.size,
          prompt: '',
          params: '',
          createdAt: 0,
        };
    const ext = effective.mimeType?.split('/')[1] || 'jpg';
    collected.push({ zipPath: `media/${ref}.${ext}`, record: effective, elementId: ref });
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

export function rewriteAudioRefsToIds(
  actions: ManifestAction[],
  audioRefMap: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
  options: RewriteManifestActionOptions = {},
): Action[] {
  return actions.map((action) => {
    if (action.type === 'speech' && 'audioRef' in action) {
      const { audioRef, ...rest } = action;
      const mapped = audioRef
        ? audioRefMap instanceof Map
          ? audioRefMap.get(audioRef)
          : (audioRefMap as Readonly<Record<string, unknown>>)[audioRef]
        : undefined;
      const audioId = typeof mapped === 'string' ? mapped : undefined;
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
