/**
 * DeepSeek OCR (POST /v1/tools/ocr) as a document parsing provider.
 *
 * One multipart request carries the file (PDF, Word, PowerPoint or an image)
 * and `purpose`. The service answers with leading newlines as keep-alive while
 * it recognizes, then one JSON object, so the whole body parses as JSON after
 * a trim. The total time is capped at 180 seconds by the service.
 *
 * `rich_layout_recognition` recognizes every page with its layout: each block
 * of a page's raw output is tagged with a label and a box,
 * `<｜ref｜>label<｜/ref｜><｜box｜>[[x1, y1, x2, y2]]<｜/box｜> content`, the
 * coordinates normalized to 0–1000 of the page width and height. (The
 * `text_recognition` purpose was found to drop tables, so it is not used.)
 * The blocks become markdown: headings for titles, tables as the HTML the
 * model writes, equations in their `$$` delimiters, page headers, footers and
 * numbers left out.
 *
 * Figures (`image` blocks) carry no text. For a PDF, the pages that have
 * figures are rendered with the PDF renderer the built-in parser already uses
 * (unpdf on the `@napi-rs/canvas` backend) and each figure's box is cropped
 * out; for an image upload the box is cropped from the image itself. The
 * markdown names each crop by its path (`![caption](images/<file>)`), the way
 * MinerU's markdown names its images, so owner extraction keeps them as image
 * derivatives. Word and PowerPoint files have no page renderer here: their
 * figures are left out and the text is returned alone. When rendering fails
 * (for example the canvas backend cannot load on the host), the text is still
 * returned, without images.
 */
import sharp from 'sharp';
import { createIsomorphicCanvasFactory, getDocumentProxy, renderPageAsImage } from 'unpdf';

import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { DEEPSEEK_OCR_DEFAULT_BASE } from './constants';
import { createLogger } from '@/lib/logger';
import { MAX_DERIVED_IMAGES } from '@/lib/document/extractors/images';
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import {
  MaterialExtractionError,
  MaterialSourceRefusedError,
} from '@/lib/server/material-extraction/errors';
import { deepseekToolsEndpoint } from '@/lib/web-search/deepseek-endpoint';

const log = createLogger('DeepSeekOCR');

/** The layout-preserving recognition mode (keeps tables). */
export const DEEPSEEK_OCR_PURPOSE = 'rich_layout_recognition';
/** The service refuses files over 100 MiB. */
export const DEEPSEEK_OCR_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** The service refuses documents over 1,000 pages. */
export const DEEPSEEK_OCR_MAX_PAGES = 1000;
/**
 * The service ends a recognition 180 seconds after the upload starts; the
 * client waits a little longer so the service's own timeout error arrives.
 */
const REQUEST_TIMEOUT_MS = 200_000;
/** Bound on the result body: page texts only, far below this for 1,000 pages. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Longest provider error message carried into a thrown error. */
const MAX_ERROR_MESSAGE_CHARS = 200;
/** Rendered pages are at most this many pixels on their longer side. */
const MAX_RENDER_EDGE_PX = 2000;
/** Crops smaller than this on either side are noise, not figures. */
const MIN_FIGURE_EDGE_PX = 16;

/** Labels whose box is a picture to crop rather than text to keep. */
const FIGURE_LABELS = new Set(['image', 'figure', 'picture', 'chart']);
/** Labels of a caption that belongs to the figure right before it. */
const FIGURE_CAPTION_LABELS = new Set(['image_caption', 'figure_caption', 'chart_caption']);
/** Labels whose blocks are page furniture, not document content. */
const DROPPED_LABELS = new Set(['header', 'footer', 'page_number']);

interface DeepSeekOCRPage {
  index?: number;
  text?: string;
  finish_reason?: string;
}

interface DeepSeekOCRResponse {
  page_count?: number;
  pages?: DeepSeekOCRPage[];
  error?: { message?: string; type?: string; code?: string };
}

/** One tagged block of a page's raw output. */
export interface DeepSeekOCRBlock {
  label: string;
  /** Boxes as `[x1, y1, x2, y2]`, normalized to 0–1000 of the page. */
  boxes: number[][];
  content: string;
}

// `<｜ref｜>` (fullwidth bars) is what the API documents; the ASCII-bar and
// `det` spellings of the open model are accepted too.
const BLOCK_RE =
  /<[｜|]ref[｜|]>([\s\S]*?)<[｜|]\/ref[｜|]>\s*(?:<[｜|](?:box|det)[｜|]>([\s\S]*?)<[｜|]\/(?:box|det)[｜|]>)?/g;
const STRAY_TOKEN_RE = /<[｜|]\/?[a-z_]+[｜|]>/g;

function parseBoxes(raw: string | undefined): number[][] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (box): box is number[] =>
        Array.isArray(box) &&
        box.length === 4 &&
        box.every((value) => typeof value === 'number' && Number.isFinite(value)),
    );
  } catch {
    return [];
  }
}

/**
 * A page's raw output as tagged blocks. Text without any tag (a document whose
 * text was extracted directly) is one untagged `text` block.
 */
export function parseDeepSeekOCRPage(text: string): DeepSeekOCRBlock[] {
  const blocks: DeepSeekOCRBlock[] = [];
  const matches = [...text.matchAll(BLOCK_RE)];
  const leading = (matches.length ? text.slice(0, matches[0]!.index) : text)
    .replace(STRAY_TOKEN_RE, '')
    .trim();
  if (leading) blocks.push({ label: 'text', boxes: [], content: leading });
  matches.forEach((match, i) => {
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    blocks.push({
      label: match[1]!.trim().toLowerCase(),
      boxes: parseBoxes(match[2]),
      content: text.slice(start, end).replace(STRAY_TOKEN_RE, '').trim(),
    });
  });
  return blocks;
}

/** A caption or heading as one plain line (no HTML wrappers, no line breaks). */
function plainLine(text: string): string {
  return text
    .replace(/<\/?center>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function heading(content: string, level: number): string {
  const line = plainLine(content);
  if (!line) return '';
  return /^#{1,6}\s/.test(line) ? line : `${'#'.repeat(level)} ${line}`;
}

/** Alt text for a figure reference: brackets would end the markdown alt early. */
function altText(caption: string | undefined): string {
  return (caption ?? '').replace(/[[\]]/g, '').slice(0, 200);
}

/** A figure to crop: where it is, and the path the markdown names it by. */
export interface DeepSeekOCRFigure {
  pageIndex: number;
  box: number[];
  path: string;
  caption?: string;
}

/**
 * The document's markdown from its pages' blocks, and the figures it names.
 * `withFigures` false leaves figures out of the text (nothing will be cropped).
 */
export function deepseekOCRToMarkdown(
  pages: ReadonlyArray<{ index: number; text: string }>,
  withFigures: boolean,
): { markdown: string; figures: DeepSeekOCRFigure[] } {
  const figures: DeepSeekOCRFigure[] = [];
  const pageTexts: string[] = [];
  for (const page of pages) {
    const blocks = parseDeepSeekOCRPage(page.text);
    const parts: string[] = [];
    let figureOnPage = 0;
    blocks.forEach((block, i) => {
      if (DROPPED_LABELS.has(block.label)) return;
      if (FIGURE_LABELS.has(block.label)) {
        if (block.content) parts.push(block.content);
        if (!withFigures || figures.length >= MAX_DERIVED_IMAGES) return;
        const next = blocks[i + 1];
        const caption =
          next && FIGURE_CAPTION_LABELS.has(next.label)
            ? plainLine(next.content) || undefined
            : undefined;
        for (const box of block.boxes) {
          if (figures.length >= MAX_DERIVED_IMAGES) break;
          figureOnPage += 1;
          const path = `images/deepseek-ocr-p${page.index + 1}-${figureOnPage}.png`;
          figures.push({ pageIndex: page.index, box, path, ...(caption ? { caption } : {}) });
          parts.push(`![${altText(caption)}](${path})`);
        }
        return;
      }
      if (!block.content) return;
      if (block.label === 'title') parts.push(heading(block.content, 2));
      else if (block.label === 'sub_title') parts.push(heading(block.content, 3));
      else if (block.label.endsWith('caption')) parts.push(plainLine(block.content));
      else parts.push(block.content);
    });
    const pageText = parts.filter(Boolean).join('\n\n');
    if (pageText) pageTexts.push(pageText);
  }
  return { markdown: pageTexts.join('\n\n'), figures };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** The pixel rectangle a normalized box covers on a `width` x `height` image. */
export function boxToPixels(
  box: number[],
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  const clamp = (value: number) => Math.min(1000, Math.max(0, value));
  const [x1, y1, x2, y2] = box.map(clamp) as [number, number, number, number];
  const left = Math.floor((Math.min(x1, x2) * width) / 1000);
  const top = Math.floor((Math.min(y1, y2) * height) / 1000);
  const right = Math.min(width, Math.ceil((Math.max(x1, x2) * width) / 1000));
  const bottom = Math.min(height, Math.ceil((Math.max(y1, y2) * height) / 1000));
  const rect = { left, top, width: right - left, height: bottom - top };
  return rect.width >= MIN_FIGURE_EDGE_PX && rect.height >= MIN_FIGURE_EDGE_PX ? rect : null;
}

interface FigureCrop {
  figure: DeepSeekOCRFigure;
  src: string;
  width: number;
  height: number;
}

async function cropFigures(
  image: Buffer,
  figures: DeepSeekOCRFigure[],
  crops: FigureCrop[],
): Promise<void> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  for (const figure of figures) {
    const rect = boxToPixels(figure.box, width, height);
    if (!rect) continue;
    try {
      const png = await sharp(image).extract(rect).png().toBuffer();
      crops.push({
        figure,
        src: `data:image/png;base64,${png.toString('base64')}`,
        width: rect.width,
        height: rect.height,
      });
    } catch (error) {
      log.warn(`[DeepSeek OCR] Could not crop a figure on page ${figure.pageIndex + 1}:`, error);
    }
  }
}

/** Renders the PDF pages that have figures and crops each figure out. */
async function cropPdfFigures(
  buffer: Buffer,
  figures: DeepSeekOCRFigure[],
  signal?: AbortSignal,
): Promise<FigureCrop[]> {
  const canvasImport = () => import('@napi-rs/canvas');
  const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { CanvasFactory });
  const crops: FigureCrop[] = [];
  try {
    const byPage = new Map<number, DeepSeekOCRFigure[]>();
    for (const figure of figures) {
      byPage.set(figure.pageIndex, [...(byPage.get(figure.pageIndex) ?? []), figure]);
    }
    for (const [pageIndex, pageFigures] of byPage) {
      signal?.throwIfAborted();
      const pageNumber = pageIndex + 1;
      if (pageNumber < 1 || pageNumber > pdf.numPages) continue;
      const page = await pdf.getPage(pageNumber);
      const { width, height } = page.getViewport({ scale: 1 });
      const scale = Math.min(3, MAX_RENDER_EDGE_PX / Math.max(width, height, 1));
      const rendered = await renderPageAsImage(pdf, pageNumber, { canvasImport, scale });
      await cropFigures(Buffer.from(rendered), pageFigures, crops);
    }
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
  return crops;
}

/** The figures cropped out of the source, best effort: none when rendering fails. */
async function figureCrops(
  buffer: Buffer,
  figures: DeepSeekOCRFigure[],
  signal?: AbortSignal,
): Promise<FigureCrop[]> {
  if (!figures.length) return [];
  try {
    if (isPdf(buffer)) return await cropPdfFigures(buffer, figures, signal);
    // An image upload is its own single page.
    const crops: FigureCrop[] = [];
    await cropFigures(
      buffer,
      figures.filter((figure) => figure.pageIndex === 0),
      crops,
    );
    return crops;
  } catch (error) {
    signal?.throwIfAborted();
    log.warn('[DeepSeek OCR] Figure cropping failed; returning text only:', error);
    return [];
  }
}

/** Whether `figures` can be cropped from this source at all (not Word/PowerPoint). */
async function canCropFigures(buffer: Buffer): Promise<boolean> {
  if (isPdf(buffer)) return true;
  try {
    const { width, height } = await sharp(buffer).metadata();
    return !!width && !!height;
  } catch {
    return false;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new MaterialExtractionError('DeepSeek OCR response is too large', false);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new MaterialExtractionError('DeepSeek OCR response is too large', false);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The error a DeepSeek OCR failure throws: a document over the page limit is
 * refused as the source's fault (not retried, no other provider tried); a
 * busy service, a rate limit or an internal error may pass on a retry; the
 * rest (a password, an unsupported or broken file, insufficient balance, a
 * recognition that ran out of time) fail the same way again.
 */
export function deepseekOCRFailure(status: number | undefined, rawMessage: string): Error {
  const message = rawMessage.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
  const where = status && status !== 200 ? ` (HTTP ${status})` : '';
  if (/more than\s+1,?000\s+pages/i.test(message)) {
    return new MaterialSourceRefusedError(
      `DeepSeek OCR refused the document: too many pages${where}; limit ${DEEPSEEK_OCR_MAX_PAGES} pages`,
      { reasonCode: 'too_many_pages', reasonValues: { maxPages: DEEPSEEK_OCR_MAX_PAGES } },
    );
  }
  const transient =
    status === 429 ||
    status === 500 ||
    status === 503 ||
    /temporarily unavailable|internal server error/i.test(message);
  return new MaterialExtractionError(
    `DeepSeek OCR failed${where}${message ? `: ${message}` : ''}`,
    transient,
  );
}

function sanitizeFileName(name: string | undefined, isPdfFile: boolean): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim();
  return base || (isPdfFile ? 'document.pdf' : 'document');
}

/**
 * Parse a document with DeepSeek OCR. Returns the document's markdown and, for
 * PDFs and images, its figures cropped out as PNG data URLs.
 */
export async function parseWithDeepSeekOCR(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  options?: { fileName?: string; mimeType?: string },
): Promise<ParsedPdfContent> {
  if (!config.apiKey) throw new Error('DeepSeek OCR API key is required');
  if (documentBuffer.byteLength > DEEPSEEK_OCR_MAX_FILE_BYTES) {
    throw new MaterialExtractionError('DeepSeek OCR accepts files of at most 100 MiB', false);
  }
  const endpoint = deepseekToolsEndpoint(config.baseUrl || DEEPSEEK_OCR_DEFAULT_BASE, 'ocr');
  const pdf = isPdf(documentBuffer);
  const fileName = sanitizeFileName(options?.fileName, pdf);
  const mimeType = options?.mimeType || (pdf ? 'application/pdf' : 'application/octet-stream');

  const form = new FormData();
  form.set('purpose', DEEPSEEK_OCR_PURPOSE);
  form.set('file', new Blob([new Uint8Array(documentBuffer)], { type: mimeType }), fileName);

  // The official endpoint, or a server-configured one (which may be on a
  // local network); a redirect is refused rather than followed with the key.
  const policy: ProviderFetchPolicy = {
    allowLocalNetworks: config.managed ? true : undefined,
    rejectRedirects: true,
  };
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
  log.info(`[DeepSeek OCR] Recognizing ${fileName} (${documentBuffer.byteLength} bytes)`);

  const response = await providerFetch(
    endpoint,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      body: form,
      signal,
    },
    policy,
  );
  const body = (await readBoundedText(response)).trim();
  let json: DeepSeekOCRResponse | undefined;
  try {
    json = body ? (JSON.parse(body) as DeepSeekOCRResponse) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    log.warn(`[DeepSeek OCR] HTTP ${response.status}: ${body.slice(0, 500)}`);
    throw deepseekOCRFailure(response.status, json?.error?.message ?? '');
  }
  if (!json) {
    log.warn(`[DeepSeek OCR] Non-JSON body: ${body.slice(0, 500)}`);
    throw new MaterialExtractionError('DeepSeek OCR returned an invalid response', true);
  }
  // Once recognition has started the status is already 200: a failure
  // arrives as an error object in place of the result.
  if (json.error) {
    log.warn(`[DeepSeek OCR] Recognition failed: ${JSON.stringify(json.error).slice(0, 500)}`);
    throw deepseekOCRFailure(undefined, json.error.message ?? json.error.code ?? '');
  }
  if (!Array.isArray(json.pages)) {
    throw new MaterialExtractionError('DeepSeek OCR returned no pages', true);
  }

  const pages = json.pages
    .map((page, position) => ({
      index: Number.isInteger(page.index) ? page.index! : position,
      text: typeof page.text === 'string' ? page.text : '',
      finishReason: page.finish_reason,
    }))
    .sort((a, b) => a.index - b.index);
  // A page that hit the output limit lost its end: refuse the result rather
  // than hand on a document with text silently missing.
  const truncated = pages
    .filter((page) => page.finishReason === 'length')
    .map((page) => page.index + 1);
  if (truncated.length) {
    log.warn(`[DeepSeek OCR] Page(s) ${truncated.join(', ')} hit the output limit`);
    throw new MaterialExtractionError(
      `DeepSeek OCR could not read all of page(s) ${truncated.join(', ')}: ` +
        'the page hit the output limit. Try another document parser.',
      false,
    );
  }

  const withFigures = config.textOnly !== true && (await canCropFigures(documentBuffer));
  const { markdown, figures } = deepseekOCRToMarkdown(pages, withFigures);
  const crops = withFigures ? await figureCrops(documentBuffer, figures, config.signal) : [];
  // A figure that could not be cropped keeps no reference to a missing image.
  const cropped = new Set(crops.map((crop) => crop.figure.path));
  let text = markdown;
  for (const figure of figures) {
    if (!cropped.has(figure.path)) {
      text = text.replace(`![${altText(figure.caption)}](${figure.path})`, '');
    }
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const pdfImages = crops.map((crop, i) => ({
    id: `img_${i + 1}`,
    src: crop.src,
    pageNumber: crop.figure.pageIndex + 1,
    ...(crop.figure.caption ? { description: crop.figure.caption } : {}),
    width: crop.width,
    height: crop.height,
    path: crop.figure.path,
  }));
  log.info(
    `[DeepSeek OCR] Parsed ${json.page_count ?? pages.length} page(s): ${text.length} chars, ` +
      `${pdfImages.length} figure(s)`,
  );

  return {
    text,
    images: pdfImages.map((image) => image.src),
    metadata: {
      fileName,
      pageCount: json.page_count ?? pages.length,
      parser: 'deepseek-ocr',
      imageMapping: Object.fromEntries(pdfImages.map((image) => [image.id, image.src])),
      pdfImages,
    },
  };
}
