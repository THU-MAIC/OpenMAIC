/**
 * Shared PaddleOCR result parsers.
 *
 * The self-hosted PaddleX serving and the Baidu Cloud document-parsing API
 * answer in different shapes but describe the same thing — per-page layout
 * results with markdown text and optional images — so both normalize here into
 * {@link ParsedPdfContent}.
 */

import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';

const log = createLogger('PaddleOCRParser');

/**
 * A Baidu image value can be an inline data URL or a storage link (the API
 * documents `data_url` as a link despite the name). Returns the entry as-is
 * for data URLs; links are surfaced with their URL so the caller downloads
 * them under the result-download policy.
 */
function classifyImageValue(
  value: unknown,
): { kind: 'data'; src: string } | { kind: 'link'; url: string } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.startsWith('data:')) return { kind: 'data', src: value };
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return { kind: 'link', url: value };
  }
  return { kind: 'data', src: `data:image/png;base64,${value}` };
}

/**
 * Assemble the shared result. Image metadata keeps both the provider's own
 * reference (`path` — the file name the markdown cites, which the owner
 * rewrite matches against) and the sequential `img_n` id it is replaced by.
 */
function buildResult(
  text: string,
  images: Array<{ path: string; src: string; pageNumber: number }>,
  pageCount: number,
  parser: 'paddleocr' | 'paddleocr-cloud',
): ParsedPdfContent {
  const imageMapping: Record<string, string> = {};
  const dataUrls: string[] = [];
  const pdfImages = images.map(({ path, src, pageNumber }, index) => {
    const id = `img_${index + 1}`;
    imageMapping[id] = src;
    dataUrls.push(src);
    return { id, src, pageNumber, path };
  });

  log.info(
    `[PaddleOCR] Parsed successfully (${parser}): ${images.length} images, ` +
      `${text.length} chars of markdown, ${pageCount} page(s)`,
  );

  return {
    text,
    images: dataUrls,
    metadata: {
      pageCount,
      parser,
      imageMapping,
      pdfImages,
    },
  };
}

/**
 * Self-hosted PaddleX serving (`POST /layout-parsing`): one entry per page
 * (or the single image), each carrying `markdown: { text, images }` where the
 * images dict maps the markdown's file references to base64 payloads. The
 * dict key IS the path the markdown cites, so it is preserved per image, and
 * the entry's position in the array is the page it belongs to.
 */
export function extractPaddleLayoutParsing(
  layoutParsingResults: unknown,
  parser: 'paddleocr' | 'paddleocr-cloud' = 'paddleocr',
): ParsedPdfContent {
  const results = Array.isArray(layoutParsingResults) ? layoutParsingResults : [];
  const textParts: string[] = [];
  const images: Array<{ path: string; src: string; pageNumber: number }> = [];
  const linkUrls: Array<{ path: string; url: string; pageNumber: number }> = [];

  results.forEach((entry, pageIndex) => {
    const markdown = (entry as Record<string, unknown>)?.markdown as
      | { text?: unknown; images?: unknown }
      | undefined;
    if (typeof markdown?.text === 'string') {
      textParts.push(markdown.text);
    }
    if (markdown?.images && typeof markdown.images === 'object') {
      for (const [path, value] of Object.entries(markdown.images as Record<string, unknown>)) {
        const classified = classifyImageValue(value);
        if (classified?.kind === 'data') {
          images.push({ path, src: classified.src, pageNumber: pageIndex + 1 });
        } else if (classified?.kind === 'link') {
          // The caller (pdf-providers / extractor) downloads links under the
          // result-download policy; recorded here with the URL in `src`.
          linkUrls.push({ path, url: classified.url, pageNumber: pageIndex + 1 });
        }
      }
    }
  });

  const parsed = buildResult(textParts.join('\n\n'), images, results.length, parser);
  if (linkUrls.length > 0) {
    parsed.metadata!.imageLinks = linkUrls.map((l) => ({ ...l, src: l.url }));
    log.info(`[PaddleOCR] ${linkUrls.length} image(s) are storage links, queued for download`);
  }
  return parsed;
}

/**
 * Baidu Cloud document parsing: `parse_result_url` serves a JSON document
 * whose `pages` array carries per-page plain text, layout entries, tables and
 * images. The markdown itself arrives separately (`markdown_url`).
 */
export function extractPaddleCloudParseResult(
  parseResult: unknown,
  markdown: string,
): ParsedPdfContent {
  const pages = (parseResult as { pages?: unknown })?.pages;
  const pageList = Array.isArray(pages) ? (pages as Record<string, unknown>[]) : [];
  const images: Array<{ path: string; src: string; pageNumber: number }> = [];
  const imageLinks: Array<{ path: string; url: string; pageNumber: number }> = [];

  pageList.forEach((page, index) => {
    if (page == null || typeof page !== 'object') return;
    const pageImages = Array.isArray(page.images) ? page.images : [];
    for (const image of pageImages) {
      if (image == null || typeof image !== 'object') continue;
      const classified = classifyImageValue((image as Record<string, unknown>).data_url);
      if (classified?.kind === 'data') {
        images.push({
          path: String(image.layout_id ?? `p${index + 1}-img`),
          src: classified.src,
          pageNumber: index + 1,
        });
      } else if (classified?.kind === 'link') {
        imageLinks.push({
          path: String(image.layout_id ?? `p${index + 1}-img`),
          url: classified.url,
          pageNumber: index + 1,
        });
      }
    }
  });

  const parsed = buildResult(markdown, images, pageList.length, 'paddleocr-cloud');
  if (imageLinks.length > 0) {
    // Surfaced for the caller to download under the result-download policy;
    // `buildResult` did not count them as inline assets.
    (parsed.metadata as { imageLinks?: unknown }).imageLinks = imageLinks;
  }
  return parsed;
}
