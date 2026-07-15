/**
 * `assets` pass — dedup + zip layout / naming plan.
 *
 * Turns the referenced narration audio, media (`play_video` targets) and base
 * frames into a deterministic set of {@link AssetPlanEntry} paths, and stamps the
 * resolved `assetRef` / `assetId` / `present` back onto the narration and video
 * segments. It plans *layout and naming only* — the actual bytes are collected by
 * the browser-side implementation in the next phase (P1d); {@link AssetSource}
 * supplies just enough metadata (id, mime/format, presence) to build the plan.
 *
 * Deduplication is by `assetId`: the first reference owns the path, later
 * references reuse it and carry `dedupOf`. A referenced-but-absent asset is kept
 * in the plan as `present: false` with a `skipped-media` diagnostic, so the
 * report shows the gap instead of hiding it.
 *
 * The filename sanitize / unique-name helpers are small reimplementations of the
 * app export planner's logic (independent by design — see plan).
 *
 * Pure: no IO; asset metadata arrives through the injected source.
 */
import type { SpeechAction } from '@openmaic/dsl';
import type { AssetSource, AssetMeta, CompilerScene } from '../deps';
import type { AssetKind, AssetPlan, AssetPlanEntry, Diagnostic, VideoTimelineScene } from '../ir';

export interface AssetsResult {
  scenes: VideoTimelineScene[];
  plan: AssetPlan;
  diagnostics: Diagnostic[];
}

/** Sanitize one path segment (scene title / element id) into a safe filename part. */
export function sanitizeFilenamePart(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return normalized.slice(0, 80) || 'scene';
}

/**
 * File extension for an asset from its `format`/`mimeType`, falling back per
 * kind. The result is sanitized to a bare, traversal-free extension token
 * (alphanumeric, lowercased) so a hostile `format` such as `../../escape` cannot
 * steer the planned zip path outside its directory — the ZIP-writing stage
 * receives only safe extensions.
 */
function extension(meta: AssetMeta, fallback: string): string {
  const raw = extensionRaw(meta, fallback);
  const safe = raw
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '');
  return safe || fallback;
}

/** The unsanitized extension candidate from `format` / `mimeType` / fallback. */
function extensionRaw(meta: AssetMeta, fallback: string): string {
  if (meta.format) return meta.format.replace(/^\./, '');
  const mime = meta.mimeType;
  if (mime) {
    const known: Record<string, string> = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/webm': 'weba',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
    };
    if (known[mime]) return known[mime];
    const sub = mime.split('/')[1];
    if (sub) return sub;
  }
  return fallback;
}

/** Planner state: tracks used paths (for collision suffixes) and asset dedup. */
class AssetPlanner {
  readonly entries: AssetPlanEntry[] = [];
  private readonly usedPaths = new Map<string, number>();
  /** assetId → the first (owner) entry, whose path + presence every later ref inherits. */
  private readonly owner = new Map<string, AssetPlanEntry>();

  /**
   * Plan one asset reference. Returns the path it maps to and the *authoritative*
   * presence for its `assetId`.
   *
   * Presence is a property of the asset id, not of an individual reference: the
   * first reference to an id decides it, and every later reference (and the
   * caller's segment) inherits that value. This keeps the plan internally
   * consistent even if an {@link AssetSource} returns inconsistent `present` for
   * the same id — otherwise a dedup entry could claim a different presence than
   * its owner.
   */
  plan(
    assetId: string,
    kind: AssetKind,
    desiredPath: string,
    present: boolean,
  ): { path: string; present: boolean } {
    const existing = this.owner.get(assetId);
    if (existing) {
      this.entries.push({
        assetId,
        kind,
        path: existing.path,
        present: existing.present,
        dedupOf: assetId,
      });
      return { path: existing.path, present: existing.present };
    }
    const path = this.unique(desiredPath);
    const entry: AssetPlanEntry = { assetId, kind, path, present };
    this.owner.set(assetId, entry);
    this.entries.push(entry);
    return { path, present };
  }

  /** Suffix a path (`stem-2.ext`) until it is unique among planned paths. */
  private unique(path: string): string {
    const count = this.usedPaths.get(path) ?? 0;
    this.usedPaths.set(path, count + 1);
    if (count === 0) return path;
    const dot = path.lastIndexOf('.');
    const stem = dot >= 0 ? path.slice(0, dot) : path;
    const ext = dot >= 0 ? path.slice(dot) : '';
    return this.unique(`${stem}-${count + 1}${ext}`);
  }
}

export function planAssets(
  sourceScenes: readonly CompilerScene[],
  timelineScenes: readonly VideoTimelineScene[],
  assetSource: AssetSource,
): AssetsResult {
  const planner = new AssetPlanner();
  const diagnostics: Diagnostic[] = [];

  const scenes = timelineScenes.map((scene, index) => {
    const sourceScene = sourceScenes[index];
    const seq = String(scene.index + 1).padStart(3, '0');
    const sceneSlug = `${seq}-${sanitizeFilenamePart(scene.title)}`;

    // Base frame — planned for renderable (slide) scenes; the exporter renders it.
    let base = scene.base;
    if (scene.base.kind === 'slide-snapshot') {
      const { path } = planner.plan(`frame:${scene.id}`, 'frame', `frames/${sceneSlug}.png`, true);
      base = { ...scene.base, assetRef: path };
    }

    // Narration audio.
    let speechSeq = 0;
    const narration = scene.narration.map((seg) => {
      speechSeq += 1;
      const action = sourceScene?.actions?.[seg.actionIndex] as SpeechAction | undefined;
      const meta = action ? assetSource.audio(action) : null;

      if (!meta) {
        if (seg.text.trim()) {
          diagnostics.push({
            severity: 'warn',
            code: 'missing-audio',
            sceneId: scene.id,
            actionId: seg.actionId,
            message: 'Narration has text but no audio asset; will fall back to estimated timing.',
          });
        }
        return seg;
      }

      const { path, present } = planner.plan(
        meta.id,
        'audio',
        `audio/${sceneSlug}/speech-${String(speechSeq).padStart(3, '0')}.${extension(meta, 'mp3')}`,
        meta.present,
      );
      if (!present) {
        diagnostics.push({
          severity: 'warn',
          code: 'skipped-media',
          sceneId: scene.id,
          actionId: seg.actionId,
          message: `Audio asset "${meta.id}" is referenced but its bytes are unavailable.`,
        });
      }
      return {
        ...seg,
        audio: {
          ...seg.audio,
          assetId: meta.id,
          present,
          ...(present ? { assetRef: path } : {}),
        },
      };
    });

    // Video media (play_video targets).
    const videos = scene.videos.map((seg) => {
      const meta = sourceScene ? assetSource.media(seg.elementId, sourceScene) : null;
      if (!meta) {
        // No media asset is associated with the element at all (distinct from a
        // referenced asset whose bytes are missing, below). No plan entry — there
        // is no asset id to bundle. The timeline pass already gave it a 0ms
        // 'skipped' dwell so later actions are not shifted.
        diagnostics.push({
          severity: 'warn',
          code: 'skipped-media',
          sceneId: scene.id,
          actionId: seg.actionId,
          message: `No media asset is associated with play_video element "${seg.elementId}".`,
        });
        return { ...seg, present: false, durationSource: 'skipped' as const };
      }
      // A referenced asset: plan an entry either way so a present:false clip is
      // represented structurally (assetId + present on the segment AND an
      // AssetPlanEntry), not only in a free-form diagnostic. The exporter can
      // distinguish "no association" (no assetId) from "referenced but missing"
      // (assetId present, present:false) without parsing messages.
      const { path, present } = planner.plan(
        meta.id,
        'video',
        `media/${sanitizeFilenamePart(seg.elementId)}.${extension(meta, 'mp4')}`,
        meta.present,
      );
      if (!present) {
        diagnostics.push({
          severity: 'warn',
          code: 'skipped-media',
          sceneId: scene.id,
          actionId: seg.actionId,
          message: `Video media "${meta.id}" for element "${seg.elementId}" is referenced but its bytes are unavailable.`,
        });
        return {
          ...seg,
          assetId: meta.id,
          present: false,
          durationSource: 'skipped' as const,
        };
      }
      return { ...seg, assetId: meta.id, present: true, assetRef: path };
    });

    return { ...scene, base, narration, videos };
  });

  return { scenes, plan: { entries: planner.entries }, diagnostics };
}
