import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';

export interface AssetEntry {
  zipPath: string;
  blob: Blob;
  mimeType: string;
}

export interface AssetMap {
  /** Returns the ZIP-relative path for a given original src, or undefined if not collected */
  get(src: string): string | undefined;
  /** All collected assets */
  entries(): AssetEntry[];
}

// ── Internal map implementation ──

class AssetMapImpl implements AssetMap {
  private _srcToZipPath = new Map<string, string>();
  private _entries: AssetEntry[] = [];

  set(src: string, zipPath: string, blob: Blob, mimeType: string) {
    if (this._srcToZipPath.has(src)) return; // deduplicate
    this._srcToZipPath.set(src, zipPath);
    this._entries.push({ zipPath, blob, mimeType });
  }

  get(src: string): string | undefined {
    return this._srcToZipPath.get(src);
  }

  entries(): AssetEntry[] {
    return this._entries;
  }
}

// ── Fetch helpers ──

function dataUriToBlob(dataUri: string): { blob: Blob; mimeType: string } {
  const [header, b64] = dataUri.split(',');
  const mimeType = header.match(/:(.*?);/)?.[1] ?? 'application/octet-stream';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mimeType }), mimeType };
}

async function fetchToBlob(src: string): Promise<{ blob: Blob; mimeType: string } | null> {
  try {
    if (src.startsWith('data:')) {
      return dataUriToBlob(src);
    }
    const resp = await fetch(src);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return { blob, mimeType: blob.type || 'application/octet-stream' };
  } catch {
    return null;
  }
}

function mimeToExt(mimeType: string, fallback = 'bin'): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
  };
  return map[mimeType] ?? fallback;
}

function pad2(n: number): string {
  return String(n + 1).padStart(2, '0');
}

// ── Resolve a src that may be a media placeholder ──

function resolveSrc(src: string): { src: string; poster?: string } | null {
  if (!isMediaPlaceholder(src)) return { src };
  const task = useMediaGenerationStore.getState().tasks[src];
  if (task?.status === 'done' && task.objectUrl) {
    return { src: task.objectUrl, poster: task.poster };
  }
  return null; // not ready, skip
}

// ── Main export ──

/**
 * Collects all media assets from exportable scenes into an AssetMap.
 *
 * - Slide scenes: image/video/audio element srcs + background image + TTS audio
 * - Quiz/Interactive scenes: no media assets
 * - When includeVideos=false, video elements are replaced by their poster image.
 *   If no poster is available, the video element is skipped entirely.
 *
 * Returns an AssetMap that maps original src → zipPath, and iterable AssetEntry[].
 */
export async function collectAssets(
  scenes: Scene[],
  includeVideos: boolean,
): Promise<AssetMap> {
  const map = new AssetMapImpl();

  const add = async (
    originalSrc: string,
    category: 'images' | 'audio' | 'videos',
    sceneIdx: number,
    suffix: string,
  ) => {
    if (!originalSrc || map.get(originalSrc) !== undefined) return; // already queued or empty
    const result = await fetchToBlob(originalSrc);
    if (!result) return;
    const ext = mimeToExt(result.mimeType, category === 'audio' ? 'mp3' : category === 'videos' ? 'mp4' : 'png');
    const zipPath = `assets/${category}/scene_${pad2(sceneIdx)}_${suffix}.${ext}`;
    map.set(originalSrc, zipPath, result.blob, result.mimeType);
  };

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // ── Slide scenes ──
    if (scene.content.type === 'slide') {
      const canvas = (scene.content as SlideContent).canvas;

      // Background image
      if (canvas.background?.type === 'image' && canvas.background.image?.src) {
        await add(canvas.background.image.src, 'images', i, 'bg');
      }

      // Elements
      let elIdx = 0;
      for (const el of canvas.elements) {
        const elSuffix = `el_${el.id}`;

        if (el.type === 'image') {
          const resolved = resolveSrc(el.src);
          if (resolved) await add(resolved.src, 'images', i, elSuffix);

        } else if (el.type === 'video') {
          const resolved = resolveSrc(el.src);
          const resolvedPoster = el.poster ? resolveSrc(el.poster) : null;

          if (includeVideos && resolved) {
            await add(resolved.src, 'videos', i, elSuffix);
            // Also collect poster (used as fallback thumbnail in HTML)
            const posterSrc = resolvedPoster?.src ?? resolved.poster;
            if (posterSrc) await add(posterSrc, 'images', i, `${elSuffix}_poster`);
          } else {
            // Replace video with poster image
            const posterSrc =
              resolvedPoster?.src ??
              (resolved?.poster) ??
              // Also check media generation store poster
              (isMediaPlaceholder(el.src)
                ? useMediaGenerationStore.getState().tasks[el.src]?.poster
                : undefined);
            if (posterSrc) await add(posterSrc, 'images', i, `${elSuffix}_poster`);
          }

        } else if (el.type === 'audio') {
          const resolved = resolveSrc(el.src);
          if (resolved) await add(resolved.src, 'audio', i, elSuffix);
        }

        elIdx++;
      }

      // TTS narration from SpeechActions
      if (scene.actions) {
        let speechIdx = 0;
        for (const action of scene.actions) {
          if (action.type === 'speech') {
            const speech = action as SpeechAction;
            if (speech.audioUrl) {
              await add(speech.audioUrl, 'audio', i, `speech_${speechIdx}`);
              speechIdx++;
            }
          }
        }
      }
    }

    // Quiz and Interactive scenes have no media assets to collect
  }

  return map;
}

/**
 * Returns all ZIP asset paths referenced by a specific scene.
 * Used to populate <file> entries in imsmanifest.xml.
 */
export function getSceneAssetHrefs(scene: Scene, sceneIdx: number, assetMap: AssetMap, includeVideos: boolean): string[] {
  const hrefs: string[] = [];

  if (scene.content.type !== 'slide') return hrefs;

  const canvas = (scene.content as SlideContent).canvas;

  const collect = (src: string) => {
    if (!src) return;
    const resolved = resolveSrc(src);
    if (resolved) {
      const p = assetMap.get(resolved.src);
      if (p) hrefs.push(p);
    }
  };

  if (canvas.background?.type === 'image' && canvas.background.image?.src) {
    collect(canvas.background.image.src);
  }

  for (const el of canvas.elements) {
    if (el.type === 'image') collect(el.src);
    else if (el.type === 'video') {
      if (includeVideos) {
        collect(el.src);
        if (el.poster) collect(el.poster);
      } else if (el.poster) {
        collect(el.poster);
      }
    } else if (el.type === 'audio') collect(el.src);
  }

  if (scene.actions) {
    for (const action of scene.actions) {
      if (action.type === 'speech') {
        const speech = action as SpeechAction;
        if (speech.audioUrl) collect(speech.audioUrl);
      }
    }
  }

  return [...new Set(hrefs)];
}
