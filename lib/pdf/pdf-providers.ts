/**
 * PDF Parsing Provider Implementation
 *
 * Factory pattern for routing PDF parsing requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - unpdf: Built-in Node.js PDF parser with text and image extraction
 * - MinerU: Advanced commercial service with OCR, formula, and table extraction
 *   (https://mineru.ai or self-hosted)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to PDFProviderId in lib/pdf/types.ts
 *    Example: | 'tesseract-ocr'
 *
 * 2. Add provider configuration to lib/pdf/constants.ts
 *    Example:
 *    'tesseract-ocr': {
 *      id: 'tesseract-ocr',
 *      name: 'Tesseract OCR',
 *      requiresApiKey: false,
 *      icon: '/tesseract.svg',
 *      features: ['text', 'images', 'ocr']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function parseWithXxx(config, pdfBuffer): Promise<ParsedPdfContent>
 *    - Accept PDF as Buffer
 *    - Extract text, images, tables, formulas as needed
 *    - Return unified format:
 *      {
 *        text: string,               // Markdown or plain text
 *        images: string[],           // Base64 data URLs
 *        metadata: {
 *          pageCount: number,
 *          parser: string,
 *          ...                       // Provider-specific metadata
 *        }
 *      }
 *
 *    Example:
 *    async function parseWithTesseractOCR(
 *      config: PDFParserConfig,
 *      pdfBuffer: Buffer
 *    ): Promise<ParsedPdfContent> {
 *      const { createWorker } = await import('tesseract.js');
 *
 *      // Convert PDF pages to images
 *      const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
 *      const numPages = pdf.numPages;
 *
 *      const texts: string[] = [];
 *      const images: string[] = [];
 *
 *      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
 *        // Render page to canvas/image
 *        const page = await pdf.getPage(pageNum);
 *        const viewport = page.getViewport({ scale: 2.0 });
 *        const canvas = createCanvas(viewport.width, viewport.height);
 *        const context = canvas.getContext('2d');
 *        await page.render({ canvasContext: context, viewport }).promise;
 *
 *        // OCR the image
 *        const worker = await createWorker('eng+chi_sim');
 *        const { data: { text } } = await worker.recognize(canvas.toBuffer());
 *        texts.push(text);
 *        await worker.terminate();
 *
 *        // Save image
 *        images.push(canvas.toDataURL());
 *      }
 *
 *      return {
 *        text: texts.join('\n\n'),
 *        images,
 *        metadata: {
 *          pageCount: numPages,
 *          parser: 'tesseract-ocr',
 *        },
 *      };
 *    }
 *
 * 4. Add case to parsePDF() switch statement
 *    case 'tesseract-ocr':
 *      result = await parseWithTesseractOCR(config, pdfBuffer);
 *      break;
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerTesseractOCR: { zh: 'Tesseract OCR', en: 'Tesseract OCR' }
 *
 * 6. Update features in constants.ts to reflect parser capabilities
 *    features: ['text', 'images', 'ocr'] // OCR-capable
 *
 * Provider Implementation Patterns:
 *
 * Pattern 1: Local Node.js Parser (like unpdf)
 * - Import parsing library
 * - Process Buffer directly
 * - Extract text and images synchronously or asynchronously
 * - Convert images to base64 data URLs
 * - Return immediately
 *
 * Pattern 2: Remote API (like MinerU)
 * - Upload PDF or provide URL
 * - Create task and get task ID
 * - Poll for completion (with timeout)
 * - Download results (text, images, metadata)
 * - Parse and convert to unified format
 *
 * Pattern 3: OCR-based Parser (Tesseract, Google Vision)
 * - Render PDF pages to images
 * - Send images to OCR service
 * - Collect text from all pages
 * - Combine with layout analysis if available
 * - Return combined text and original images
 *
 * Image Extraction Best Practices:
 * - Always convert to base64 data URLs (data:image/png;base64,...)
 * - Use PNG for lossless quality
 * - Use sharp for efficient image processing
 * - Handle errors per image (don't fail entire parsing)
 * - Log extraction failures but continue processing
 *
 * Metadata Recommendations:
 * - pageCount: Number of pages in PDF
 * - parser: Provider ID for debugging
 * - processingTime: Time taken (auto-added)
 * - taskId/jobId: For async providers (useful for troubleshooting)
 * - Custom fields: imageMapping, pdfImages, tables, formulas, etc.
 *
 * Error Handling:
 * - Validate API key if requiresApiKey is true
 * - Throw descriptive errors for missing configuration
 * - For async providers, handle timeout and polling errors
 * - Log warnings for non-critical failures (e.g., single page errors)
 * - Always include provider name in error messages
 */

import { extractText, getDocumentProxy, extractImages } from 'unpdf';
import sharp from 'sharp';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { PDF_PROVIDERS } from './constants';
import { createLogger } from '@/lib/logger';
import { extractMinerUResult } from './mineru-parser';
import { parseWithMinerUCloud } from './mineru-cloud';
import { parseWithAliDocMindClient } from './alidocmind-client';

const log = createLogger('PDFProviders');
const DEFAULT_MINERU_BACKEND = 'pipeline';

function getMinerUBackend(): string {
  return process.env.PDF_MINERU_BACKEND?.trim() || DEFAULT_MINERU_BACKEND;
}

/**
 * Turn a self-hosted MinerU error body into an actionable message.
 *
 * A lightweight `mineru-api` install (without the `mineru[pipeline]` or
 * `mineru[core]` extras) accepts uploads but fails to parse PDFs/images,
 * surfacing a raw Python traceback (ModuleNotFoundError / ImportError) or a
 * "Device string must not be empty" error. We detect those signatures and
 * return a friendly explanation instead of dumping the raw JSON at the user.
 *
 * Exported for unit testing.
 */
export function describeSelfHostedMinerUError(status: number, rawBody: string): string {
  const body = rawBody.toLowerCase();
  const missingDependency =
    body.includes('modulenotfounderror') ||
    body.includes('no module named') ||
    body.includes('importerror') ||
    body.includes('device string must not be empty') ||
    (body.includes('pipeline') && (body.includes('not install') || body.includes('unavailable')));

  if (missingDependency) {
    return (
      'The self-hosted MinerU service cannot parse PDF/image files: the ' +
      'pipeline/core dependencies are not installed. Install `mineru[pipeline]` ' +
      'or `mineru[core]` on the MinerU server (and start it with ' +
      '`--backend pipeline`), or switch to MinerU Cloud.'
    );
  }

  // Unknown failure — keep the raw detail but bound its length so the UI stays
  // readable rather than showing an entire JSON blob or traceback.
  const detail = rawBody.trim().slice(0, 300);
  return `MinerU API error (${status})${detail ? `: ${detail}` : ''}`;
}

/**
 * Parse PDF using specified provider
 */
export async function parsePDF(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
  options?: { fileName?: string; mimeType?: string },
): Promise<ParsedPdfContent> {
  const provider = PDF_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown PDF provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    // AliDocMind uses AK/SK instead of a single apiKey; check separately.
    const envAvailable = config.allowEnvFallback && !!process.env.ALIDOCMIND_ACCESS_KEY_ID;
    if (config.providerId !== 'alidocmind' || (!config.accessKeyId && !envAvailable)) {
      throw new Error(`API key required for PDF provider: ${config.providerId}`);
    }
  }

  const startTime = Date.now();

  let result: ParsedPdfContent;

  switch (config.providerId) {
    case 'unpdf':
      result = await parseWithUnpdf(pdfBuffer);
      break;

    case 'mineru':
      result = await parseWithMinerU(config, pdfBuffer);
      break;

    case 'mineru-cloud':
      result = await parseWithMinerUCloud(config, pdfBuffer, options?.fileName);
      break;

    case 'alidocmind':
      result = await parseWithAliDocMind(config, pdfBuffer, options);
      break;

    default:
      throw new Error(`Unsupported PDF provider: ${config.providerId}`);
  }

  // Add processing time to metadata
  if (result.metadata) {
    result.metadata.processingTime = Date.now() - startTime;
  }

  return result;
}

/**
 * Parse PDF using unpdf (existing implementation)
 */
async function parseWithUnpdf(pdfBuffer: Buffer): Promise<ParsedPdfContent> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(uint8Array);
  const numPages = pdf.numPages;

  // Extract text using the document proxy
  const { text: pdfText } = await extractText(pdf, {
    mergePages: true,
  });

  // Extract images using the same document proxy
  const images: string[] = [];
  const pdfImagesMeta: Array<{
    id: string;
    src: string;
    pageNumber: number;
    width: number;
    height: number;
  }> = [];
  let imageCounter = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const pageImages = await extractImages(pdf, pageNum);
      for (let i = 0; i < pageImages.length; i++) {
        const imgData = pageImages[i];
        try {
          // Use sharp to convert raw image data to PNG base64
          const pngBuffer = await sharp(Buffer.from(imgData.data), {
            raw: {
              width: imgData.width,
              height: imgData.height,
              channels: imgData.channels,
            },
          })
            .png()
            .toBuffer();

          // Convert to base64
          const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          imageCounter++;
          const imgId = `img_${imageCounter}`;
          images.push(base64);
          pdfImagesMeta.push({
            id: imgId,
            src: base64,
            pageNumber: pageNum,
            width: imgData.width,
            height: imgData.height,
          });
        } catch (sharpError) {
          log.error(`Failed to convert image ${i + 1} from page ${pageNum}:`, sharpError);
        }
      }
    } catch (pageError) {
      log.error(`Failed to extract images from page ${pageNum}:`, pageError);
    }
  }

  return {
    text: pdfText,
    images,
    metadata: {
      pageCount: numPages,
      parser: 'unpdf',
      imageMapping: Object.fromEntries(pdfImagesMeta.map((m) => [m.id, m.src])),
      pdfImages: pdfImagesMeta,
    },
  };
}

/**
 * Parse PDF using self-hosted MinerU service (mineru-api)
 *
 * Official MinerU API endpoint:
 * POST /file_parse  (multipart/form-data)
 *
 * Response format:
 * { results: { "document.pdf": { md_content, images, content_list, ... } } }
 *
 * @see https://github.com/opendatalab/MinerU
 */
async function parseWithMinerU(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
): Promise<ParsedPdfContent> {
  return parseWithMinerUDocument(config, pdfBuffer, {
    fileName: 'document.pdf',
    mimeType: 'application/pdf',
  });
}

/**
 * Parse a document via AliDocMind (Aliyun Document Mind LLM version).
 * Supports pdf/docx/pptx/xlsx and image types via the same submit → poll → get flow.
 */
async function parseWithAliDocMind(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  options?: { fileName?: string; mimeType?: string },
): Promise<ParsedPdfContent> {
  const fileName = options?.fileName || 'document.pdf';
  const result = await parseWithAliDocMindClient(
    {
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.baseUrl,
      allowEnvFallback: config.allowEnvFallback,
    },
    {
      buffer: documentBuffer,
      fileName,
      llmEnhancement: true,
      enhancementMode: 'VLM',
      outputHtmlTable: true,
    },
  );

  return aliDocMindLayoutsToParsedPdf(result, fileName);
}

/** Match markdown image syntax `![alt](url)` and capture the URL. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;

/** Max images downloaded per document (bounds memory + request fan-out). */
const ALIDOCMIND_MAX_IMAGES = 200;
/** Max bytes per image (bounds memory; AliDocMind crops are small PNGs). */
const ALIDOCMIND_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Concurrent image downloads. */
const ALIDOCMIND_IMAGE_CONCURRENCY = 6;

/**
 * AliDocMind returns image URLs on Aliyun OSS. Restrict fetches to OSS hosts so
 * a compromised/custom endpoint can't turn image extraction into an SSRF vector
 * pointing at internal hosts. Matches `*.oss-*.aliyuncs.com` (and the
 * doc-mind-video bucket host family).
 */
/**
 * AliDocMind returns image URLs on Aliyun OSS. Restrict fetches to Aliyun OSS
 * hosts so a compromised/custom endpoint can't turn image extraction into an
 * SSRF vector pointing at internal hosts. Only `*.aliyuncs.com` over http/https
 * is allowed (OSS signed URLs are sometimes served over http; the fetch upgrades
 * them to https).
 */
function isTrustedAliyunOssUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    // Must be an oss-*.aliyuncs.com host (rules out arbitrary *.aliyuncs.com
    // subdomains that aren't object storage).
    return /(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Download an AliDocMind image URL and return a PNG base64 data URL.
 * Only trusted Aliyun OSS hosts are fetched; downloads are size-capped and
 * redirects are disallowed (an OSS signed URL never needs one). Returns null on
 * any failure so one bad image never fails the whole parse.
 */
export async function fetchAliDocMindImageAsBase64(url: string): Promise<string | null> {
  if (!isTrustedAliyunOssUrl(url)) {
    log.warn(`[AliDocMind] refusing non-OSS image URL: ${url.slice(0, 80)}`);
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // signed OSS URLs are direct; a redirect is suspicious
    });
    if (!res.ok) {
      log.warn(`[AliDocMind] image fetch ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    // Reject early on a declared oversized length…
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > ALIDOCMIND_MAX_IMAGE_BYTES) {
      log.warn(`[AliDocMind] image too large (${declared} bytes), skipping`);
      controller.abort();
      return null;
    }
    // …but a missing/false Content-Length can't be trusted, so stream and abort
    // the moment the cumulative byte count exceeds the cap — the whole body is
    // never buffered past the limit.
    const body = res.body;
    if (!body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > ALIDOCMIND_MAX_IMAGE_BYTES) {
          log.warn(
            `[AliDocMind] image stream exceeded ${ALIDOCMIND_MAX_IMAGE_BYTES} bytes, aborting`,
          );
          controller.abort();
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const png = await sharp(buf).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    log.warn(
      `[AliDocMind] image fetch/convert failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Run `fn` over items with a bounded number of concurrent workers. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Map AliDocMind layouts[] shape → ParsedPdfContent.
 *
 * Layout schema (per AliDocMind docs):
 *   { text, markdownContent, type, subType, pageNum, level, index, uniqueId, alignment,
 *     llmResult?, layoutConf?, pos?, ... }
 *   type ∈ { title, text, figure, picture, table, formula, multicolumn, foot, head, ... }
 *
 * Images: figure/picture blocks embed OSS image URLs inside `markdownContent`
 * (markdown `![](url)`), NOT a dedicated field. We download+inline them to
 * base64 and strip the remote URLs from the emitted text (they expire).
 */
async function aliDocMindLayoutsToParsedPdf(
  result: { data: Record<string, unknown>; pageCountEstimate?: number; jobId?: string },
  fileName: string,
): Promise<ParsedPdfContent> {
  const layouts = (Array.isArray(result.data.layouts) ? result.data.layouts : []) as Array<{
    text?: string;
    markdownContent?: string;
    type?: string;
    subType?: string;
    pageNum?: number;
    llmResult?: string;
    layoutConf?: number;
  }>;

  const textParts: string[] = [];
  const layout: NonNullable<ParsedPdfContent['layout']> = [];
  const imageRefs: Array<{ url: string; pageNumber: number }> = [];
  let maxPage = 0;

  for (const l of layouts) {
    // AliDocMind pageNum is 0-based; normalize to 1-based page numbers.
    const pageNum = (l.pageNum ?? 0) + 1;
    maxPage = Math.max(maxPage, pageNum);

    // Tables carry their extracted content (HTML/markdown) in `llmResult` when
    // outputHtmlTable/LLM enhancement is on — markdownContent may be empty.
    const isTable = l.type === 'table';
    // figure/picture embed image URLs in markdownContent; a chart-type figure
    // may additionally have llmResult (chart→table). Collect URLs, then strip
    // them from the text we emit (signed URLs expire; downstream wants base64).
    const isImage = l.type === 'figure' || l.type === 'picture';

    let md = isTable
      ? (l.llmResult ?? l.markdownContent ?? l.text ?? '')
      : (l.markdownContent ?? l.text ?? l.llmResult ?? '');

    if (isImage && md) {
      for (const m of md.matchAll(MARKDOWN_IMAGE_RE)) {
        if (m[1] && imageRefs.length < ALIDOCMIND_MAX_IMAGES) {
          imageRefs.push({ url: m[1], pageNumber: pageNum });
        }
      }
      // Drop the remote-URL markdown from text; keep any chart llmResult instead.
      md = l.llmResult ?? '';
    }

    if (md) textParts.push(md);

    if (l.type) {
      const mappedType = mapLayoutType(l.type);
      if (mappedType) {
        layout.push({
          page: pageNum,
          type: mappedType,
          content: isTable ? (l.llmResult ?? '') : (l.text ?? l.markdownContent ?? ''),
        });
      }
    }
  }

  // Download images with bounded concurrency; keep the source page number so
  // downstream image→page association is correct. Failed downloads drop out.
  const fetched = await mapWithConcurrency(imageRefs, ALIDOCMIND_IMAGE_CONCURRENCY, async (ref) => {
    const src = await fetchAliDocMindImageAsBase64(ref.url);
    return src ? { src, pageNumber: ref.pageNumber } : null;
  });
  const pdfImagesMeta = fetched
    .filter((x): x is { src: string; pageNumber: number } => x !== null)
    .map((x, i) => ({ id: `img_${i + 1}`, src: x.src, pageNumber: x.pageNumber }));
  const images = pdfImagesMeta.map((m) => m.src);

  return {
    text: textParts.join('\n\n'),
    images,
    layout: layout.length ? layout : undefined,
    metadata: {
      fileName,
      // AliDocMind pageNum and pageCountEstimate are both 0-based (verified
      // against a real response: a 14-page doc reports pageNum 0..13 and
      // pageCountEstimate 13). maxPage is already normalized to 1-based, so
      // prefer it; fall back to pageCountEstimate+1 only if we saw no blocks.
      pageCount: maxPage || (result.pageCountEstimate ?? 0) + 1,
      parser: 'alidocmind',
      taskId: result.jobId,
      imageMapping: Object.fromEntries(pdfImagesMeta.map((m) => [m.id, m.src])),
      pdfImages: pdfImagesMeta,
    },
  };
}

function mapLayoutType(type: string): 'title' | 'text' | 'image' | 'table' | 'formula' | null {
  switch (type) {
    case 'title':
      return 'title';
    case 'text':
    case 'multicolumn':
      return 'text';
    case 'figure':
    case 'picture':
      return 'image';
    case 'table':
      return 'table';
    case 'formula':
      return 'formula';
    default:
      return null;
  }
}

export async function parseWithMinerUDocument(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  options: { fileName: string; mimeType: string },
): Promise<ParsedPdfContent> {
  if (!config.baseUrl) {
    throw new Error(
      'MinerU base URL is required. ' +
        'Please deploy MinerU locally or specify the server URL. ' +
        'See: https://github.com/opendatalab/MinerU',
    );
  }

  log.info(`[MinerU] Parsing document with MinerU server: ${config.baseUrl}`);

  // Create FormData for file upload
  const formData = new FormData();

  // Convert Buffer to Blob
  const arrayBuffer = documentBuffer.buffer.slice(
    documentBuffer.byteOffset,
    documentBuffer.byteOffset + documentBuffer.byteLength,
  );
  const blob = new Blob([arrayBuffer as ArrayBuffer], {
    type: options.mimeType,
  });
  formData.append('files', blob, options.fileName);

  // MinerU API form fields
  // Defaults already: return_md=true, formula_enable=true, table_enable=true
  formData.append('parse_method', 'auto');
  // `hybrid-auto-engine` may require a GPU/device configuration in the MinerU
  // service. Default to the broadly compatible pipeline backend; operators can
  // opt into hybrid/VLM mode with PDF_MINERU_BACKEND when their service is ready.
  formData.append('backend', getMinerUBackend());
  formData.append('return_content_list', 'true');
  formData.append('return_images', 'true');

  // API key (if required by deployment)
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  // POST /file_parse
  const response = await fetch(`${config.baseUrl}/file_parse`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(describeSelfHostedMinerUError(response.status, errorText));
  }

  const json = await response.json();

  // Response: { results: { "<fileName>": { md_content, images, content_list, ... } } }
  const fileResult = json.results?.[options.fileName];
  if (!fileResult) {
    const keys = json.results ? Object.keys(json.results) : [];
    // Try first available key in case filename doesn't match exactly
    const fallback = keys.length > 0 ? json.results[keys[0]] : null;
    if (!fallback) {
      throw new Error(`MinerU returned no results. Response keys: ${JSON.stringify(keys)}`);
    }
    log.warn(`[MinerU] Filename mismatch, using key "${keys[0]}" instead of "${options.fileName}"`);
    return extractMinerUResult(fallback);
  }

  return extractMinerUResult(fileResult);
}

/**
 * Get current PDF parser configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentPDFConfig(): Promise<PDFParserConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentPDFConfig() can only be called in browser context');
  }

  // Dynamic import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { pdfProviderId, pdfProvidersConfig } = useSettingsStore.getState();

  const providerConfig = pdfProvidersConfig?.[pdfProviderId];

  return {
    providerId: pdfProviderId,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    accessKeyId: (providerConfig as { accessKeyId?: string })?.accessKeyId,
    accessKeySecret: (providerConfig as { accessKeySecret?: string })?.accessKeySecret,
  };
}

// Re-export from constants for convenience
export { getAllPDFProviders, getPDFProvider } from './constants';
