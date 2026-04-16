/**
 * Shared MinerU result parser.
 * Used by both self-hosted (pdf-providers.ts) and cloud (mineru-cloud.ts) paths.
 * Normalizes MinerU output (markdown + images dict + content_list) into ParsedPdfContent.
 */

import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';

const log = createLogger('MinerUParser');

/** Extract ParsedPdfContent from a single MinerU file result */
export function extractMinerUResult(fileResult: Record<string, unknown>): ParsedPdfContent {
  const markdown: string = (fileResult.md_content as string) || '';
  const imageData: Record<string, string> = {};
  let pageCount = 0;

  // Extract images from the images object (key → base64 string)
  if (fileResult.images && typeof fileResult.images === 'object') {
    Object.entries(fileResult.images as Record<string, string>).forEach(([key, value]) => {
      imageData[key] = value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
    });
  }

  // Parse content_list to build image metadata lookup (img_path → metadata)
  const imageMetaLookup = new Map<string, { pageIdx: number; bbox: number[]; caption?: string }>();
  let contentList: unknown;
  try {
    contentList =
      typeof fileResult.content_list === 'string'
        ? JSON.parse(fileResult.content_list as string)
        : fileResult.content_list;
  } catch {
    log.warn('[MinerU] content_list JSON parse failed, continuing without metadata');
  }
  if (Array.isArray(contentList)) {
    const pages = new Set(
      contentList
        .map((item: Record<string, unknown>) => item.page_idx)
        .filter((v: unknown) => v != null),
    );
    pageCount = pages.size;

    for (const item of contentList) {
      if (item.type === 'image' && item.img_path) {
        const metaEntry = {
          pageIdx: item.page_idx ?? 0,
          bbox: item.bbox || [0, 0, 1000, 1000],
          caption: Array.isArray(item.image_caption) ? item.image_caption[0] : undefined,
        };
        // Store under both the full path and basename so lookup works
        // regardless of whether images dict uses "abc.jpg" or "images/abc.jpg"
        imageMetaLookup.set(item.img_path, metaEntry);
        const basename = item.img_path.split('/').pop();
        if (basename && basename !== item.img_path) {
          imageMetaLookup.set(basename, metaEntry);
        }
      }
    }
  }

  // Build image mapping and pdfImages array
  const imageMapping: Record<string, string> = {};
  const pdfImages: Array<{
    id: string;
    src: string;
    pageNumber: number;
    description?: string;
    width?: number;
    height?: number;
  }> = [];

  Object.entries(imageData).forEach(([key, base64Url], index) => {
    const imageId = key.startsWith('img_') ? key : `img_${index + 1}`;
    imageMapping[imageId] = base64Url;
    // Try exact key first, then with 'images/' prefix (MinerU content_list uses prefixed paths)
    const meta = imageMetaLookup.get(key) || imageMetaLookup.get(`images/${key}`);
    pdfImages.push({
      id: imageId,
      src: base64Url,
      pageNumber: meta ? meta.pageIdx + 1 : 0,
      description: meta?.caption,
      width: meta ? meta.bbox[2] - meta.bbox[0] : undefined,
      height: meta ? meta.bbox[3] - meta.bbox[1] : undefined,
    });
  });

  const images = Object.values(imageMapping);

  log.info(
    `[MinerU] Parsed successfully: ${images.length} images, ` +
      `${markdown.length} chars of markdown`,
  );

  return {
    text: markdown,
    images,
    metadata: {
      pageCount,
      parser: 'mineru',
      imageMapping,
      pdfImages,
    },
  };
}
