/**
 * PPTX zip archive parser.
 * Extracts and categorizes all files from a .pptx (which is a zip archive).
 */

import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';

export interface PptxFiles {
  contentTypes: string;
  presentation: string;
  presentationRels: string;
  slides: Map<string, string>;
  slideRels: Map<string, string>;
  slideLayouts: Map<string, string>;
  slideLayoutRels: Map<string, string>;
  slideMasters: Map<string, string>;
  slideMasterRels: Map<string, string>;
  themes: Map<string, string>;
  media: Map<string, Uint8Array>;
  tableStyles?: string;
  charts: Map<string, string>; // ppt/charts/chart*.xml
  chartStyles: Map<string, string>; // ppt/charts/style*.xml
  chartColors: Map<string, string>; // ppt/charts/colors*.xml
  diagramDrawings: Map<string, string>; // ppt/diagrams/drawing*.xml (SmartArt fallback)
  notesSlides: Map<string, string>; // ppt/notesSlides/notesSlide*.xml
  embeddings: Map<string, Uint8Array>; // ppt/embeddings/*.docx etc.
}

export interface ZipParseLimits {
  /** Maximum number of non-directory entries in the zip archive. */
  maxEntries?: number;
  /** Maximum uncompressed size for any single entry (bytes). */
  maxEntryUncompressedBytes?: number;
  /** Maximum total uncompressed size across all entries (bytes). */
  maxTotalUncompressedBytes?: number;
  /** Maximum uncompressed size across media entries under `ppt/media/` (bytes). */
  maxMediaBytes?: number;
  /** Maximum concurrent zip entry reads during parsing. */
  maxConcurrency?: number;
}

function throwZipLimitExceeded(reason: string): never {
  throw new Error(`PPTX zip limit exceeded: ${reason}`);
}

function readUncompressedSize(file: JSZipObject): number | undefined {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(concurrency, items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await mapper(items[index]);
    }
  });

  await Promise.all(workers);
}

/**
 * Parse a .pptx file buffer and extract all relevant files, categorized by type.
 */
export async function parseZip(
  buffer: ArrayBuffer,
  limits: ZipParseLimits = {},
): Promise<PptxFiles> {
  const maxConcurrency = limits.maxConcurrency ?? 8;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throwZipLimitExceeded(`maxConcurrency ${limits.maxConcurrency} must be an integer >= 1`);
  }

  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.entries(zip.files).filter(([, file]) => !file.dir);

  if (limits.maxEntries !== undefined && entries.length > limits.maxEntries) {
    throwZipLimitExceeded(`entries ${entries.length} > maxEntries ${limits.maxEntries}`);
  }

  const knownSizeByPath = new Map<string, number>();
  let knownTotalBytes = 0;
  let knownMediaBytes = 0;

  for (const [rawPath, file] of entries) {
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const size = readUncompressedSize(file);
    if (size === undefined) continue;

    knownSizeByPath.set(normalizedPath, size);

    if (limits.maxEntryUncompressedBytes !== undefined && size > limits.maxEntryUncompressedBytes) {
      throwZipLimitExceeded(
        `${normalizedPath} is ${size} bytes > maxEntryUncompressedBytes ${limits.maxEntryUncompressedBytes}`,
      );
    }

    knownTotalBytes += size;
    if (
      limits.maxTotalUncompressedBytes !== undefined &&
      knownTotalBytes > limits.maxTotalUncompressedBytes
    ) {
      throwZipLimitExceeded(
        `total uncompressed bytes ${knownTotalBytes} > maxTotalUncompressedBytes ${limits.maxTotalUncompressedBytes}`,
      );
    }

    if (normalizedPath.startsWith('ppt/media/')) {
      knownMediaBytes += size;
      if (limits.maxMediaBytes !== undefined && knownMediaBytes > limits.maxMediaBytes) {
        throwZipLimitExceeded(
          `media bytes ${knownMediaBytes} > maxMediaBytes ${limits.maxMediaBytes}`,
        );
      }
    }
  }

  const result: PptxFiles = {
    contentTypes: '',
    presentation: '',
    presentationRels: '',
    slides: new Map(),
    slideRels: new Map(),
    slideLayouts: new Map(),
    slideLayoutRels: new Map(),
    slideMasters: new Map(),
    slideMasterRels: new Map(),
    themes: new Map(),
    media: new Map(),
    charts: new Map(),
    chartStyles: new Map(),
    chartColors: new Map(),
    diagramDrawings: new Map(),
    notesSlides: new Map(),
    embeddings: new Map(),
  };

  let unknownMediaBytes = 0;

  await mapWithConcurrency(entries, maxConcurrency, async ([path, file]) => {
    const normalizedPath = path.replace(/\\/g, '/');

    // --- Content Types ---
    if (normalizedPath === '[Content_Types].xml') {
      result.contentTypes = await file.async('string');
      return;
    }

    // --- Presentation ---
    if (normalizedPath === 'ppt/presentation.xml') {
      result.presentation = await file.async('string');
      return;
    }

    // --- Presentation Rels ---
    if (normalizedPath === 'ppt/_rels/presentation.xml.rels') {
      result.presentationRels = await file.async('string');
      return;
    }

    // --- Table Styles ---
    if (normalizedPath === 'ppt/tableStyles.xml') {
      result.tableStyles = await file.async('string');
      return;
    }

    // --- Media (binary) ---
    if (normalizedPath.startsWith('ppt/media/')) {
      const bytes = await file.async('uint8array');
      if (!knownSizeByPath.has(normalizedPath)) {
        const size = bytes.byteLength;
        if (
          limits.maxEntryUncompressedBytes !== undefined &&
          size > limits.maxEntryUncompressedBytes
        ) {
          throwZipLimitExceeded(
            `${normalizedPath} is ${size} bytes > maxEntryUncompressedBytes ${limits.maxEntryUncompressedBytes}`,
          );
        }
        unknownMediaBytes += size;
        if (
          limits.maxMediaBytes !== undefined &&
          knownMediaBytes + unknownMediaBytes > limits.maxMediaBytes
        ) {
          throwZipLimitExceeded(
            `media bytes ${knownMediaBytes + unknownMediaBytes} > maxMediaBytes ${limits.maxMediaBytes}`,
          );
        }
      }
      result.media.set(normalizedPath, bytes);
      return;
    }

    // --- Slide Rels (must check before slides to avoid false match) ---
    if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(normalizedPath)) {
      result.slideRels.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Slides ---
    if (/^ppt\/slides\/slide\d+\.xml$/.test(normalizedPath)) {
      result.slides.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Notes Slides ---
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(normalizedPath)) {
      result.notesSlides.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Slide Layout Rels ---
    if (/^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/.test(normalizedPath)) {
      result.slideLayoutRels.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Slide Layouts ---
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(normalizedPath)) {
      result.slideLayouts.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Slide Master Rels ---
    if (/^ppt\/slideMasters\/_rels\/slideMaster\d+\.xml\.rels$/.test(normalizedPath)) {
      result.slideMasterRels.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Slide Masters ---
    if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(normalizedPath)) {
      result.slideMasters.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Themes ---
    if (/^ppt\/theme\/theme\d+\.xml$/.test(normalizedPath)) {
      result.themes.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Charts ---
    if (/^ppt\/charts\/chart\d+\.xml$/.test(normalizedPath)) {
      result.charts.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Chart Styles ---
    if (/^ppt\/charts\/style\d+\.xml$/.test(normalizedPath)) {
      result.chartStyles.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Chart Colors ---
    if (/^ppt\/charts\/colors\d+\.xml$/.test(normalizedPath)) {
      result.chartColors.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Diagram Drawings (SmartArt fallback) ---
    if (/^ppt\/diagrams\/drawing\d+\.xml$/.test(normalizedPath)) {
      result.diagramDrawings.set(normalizedPath, await file.async('string'));
      return;
    }

    // --- Embeddings (OLE objects: .docx, .xlsx, etc.) ---
    if (normalizedPath.startsWith('ppt/embeddings/')) {
      result.embeddings.set(normalizedPath, await file.async('uint8array'));
      return;
    }
  });

  return result;
}
