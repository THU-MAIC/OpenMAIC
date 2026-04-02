/**
 * MinerU result parser
 * Used by both self-hosted and cloud v4 paths.
 */

import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';

const log = createLogger('MinerUResult');

type ImageMeta = {
  pageIdx: number;
  bbox: number[];
  caption?: string;
};

type ContentItem = Record<string, unknown>;

function parseContentList(raw: unknown): ContentItem[] | null {
  if (Array.isArray(raw)) return raw as ContentItem[];

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      log.warn('[MinerU] content_list is not valid JSON, skipping layout metadata');
      return null;
    }
  }

  return null;
}

function normalizeImageData(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};

  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [
      key,
      value.startsWith('data:') ? value : `data:image/png;base64,${value}`,
    ]),
  );
}

function buildImageMetaLookup(contentList: ContentItem[]): Map<string, ImageMeta> {
  const lookup = new Map<string, ImageMeta>();

  for (const item of contentList) {
    if (item.type !== 'image' || !item.img_path) continue;

    const meta: ImageMeta = {
      pageIdx: (item.page_idx as number) ?? 0,
      bbox: (item.bbox as number[]) || [0, 0, 1000, 1000],
      caption: Array.isArray(item.image_caption) ? (item.image_caption[0] as string) : undefined,
    };

    const imgPath = item.img_path as string;
    lookup.set(imgPath, meta);

    // Also index by basename so we can match `images/foo.png` → `foo.png`
    const basename = imgPath.split('/').pop();
    if (basename && basename !== imgPath) {
      lookup.set(basename, meta);
    }
  }

  return lookup;
}

/**
 * Normalize MinerU API / ZIP output into ParsedPdfContent.
 * Used by both self-hosted and cloud v4 paths.
 */
export function extractMinerUResult(fileResult: Record<string, unknown>): ParsedPdfContent {
  const markdown = (fileResult.md_content as string) || '';
  const imageData = normalizeImageData(fileResult.images);
  const contentList = parseContentList(fileResult.content_list);

  const pageCount = contentList
    ? new Set(contentList.map((item) => item.page_idx).filter((v) => v != null)).size
    : 0;

  const metaLookup = contentList ? buildImageMetaLookup(contentList) : new Map<string, ImageMeta>();

  const imageMapping: Record<string, string> = {};
  const pdfImages: Array<{
    id: string;
    src: string;
    pageNumber: number;
    description?: string;
    width?: number;
    height?: number;
  }> = [];

  for (const [index, [key, base64Url]] of Object.entries(imageData).entries()) {
    const imageId = key.startsWith('img_') ? key : `img_${index + 1}`;
    const meta = metaLookup.get(key) ?? metaLookup.get(`images/${key}`);

    imageMapping[imageId] = base64Url;
    pdfImages.push({
      id: imageId,
      src: base64Url,
      pageNumber: meta ? meta.pageIdx + 1 : 0,
      description: meta?.caption,
      width: meta ? meta.bbox[2] - meta.bbox[0] : undefined,
      height: meta ? meta.bbox[3] - meta.bbox[1] : undefined,
    });
  }

  log.info(`[MinerU] Parsed: ${pdfImages.length} images, ${markdown.length} chars`);

  return {
    text: markdown,
    images: Object.values(imageMapping),
    metadata: {
      pageCount,
      parser: 'mineru',
      imageMapping,
      pdfImages,
    },
  };
}
