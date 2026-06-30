/**
 * Convert legacy / non-web-safe image bytes to PNG data URLs
 * so JSON output works in browsers (PPTist).
 *
 * Supported conversions:
 * - TIFF/TIF  → PNG  (sync, via UTIF)
 * - EMF bitmap (STRETCHDIBITS) → PNG  (sync, DIB extraction)
 * - EMF vector (embedded PDF)  → PNG  (async, pdfjs-dist + canvas)
 * - WDP/JXR/HDP (JPEG XR)     → PNG  (async, jpegxr WASM decoder)
 * - WMF → transparent placeholder (unsupported)
 * - PNG/JPEG/GIF/WebP/BMP/SVG  → pass-through with correct MIME
 */

import UTIF from 'utif';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import JpegXR from 'jpegxr';
import { parseEmfContent } from './emfParser';
import { rgbaToPngDataUrl } from './rgbaToPng';
import { getMimeType, toDataUrl, getOrCreateBlobUrl } from './media';

type PdfViewport = { width: number; height: number };
type PdfPage = {
  getViewport(opts: { scale: number }): PdfViewport;
  render(args: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): {
    promise: Promise<void>;
  };
};
type PdfDocument = { getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> };
type PdfjsLib = {
  version?: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(args: { data: Uint8Array; verbosity?: number }): { promise: Promise<PdfDocument> };
};
const pdfjs = pdfjsLib as unknown as PdfjsLib;

const PDFJS_CDN_VERSION = pdfjs.version || '4.8.69';
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_CDN_VERSION}/legacy/build/pdf.worker.min.mjs`;

type UtifPage = {
  width: number;
  height: number;
  data?: Uint8Array;
  [key: string]: unknown;
};

function arrayBufferToBase64(data: Uint8Array): string {
  let binary = '';
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]);
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  const NodeBuffer =
    typeof globalThis !== 'undefined' &&
    (globalThis as unknown as { Buffer?: { from(a: Uint8Array): { toString(e: string): string } } })
      .Buffer;
  if (NodeBuffer) return NodeBuffer.from(data).toString('base64');
  return btoa(binary);
}

function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

/**
 * Decode TIFF/TIF bytes to RGBA using UTIF.
 */
function tiffToRgba(
  data: Uint8Array,
): { width: number; height: number; data: Uint8ClampedArray } | null {
  try {
    const ifds = UTIF.decode(data) as UtifPage[];
    if (!ifds.length) return null;
    UTIF.decodeImage(data, ifds[0], ifds);
    const page = ifds[0];
    const w = page.width;
    const h = page.height;
    if (!w || !h) return null;
    const rgba = UTIF.toRGBA8(page);
    return { width: w, height: h, data: new Uint8ClampedArray(rgba) };
  } catch {
    return null;
  }
}

/** 1×1 transparent PNG — fallback when conversion is not possible */
const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// WDP (JPEG XR) → PNG
// ---------------------------------------------------------------------------

async function wdpToPngDataUrl(data: Uint8Array): Promise<string> {
  try {
    const mod = await new JpegXR();
    const result = mod.decode(data);
    const { width, height, bytes, pixelInfo } = result;
    if (!width || !height || !bytes) return TRANSPARENT_PNG_DATA_URL;

    const channels: number = pixelInfo?.channels ?? 3;
    const isBgr: boolean = pixelInfo?.bgr ?? false;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
      const dst = i * 4;
      rgba[dst + 0] = isBgr ? bytes[j + 2] : bytes[j + 0];
      rgba[dst + 1] = bytes[j + 1];
      rgba[dst + 2] = isBgr ? bytes[j + 0] : bytes[j + 2];
      rgba[dst + 3] = channels === 4 ? bytes[j + 3] : 255;
    }
    return rgbaToPngDataUrl(rgba, width, height);
  } catch {
    return TRANSPARENT_PNG_DATA_URL;
  }
}

// ---------------------------------------------------------------------------
// EMF (embedded PDF) → PNG via pdfjs-dist + canvas
// ---------------------------------------------------------------------------

async function emfPdfToPngDataUrl(pdfData: Uint8Array, targetWidth = 1024): Promise<string> {
  try {
    const doc = await pdfjs.getDocument({ data: pdfData, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(1, targetWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport }).promise;

    await doc.destroy();
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.error('[emfPdfToPng] failed:', err);
    return TRANSPARENT_PNG_DATA_URL;
  }
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Convert media bytes to a data URL suitable for web display.
 *
 * Async because WDP decoding (jpegxr WASM) and EMF-PDF rendering
 * (pdfjs-dist) require async initialization; all other formats
 * resolve immediately.
 */
export async function encodeMediaForWebDisplay(
  mediaPath: string,
  data: Uint8Array,
): Promise<string> {
  const ext = extOf(mediaPath);

  if (ext === 'tif' || ext === 'tiff') {
    const rgba = tiffToRgba(data);
    if (rgba) return rgbaToPngDataUrl(rgba.data, rgba.width, rgba.height);
    return TRANSPARENT_PNG_DATA_URL;
  }

  if (ext === 'wdp' || ext === 'jxr' || ext === 'hdp') {
    return wdpToPngDataUrl(data);
  }

  if (ext === 'emf') {
    const content = parseEmfContent(data);
    if (content.type === 'bitmap' && content.bitmap) {
      const { width, height, data: rgba } = content.bitmap;
      return rgbaToPngDataUrl(rgba, width, height);
    }
    if (content.type === 'pdf') {
      return emfPdfToPngDataUrl(content.data);
    }
    return TRANSPARENT_PNG_DATA_URL;
  }

  if (ext === 'wmf') {
    return TRANSPARENT_PNG_DATA_URL;
  }

  const mime = getMimeType(mediaPath);
  return toDataUrl(arrayBufferToBase64(data), mime);
}

const NON_WEB_EXTENSIONS = new Set(['tif', 'tiff', 'emf', 'wmf', 'wdp', 'jxr', 'hdp']);

function isNonWebFormat(mediaPath: string): boolean {
  return NON_WEB_EXTENSIONS.has(extOf(mediaPath));
}

/**
 * Resolve media bytes to a URL string according to the given mode.
 */
export async function resolveMediaToUrl(
  mediaPath: string,
  data: Uint8Array | ArrayBuffer,
  mode: 'base64' | 'blob',
  cache: Map<string, string>,
): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (mode === 'blob') {
    return getOrCreateBlobUrl(mediaPath, data, cache);
  }
  return encodeMediaForWebDisplay(mediaPath, bytes);
}
