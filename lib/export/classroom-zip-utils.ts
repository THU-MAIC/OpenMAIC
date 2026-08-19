import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import type { ManifestAction, MediaIndexEntry } from './classroom-zip-types';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { AssetManifestEntry } from '@openmaic/dsl';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { fetchMediaUrl } from '@/lib/media/fetch-media-url';
import { mapWithConcurrency } from '@/lib/media/convert-legacy-asset-refs';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import { canonicalArchiveMedia } from '@/lib/video-export/archive-media';

// ─── Export: Collect Media ─────────────────────────────────────

export interface CollectedAudio {
  zipPath: string;
  sourceRef: string;
  record: AudioFileRecord;
  /** Canonical serialized MIME paired with `record.format` and `zipPath`. */
  mimeType: string;
}

export interface CollectedMedia {
  zipPath: string;
  posterZipPath: string;
  sourceRef: string;
  record: MediaFileRecord;
  elementId: string;
}

/** Exact media-index metadata serialized for one collected narration asset. */
export function collectedAudioMediaIndexEntry(file: CollectedAudio): MediaIndexEntry {
  return {
    type: 'audio',
    sourceRef: file.sourceRef,
    format: file.record.format,
    mimeType: file.mimeType,
    duration: file.record.duration,
    voice: file.record.voice,
  };
}

/** Exact media-index metadata serialized for one collected generated-media asset. */
export function collectedMediaIndexEntry(file: CollectedMedia): MediaIndexEntry {
  return {
    type: 'generated',
    sourceRef: file.sourceRef,
    mimeType: file.record.mimeType,
    size: file.record.size,
    prompt: file.record.prompt,
  };
}

const AUDIO_ARCHIVE_EXTENSIONS = new Set([
  'aac',
  'flac',
  'm4a',
  'mp3',
  'mp4',
  'mpeg',
  'ogg',
  'opus',
  'wav',
  'webm',
]);
const MEDIA_ARCHIVE_EXTENSIONS = new Set([
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'm4v',
  'mov',
  'mp4',
  'ogv',
  'png',
  'svg',
  'webm',
  'webp',
]);

/**
 * Accept only one allowlisted filename suffix. Slashes, backslashes, dot
 * segments, parameters, and unknown values all fall back instead of entering
 * an archive path.
 *
 * Contract boundary: archive paths, extensions, and serialized MIME metadata
 * are a mutually coherent, canonical function of authoritative kind metadata.
 * This code does not inspect or transcode bytes and therefore does not promise
 * that those labels describe the payload. A byte/kind mismatch is already-
 * corrupt store state outside the export contract; runtime and renderer
 * consumers likewise trust the kind metadata.
 */
function canonicalArchiveExtension(
  extension: string | undefined,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  if (typeof extension !== 'string' || !/^[a-z0-9]+$/i.test(extension)) return fallback;
  const canonical = extension.toLowerCase();
  return allowed.has(canonical) ? canonical : fallback;
}

export function audioArchivePath(index: number, extension: string | undefined): string {
  return `audio/audio-${index + 1}.${canonicalArchiveExtension(
    extension,
    AUDIO_ARCHIVE_EXTENSIONS,
    'mp3',
  )}`;
}

export function legacyAudioArchivePath(index: number, extension: string | undefined): string {
  return `audio/legacy-${index + 1}.${canonicalArchiveExtension(
    extension,
    AUDIO_ARCHIVE_EXTENSIONS,
    'mp3',
  )}`;
}

export function mediaArchivePath(index: number, extension: string | undefined): string {
  return `media/asset-${index + 1}.${canonicalArchiveExtension(
    extension,
    MEDIA_ARCHIVE_EXTENSIONS,
    'jpg',
  )}`;
}

export function mediaPosterArchiveMetadata() {
  return canonicalArchiveMedia('image', {});
}

export function mediaPosterArchivePath(index: number): string {
  const { extension } = mediaPosterArchiveMetadata();
  return `media/asset-${index + 1}.poster.${extension}`;
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
  for (const [index, entry] of entries.entries()) {
    const audioId = entry.ref;
    // The pool answers first: after a stable-id regeneration whose mirror
    // write failed, the row holds the superseded narration. A ref whose bytes
    // resolve nowhere ships nothing; the caller marks it missing.
    const blob = await resolveAudioBlob(audioId);
    // A row with no usable bytes -- an evicted row (empty blob, no pool
    // resolve) -- must not ship an empty audio file.
    if (!blob || blob.size === 0) continue;
    const record = await db.audioFiles.get(audioId);
    const canonical = canonicalArchiveMedia('audio', { extension: record?.format });
    const ext = canonical.extension;
    const resolved = (
      record ? { ...record, blob, format: ext } : { id: audioId, blob, format: ext }
    ) as AudioFileRecord;
    collected.push({
      zipPath: audioArchivePath(index, ext),
      sourceRef: entry.ref,
      record: resolved,
      mimeType: canonical.mimeType,
    });
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
  for (const [index, entry] of entries.entries()) {
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
    // The record kind is authoritative. Canonicalization makes the archive path
    // and serialized MIME agree with it; it intentionally does not sniff or
    // transcode `blob`, whose bytes may expose already-corrupt store state.
    const kind: MediaFileRecord['type'] = effective.type === 'video' ? 'video' : 'image';
    const canonical = canonicalArchiveMedia(kind, { mimeType: effective.mimeType });
    const normalized = { ...effective, type: kind, mimeType: canonical.mimeType };
    collected.push({
      zipPath: mediaArchivePath(index, canonical.extension),
      posterZipPath: mediaPosterArchivePath(index),
      sourceRef: entry.ref,
      record: normalized,
      elementId: ref,
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
  mimeType: string;
  /** The legacy URL the narration was fetched from — its natural source ref. */
  sourceRef: string;
}

/** Exact media-index metadata serialized for one fetched legacy narration asset. */
export function legacyAudioMediaIndexEntry(file: LegacyAudioBlob): MediaIndexEntry {
  return {
    type: 'audio',
    sourceRef: file.sourceRef,
    format: file.format,
    mimeType: file.mimeType,
  };
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
    const canonical = canonicalArchiveMedia('audio', { mimeType: blob.type });
    const format = canonical.extension;
    const zipPath = legacyAudioArchivePath(blobs.length, format);
    audioUrlToPath.set(url, zipPath);
    blobs.push({ zipPath, blob, format, mimeType: canonical.mimeType, sourceRef: url });
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
      const mapped =
        typeof audioRef === 'string'
          ? audioRefMap instanceof Map
            ? audioRefMap.get(audioRef)
            : Object.hasOwn(audioRefMap, audioRef)
              ? (audioRefMap as Readonly<Record<string, unknown>>)[audioRef]
              : undefined
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
