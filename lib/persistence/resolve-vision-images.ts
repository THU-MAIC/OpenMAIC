/**
 * Server-side resolution of prompt-assembly vision images by allocated asset
 * id (RFC #1153 part 2 section B).
 *
 * On a server-backed deployment the client sends `imageMapping` as
 * (image id → allocated asset id) instead of base64 data URLs, and
 * `resolveImageIds` writes those allocated ids into `PPTImageElement.src`.
 * Where the generation routes currently read image bytes for the vision
 * prompt, they resolve the ids to bytes HERE — reusing `resolveServerAsset`
 * from part 0 — so the multimodal content handed to the LLM is byte-identical
 * to what the browser-backed (data-URL) path would have sent: same images,
 * same order, same selection. Only the transport differs.
 *
 * A src that is already a data URL or a concrete URL passes through untouched
 * (a browser-backed request, or a legacy session that fell back to bytes), so
 * the routes stay correct in both modes without a mode flag. An id that the
 * server cannot resolve (missing asset, unconfigured/unauthenticated
 * persistence, a store failure) is DROPPED from the vision set with a
 * server-side warn — never echoed to the caller and never sent to the LLM as
 * an opaque id string. On a healthy deployment nothing drops and the two
 * modes produce identical prompts.
 *
 * Size bound (N5): the same 50 MB cap the extract route enforces is passed
 * to `resolveServerAsset`'s `maxByteLength`, so an oversized asset is
 * rejected at `identify` — the registry's recorded length, before any bytes
 * are materialized — and dropped with the same warn-and-drop posture as an
 * unresolvable one.
 *
 * Server-only module: it must never be imported from client code (the
 * `resolveServerAsset` dependency chain is Node-only).
 */
import { createLogger } from '@/lib/logger';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';

import { resolveServerAsset } from './resolve-server-asset';

const log = createLogger('VisionImageResolution');

/** One image in a vision prompt slice, as `generateSceneContent` builds it. */
export interface VisionPromptImage {
  id: string;
  src: string;
  width?: number;
  height?: number;
}

/** Whether a src is already concrete bytes (data URL) or a remote URL. */
function isConcreteImageSrc(src: string): boolean {
  return /^(?:data:|https?:|blob:)/i.test(src);
}

/**
 * Resolve a vision image list whose `src` values may be allocated asset ids
 * into data URLs, so the prompt the LLM receives is the same in both the
 * server-backed and the browser-backed transports. Images whose src is
 * already concrete pass through; images whose id cannot be resolved
 * server-side are dropped (warned server-side only).
 */
export async function resolveVisionImagesForPrompt(
  images: readonly VisionPromptImage[],
  headers: Headers,
): Promise<VisionPromptImage[]> {
  const resolved: VisionPromptImage[] = [];
  for (const image of images) {
    if (!image.src) continue;
    if (isConcreteImageSrc(image.src)) {
      resolved.push(image);
      continue;
    }
    let resolution;
    try {
      resolution = await resolveServerAsset(
        image.src,
        headers,
        MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
      );
    } catch (error) {
      // A store failure must never surface raw error text to the caller; log
      // server-side and drop the image so the prompt degrades gracefully.
      log.error(`Failed to resolve vision image asset "${image.id}" from the server store:`, error);
      continue;
    }
    if (resolution.status !== 'resolved') {
      // Unresolvable and oversized images share the same posture: warn
      // server-side and drop, so the prompt never names an image it cannot
      // attach (N3) and never pulls an oversized asset into memory (N5).
      log.warn(
        `Vision image "${image.id}" does not resolve server-side (${resolution.status}); dropping it from the vision prompt.`,
      );
      continue;
    }
    resolved.push({
      id: image.id,
      src: `data:${resolution.mimeType};base64,${resolution.buffer.toString('base64')}`,
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    });
  }
  return resolved;
}
