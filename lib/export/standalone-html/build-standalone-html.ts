/**
 * Standalone HTML export: one `.html` file that plays the whole classroom
 * offline (slides, interactive scenes, quizzes, PBL briefings).
 *
 * The data is the classroom ZIP's export snapshot (one serializer for both
 * formats); this layer resolves the referenced media to `data:` URIs, fetches
 * the player assets that the app build precompiled into `public/`, and hands
 * everything to the pure assembler. No bundler runs at export time.
 */
import type { Scene, Stage } from '@/lib/types/stage';
import type { DocumentMigrationDeps } from '@/lib/document-store';
import { fetchMediaUrl } from '@/lib/media/fetch-media-url';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import { mapWithConcurrency } from '@/lib/utils/concurrency';
import {
  buildClassroomExportSnapshot,
  classroomExportBaseName,
  type ClassroomExportSnapshot,
} from '../use-export-classroom';
import type { InlineReport } from '../inline-assets';
import type { ClassroomManifest } from '../classroom-zip-types';
import { assembleStandaloneHtml } from './assemble';
import {
  STANDALONE_PLAYER_ASSETS,
  type StandalonePlayerConfig,
  type StandalonePlayerStrings,
} from './contract';
import {
  collectStandaloneMediaReferences,
  prepareStandaloneManifest,
  type StandaloneMediaResolution,
} from './prepare-manifest';

export const STANDALONE_HTML_EXTENSION = '.html';

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function imageMimeFromUrl(url: string): string | undefined {
  const path = url.split(/[?#]/)[0] ?? '';
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTENSION_MIME[extension];
}

/** Encode bytes as a `data:` URI; works in the browser and in Node. */
export async function blobToDataUri(blob: Blob, fallbackMimeType?: string): Promise<string> {
  const mimeType = blob.type || fallbackMimeType || 'application/octet-stream';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Fetch a concrete image URL through the app's media fetch path; `null` on any failure. */
async function fetchImageBytes(url: string): Promise<Blob | null> {
  try {
    const response = await fetchMediaUrl(url, 15_000);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    if (blob.type.startsWith('image/')) return blob;
    const guessed = imageMimeFromUrl(url);
    return guessed ? new Blob([blob], { type: guessed }) : null;
  } catch {
    return null;
  }
}

export interface StandaloneMediaDeps {
  /** Fetch bytes for a concrete (URL) reference no archive payload backs. */
  fetchImage?: (url: string) => Promise<Blob | null>;
}

/**
 * Resolve every displayed media reference of the snapshot to a `data:` URI:
 * archive payloads first (matched through the media index's `sourceRef`), then
 * concrete URLs fetched now. Whatever resolves nowhere is dropped by
 * {@link prepareStandaloneManifest} and reported back.
 */
export async function resolveStandaloneMedia(
  snapshot: Pick<ClassroomExportSnapshot, 'manifest' | 'files' | 'videoPosterPaths'>,
  deps: StandaloneMediaDeps = {},
): Promise<StandaloneMediaResolution> {
  const fetchImage = deps.fetchImage ?? fetchImageBytes;
  const pathByRef = new Map<string, string>();
  for (const [path, entry] of Object.entries(snapshot.manifest.mediaIndex)) {
    if (entry.sourceRef && !entry.missing && entry.type !== 'audio') {
      pathByRef.set(entry.sourceRef, path);
    }
  }
  const mimeByPath = (path: string) => snapshot.manifest.mediaIndex[path]?.mimeType;

  const dataUris = new Map<string, string>();
  const videoPosters = new Map<string, string>();
  const references = collectStandaloneMediaReferences(snapshot.manifest);
  await mapWithConcurrency(references, 4, async ({ ref, role }) => {
    const path = pathByRef.get(ref);
    if (role === 'video') {
      const posterPath = path ? snapshot.videoPosterPaths.get(path) : undefined;
      const poster = posterPath ? snapshot.files.get(posterPath) : undefined;
      if (poster) videoPosters.set(ref, await blobToDataUri(poster, 'image/jpeg'));
      return;
    }
    if (dataUris.has(ref)) return;
    const archived = path ? snapshot.files.get(path) : undefined;
    if (archived && archived.size > 0) {
      dataUris.set(ref, await blobToDataUri(archived, path ? mimeByPath(path) : undefined));
      return;
    }
    if (!isConcreteMediaAddress(ref)) return;
    const fetched = await fetchImage(ref);
    if (fetched) dataUris.set(ref, await blobToDataUri(fetched));
  });
  return { dataUris, videoPosters };
}

/**
 * The public classroom address for the PBL "continue online" link, or
 * `undefined` when the classroom is not published (or the deployment has no
 * server persistence to publish it with). Never throws.
 */
export async function resolvePublicClassroomUrl(
  stageId: string,
  origin: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<string | undefined> {
  const result = await fetchStageMeta(stageId, fetchImpl);
  if (result.outcome !== 'found' || !result.meta.isPublic) return undefined;
  return `${origin}/classroom/${encodeURIComponent(stageId)}`;
}

/** Whether the classroom can show math, so the KaTeX fonts must ship. */
function needsMathFonts(manifest: ClassroomManifest): boolean {
  return manifest.scenes.some(
    (scene) =>
      scene.content.type === 'quiz' ||
      (scene.content.type === 'slide' && JSON.stringify(scene.content.canvas).includes('katex')),
  );
}

/** Whether any slide has a chart element, so the charts runtime must ship. */
function needsCharts(manifest: ClassroomManifest): boolean {
  return manifest.scenes.some(
    (scene) =>
      scene.content.type === 'slide' &&
      (scene.content.canvas.elements ?? []).some((element) => element.type === 'chart'),
  );
}

async function fetchPlayerAsset(path: string): Promise<string> {
  // `no-cache` revalidates, so an upgraded deployment never pairs a stale
  // player with a newer manifest.
  const response = await fetch(`/${path}`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Standalone player asset unavailable: /${path} (HTTP ${response.status})`);
  }
  return response.text();
}

export interface StandaloneHtmlExportOptions extends StandaloneMediaDeps {
  strings: StandalonePlayerStrings;
  lang: string;
  /**
   * Public URL of the online classroom. PBL scenes link to it; when absent,
   * the link is omitted.
   */
  classroomUrl?: string;
  /** Document-store dependencies, forwarded to the snapshot. */
  documentDeps?: DocumentMigrationDeps;
  /** Loads a precompiled player asset by its public path. */
  fetchAsset?: (path: string) => Promise<string>;
}

export interface StandaloneHtmlExport {
  html: string;
  fileName: string;
  inlineFailures: InlineReport['failed'];
  /** Media references that could not be embedded and were dropped. */
  unresolvedMedia: string[];
}

export async function buildStandaloneHtmlExport(
  stage: Stage,
  scenes: Scene[],
  options: StandaloneHtmlExportOptions,
): Promise<StandaloneHtmlExport> {
  const fetchAsset = options.fetchAsset ?? fetchPlayerAsset;
  const snapshot = await buildClassroomExportSnapshot(stage, scenes, options.documentDeps);
  const media = await resolveStandaloneMedia(snapshot, options);
  const { manifest, unresolved } = prepareStandaloneManifest(snapshot.manifest, media);

  const [playerScript, playerStyle, mathFonts, chartsScript] = await Promise.all([
    fetchAsset(STANDALONE_PLAYER_ASSETS.script),
    fetchAsset(STANDALONE_PLAYER_ASSETS.style),
    needsMathFonts(manifest) ? fetchAsset(STANDALONE_PLAYER_ASSETS.mathFonts) : undefined,
    needsCharts(manifest) ? fetchAsset(STANDALONE_PLAYER_ASSETS.charts) : undefined,
  ]);

  const config: StandalonePlayerConfig = {
    strings: options.strings,
    ...(options.classroomUrl ? { classroomUrl: options.classroomUrl } : {}),
  };
  const html = assembleStandaloneHtml({
    manifest,
    config,
    playerScript,
    playerStyle,
    extraStyles: mathFonts ? [mathFonts] : [],
    extraScripts: chartsScript ? [chartsScript] : [],
    lang: options.lang,
  });

  return {
    html,
    fileName: `${classroomExportBaseName(snapshot.stageName)}${STANDALONE_HTML_EXTENSION}`,
    inlineFailures: snapshot.inlineFailures,
    unresolvedMedia: unresolved,
  };
}
