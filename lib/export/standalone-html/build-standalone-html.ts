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
import { fetchStageMeta, type StageMetaResult } from '@/lib/classroom/stage-meta-client';
import { mapWithConcurrency } from '@/lib/utils/concurrency';
import { renderQuizMathText } from '@/lib/quiz/math-text';
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
  snapshot: Pick<ClassroomExportSnapshot, 'manifest' | 'files' | 'videoPosters'>,
  deps: StandaloneMediaDeps = {},
): Promise<StandaloneMediaResolution> {
  const fetchImage = deps.fetchImage ?? fetchImageBytes;
  const pathByRef = new Map<string, string>();
  for (const [path, entry] of Object.entries(snapshot.manifest.mediaIndex)) {
    if (entry.sourceRef && !entry.missing && entry.type !== 'audio') {
      pathByRef.set(entry.sourceRef, path);
    }
  }

  // One resolution per ref, shared by every slot that names it, so a ref used
  // as both an image and a background is fetched once.
  const pending = new Map<string, Promise<string | undefined>>();
  const resolveRef = (ref: string): Promise<string | undefined> => {
    let resolution = pending.get(ref);
    if (!resolution) {
      resolution = (async () => {
        const path = pathByRef.get(ref);
        const archived = path ? snapshot.files.get(path) : undefined;
        if (archived && archived.size > 0) {
          return blobToDataUri(
            archived,
            path ? snapshot.manifest.mediaIndex[path]?.mimeType : undefined,
          );
        }
        if (!isConcreteMediaAddress(ref)) return undefined;
        const fetched = await fetchImage(ref);
        return fetched ? blobToDataUri(fetched) : undefined;
      })();
      pending.set(ref, resolution);
    }
    return resolution;
  };

  const dataUris = new Map<string, string>();
  const videoPosters = new Map<string, string>();
  const references = collectStandaloneMediaReferences(snapshot.manifest);
  await mapWithConcurrency(references, 4, async ({ ref, role }) => {
    if (role === 'video') {
      const poster = snapshot.videoPosters.get(ref);
      if (poster) videoPosters.set(ref, await blobToDataUri(poster, 'image/jpeg'));
      return;
    }
    const dataUri = await resolveRef(ref);
    if (dataUri) dataUris.set(ref, dataUri);
  });
  return { dataUris, videoPosters };
}

/** How long the export waits for the classroom's public status. */
export const STAGE_META_TIMEOUT_MS = 3000;

type FetchStageMeta = (
  stageId: string,
  fetchImpl?: typeof globalThis.fetch,
) => Promise<StageMetaResult>;

export interface PublicClassroomUrlOptions {
  /** Origin of the deployment the export runs on. */
  origin: string;
  fetchMeta?: FetchStageMeta;
  timeoutMs?: number;
}

/**
 * The public classroom address for the PBL "continue online" link, or
 * `undefined` when the classroom is not published (or the deployment has no
 * server persistence to publish it with). Never throws.
 *
 * The lookup is bounded: after `timeoutMs` the request is aborted and the
 * link is omitted, as it is when the metadata cannot be read. The race also
 * covers reading the response body, so a stalled request or body never
 * blocks the export.
 */
export async function resolvePublicClassroomUrl(
  stageId: string,
  {
    origin,
    fetchMeta = fetchStageMeta,
    timeoutMs = STAGE_META_TIMEOUT_MS,
  }: PublicClassroomUrlOptions,
): Promise<string | undefined> {
  const controller = new AbortController();
  const fetchWithAbort: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, { ...init, signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<StageMetaResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'unavailable' });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fetchMeta(stageId, fetchWithAbort), timedOut]);
    if (result.outcome !== 'found' || !result.meta.isPublic) return undefined;
    return `${origin}/classroom/${encodeURIComponent(stageId)}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The public classroom address when the export has a PBL scene to link from
 * it, otherwise `undefined` without any request, so exports without PBL never
 * wait on the network.
 */
export async function resolvePublicClassroomUrlForScenes(
  scenes: readonly Pick<Scene, 'type'>[],
  stageId: string | undefined,
  options: PublicClassroomUrlOptions,
): Promise<string | undefined> {
  if (!stageId || !scenes.some((scene) => scene.type === 'pbl')) return undefined;
  return resolvePublicClassroomUrl(stageId, options);
}

function hasQuizMath(text: string | undefined): boolean {
  return !!text && renderQuizMathText(text).some((segment) => segment.type === 'math');
}

/**
 * Whether the classroom shows math, so the KaTeX fonts must ship: a slide
 * carrying KaTeX markup, or quiz text the player renders as math (the same
 * `renderQuizMathText` decides it in both places).
 */
function needsMathFonts(manifest: ClassroomManifest): boolean {
  return manifest.scenes.some((scene) => {
    const content = scene.content;
    if (content.type === 'slide') return JSON.stringify(content.canvas).includes('katex');
    if (content.type !== 'quiz') return false;
    return (content.questions ?? []).some(
      (question) =>
        hasQuizMath(question.question) ||
        hasQuizMath(question.analysis) ||
        (question.answer ?? []).some(hasQuizMath) ||
        (question.options ?? []).some((option) => hasQuizMath(option.label)),
    );
  });
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
  // No narration or video bytes in this format yet: skip collecting them
  // (posters captured for generated videos are still collected).
  const snapshot = await buildClassroomExportSnapshot(stage, scenes, options.documentDeps, {
    audio: false,
    videoBytes: false,
  });
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
