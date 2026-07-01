/**
 * High-level entry: parsed pptxtojson(-pro) JSON → OpenMAIC canvas `Slide[]`.
 *
 * `parsedToSlides` is the transform-only path: it never touches the parser
 * source under `../src`, which keeps `pdfjs-dist`'s dynamic `require()` out
 * of the consumer's bundle. Callers running in bundlers that can't tolerate
 * those patterns (Turbopack, today) load `parse` via a runtime URL and pass
 * the JSON in.
 *
 * `importPptx` bundles parse + transform for environments without that
 * bundler constraint (Node scripts, plain Vite, etc.).
 *
 * Failure policy: every upload site inside `transformParsedToSlides` already
 * swallows individual errors and leaves the original base64 in place; we use
 * `Promise.allSettled` here so a missing inner `.catch` cannot fail the
 * whole import either.
 */
import type { Slide } from '@openmaic/dsl';
import type { Output } from '../adapter/types';
import { parseZip } from '../parser/ZipParser';
import { buildPresentation } from '../model/Presentation';
import { toPptxtojsonFormat } from '../adapter/toPptxtojson';
import type { ImportContext } from './types';
import { transformParsedToSlides } from './transformParsedToSlides';
import { createMockImportContext } from './mockContext';

/**
 * Fallback viewport width in CSS pixels — used only when the parsed deck
 * has no usable size (json.size.width <= 0). For real PPTX files the deck's
 * own pixel width (json.size.width * ratio) drives both the transform-time
 * clamp and the per-slide `viewportSize`, so a 16:9 widescreen deck lands
 * at 1280 and a 4:3 deck at 960 without any caller override.
 */
const FALLBACK_VIEWPORT_SIZE = 1280;

export type OssUpload = (blob: Blob, filename: string, dir?: string) => Promise<string>;

export interface ImportPptxOptions {
  /**
   * Upload media (images, audio, video) to remote storage and return the
   * public URL. If omitted, images keep their base64 data URLs and media
   * keeps an in-memory `blob:` URL (valid only for the current tab).
   */
  upload?: OssUpload;
}

/**
 * Convert a pre-parsed pptxtojson(-pro) `Output` JSON into OpenMAIC slides.
 *
 * Resolves after every queued upload has settled, so `Slide` elements
 * either hold the uploaded URL or fall back to the original base64.
 *
 * Bundler-safe: this entry has no transitive dependency on
 * `pptxtojson-pro/src` and therefore no `pdfjs-dist` dynamic-require trap.
 */
export async function parsedToSlides(
  json: Output,
  options: ImportPptxOptions = {},
): Promise<Slide[]> {
  const baseCtx = createMockImportContext(buildContextOverrides(options.upload));
  // Drive the transform-time width clamp from the deck's own pixel width
  // (pt → px via ratio) so 16:9 widescreen decks (960pt → 1280px) don't
  // get text elements truncated to the legacy 4:3 default of 960.
  const deckViewportWidth =
    json.size.width > 0 ? json.size.width * baseCtx.ratio : FALLBACK_VIEWPORT_SIZE;
  const ctx: ImportContext = { ...baseCtx, viewportWidth: deckViewportWidth };

  // pptxtojson-pro's `Output` is structurally compatible with the npm
  // `pptxtojson` shape that `transformParsedToSlides` is typed against;
  // the cast bridges the two declaration sources.
  const { slides, uploadTasks } = await transformParsedToSlides(
    json as unknown as Parameters<typeof transformParsedToSlides>[0],
    ctx,
  );

  await Promise.allSettled(uploadTasks);

  // `transformParsedToSlides` already emits complete DSL `Slide` objects
  // (viewportSize / viewportRatio / theme are filled at construction), so the
  // result is a ready-to-render `Slide[]` with no post-processing.
  return slides;
}

/**
 * Parse a .pptx file and convert it into OpenMAIC canvas slides.
 *
 * Convenience wrapper for environments that can bundle `pptxtojson-pro/src`
 * (Node, Vite, etc.). Inside Next/Turbopack, prefer URL-loading `parse`
 * yourself and calling {@link parsedToSlides} with the result.
 */
export async function importPptx(
  input: File | Blob | ArrayBuffer,
  options: ImportPptxOptions = {},
): Promise<Slide[]> {
  const buffer = await toArrayBuffer(input);
  const files = await parseZip(buffer);
  const presentation = buildPresentation(files);
  const json = await toPptxtojsonFormat(presentation, files, 'base64');
  return parsedToSlides(json, options);
}

function buildContextOverrides(upload: OssUpload | undefined): Partial<ImportContext> {
  if (!upload) return {};
  return {
    uploadBase64Image: async (base64, filename, dir) => {
      const blob = await dataUrlToBlob(base64);
      return upload(blob, filename, dir);
    },
    uploadBlobMedia: (blob, filename, dir) => upload(blob, filename, dir),
  };
}

async function toArrayBuffer(input: File | Blob | ArrayBuffer): Promise<ArrayBuffer> {
  if (input instanceof ArrayBuffer) return input;
  return input.arrayBuffer();
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export type { ImportContext, TransformResult } from './types';
export { transformParsedToSlides } from './transformParsedToSlides';
export { createMockImportContext } from './mockContext';
export type { Output } from '../adapter/types';
