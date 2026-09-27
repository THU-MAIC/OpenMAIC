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
  chartRels?: Map<string, string>;
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
  /**
   * Maximum uncompressed-to-compressed size ratio for any single entry.
   *
   * Text parts only: `ppt/media/` and `ppt/embeddings/` are exempt, because a
   * ratio cannot tell legitimate content from a bomb there. See
   * {@link DEFAULT_ZIP_PARSE_LIMITS}.
   */
  maxCompressionRatio?: number;
  /** Maximum concurrent zip entry reads during parsing. */
  maxConcurrency?: number;
}

/**
 * Limits applied when the caller does not supply one.
 *
 * Every field used to be optional and no caller passed any, so a call with no
 * limits — which is what both import paths do — ran with all of these bounds
 * disabled. Defaulting per field, rather than defaulting the whole options
 * object, stops a caller who overrides one bound from silently dropping the
 * rest. Pass `Number.POSITIVE_INFINITY` for a bound to switch that one off. A
 * supplied value that is neither finite nor `Infinity` is rejected rather than
 * accepted: `Number(process.env.MAX_ENTRIES)` yielding `NaN` would otherwise
 * compare false against every bound and disable them silently.
 *
 * The sizes are sized against real decks rather than against the worst case: a
 * large deck with embedded video legitimately holds hundreds of megabytes, so
 * these are a backstop for archives that are not decks at all.
 *
 * `maxCompressionRatio` applies to text parts only, because a ratio cannot
 * separate legitimate content from a bomb in binary parts. Uncompressed bitmaps
 * and silent PCM are ordinary deck content and sit at the top of DEFLATE's
 * range — a solid-colour 24-bit BMP measures ~1027:1 and a silent stereo PCM
 * track ~1016:1, and even a 1920x1080 white screenshot with a grid and captions
 * measures ~297:1 — so any threshold below DEFLATE's ceiling rejects real
 * decks. Those parts are bounded by `maxEntryUncompressedBytes` and
 * `maxMediaBytes` instead, which for an honest archive are checked before
 * anything is inflated. Text parts have no such problem: real decks peak around
 * 19:1, so 200 leaves ample headroom.
 *
 * Every bound here except {@link ZipParseLimits.maxEntries} is checked against
 * the sizes the archive declares about itself, which an archive is free to
 * understate. A central directory that declares small and inflates large
 * therefore passes all of them, and the only thing that stops it is JSZip's own
 * `uncompressed data size mismatch` — thrown after that entry has already been
 * inflated, so the allocation happens either way, and the failure arrives as a
 * JSZip error rather than a limit error. The media branch re-measures what it
 * read, which catches that case for media after the fact; text entries are
 * never re-measured. Bounding the allocation itself needs a byte-budgeted
 * inflate inside the read path, which is a larger change than activating the
 * bounds that already existed here.
 */
export const DEFAULT_ZIP_PARSE_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxMediaBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxConcurrency: 8,
} satisfies Required<ZipParseLimits>);

function throwZipLimitExceeded(reason: string): never {
  throw new Error(`PPTX zip limit exceeded: ${reason}`);
}

/**
 * Resolve one supplied bound against its default.
 *
 * `??` rather than `||` so a deliberate `0` means "allow none" rather than
 * falling back to the default. A supplied value that is neither finite nor
 * `Infinity` is refused instead of used: `NaN` compares false against every
 * bound, which would switch the check off without saying so — the exact
 * failure this defaulting exists to prevent.
 */
function resolveLimit(
  supplied: number | undefined,
  fallback: number,
  name: string,
  options: { integer?: boolean } = {},
): number {
  const resolved = supplied ?? fallback;
  const ok =
    resolved === Number.POSITIVE_INFINITY ||
    (Number.isFinite(resolved) &&
      (!options.integer || (Number.isInteger(resolved) && resolved >= 1)));
  if (!ok) {
    throwZipLimitExceeded(
      `${name} ${String(supplied)} must be ${options.integer ? 'an integer >= 1' : 'a finite number'}` +
        ', or Infinity to disable it',
    );
  }
  return resolved;
}

/** Sizes the archive declares for an entry, when it declares them at all. */
interface DeclaredSizes {
  uncompressed?: number;
  compressed?: number;
}

function readDeclaredSizes(file: JSZipObject): DeclaredSizes {
  const data = (
    file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } }
  )._data;
  const size = data?.uncompressedSize;
  const compressed = data?.compressedSize;
  return {
    uncompressed: typeof size === 'number' && Number.isFinite(size) ? size : undefined,
    compressed:
      typeof compressed === 'number' && Number.isFinite(compressed) && compressed > 0
        ? compressed
        : undefined,
  };
}

/**
 * Whether an entry holds opaque binary payload, where how much it compresses
 * says nothing about whether the archive is honest. Media and embedded objects
 * are legitimate at any ratio up to DEFLATE's ceiling; text parts are not.
 */
function isBinaryPart(path: string): boolean {
  return path.startsWith('ppt/media/') || path.startsWith('ppt/embeddings/');
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
  const maxConcurrency = resolveLimit(
    limits.maxConcurrency,
    DEFAULT_ZIP_PARSE_LIMITS.maxConcurrency,
    'maxConcurrency',
    { integer: true },
  );
  const maxEntries = resolveLimit(
    limits.maxEntries,
    DEFAULT_ZIP_PARSE_LIMITS.maxEntries,
    'maxEntries',
    { integer: true },
  );
  const maxEntryUncompressedBytes = resolveLimit(
    limits.maxEntryUncompressedBytes,
    DEFAULT_ZIP_PARSE_LIMITS.maxEntryUncompressedBytes,
    'maxEntryUncompressedBytes',
  );
  const maxTotalUncompressedBytes = resolveLimit(
    limits.maxTotalUncompressedBytes,
    DEFAULT_ZIP_PARSE_LIMITS.maxTotalUncompressedBytes,
    'maxTotalUncompressedBytes',
  );
  const maxMediaBytes = resolveLimit(
    limits.maxMediaBytes,
    DEFAULT_ZIP_PARSE_LIMITS.maxMediaBytes,
    'maxMediaBytes',
  );
  const maxCompressionRatio = resolveLimit(
    limits.maxCompressionRatio,
    DEFAULT_ZIP_PARSE_LIMITS.maxCompressionRatio,
    'maxCompressionRatio',
  );

  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.entries(zip.files).filter(([, file]) => !file.dir);

  if (entries.length > maxEntries) {
    throwZipLimitExceeded(`entries ${entries.length} > maxEntries ${maxEntries}`);
  }

  const knownSizeByPath = new Map<string, number>();
  let knownTotalBytes = 0;
  let knownMediaBytes = 0;

  for (const [rawPath, file] of entries) {
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const { uncompressed: size, compressed } = readDeclaredSizes(file);
    if (size === undefined) continue;

    knownSizeByPath.set(normalizedPath, size);

    if (size > maxEntryUncompressedBytes) {
      throwZipLimitExceeded(
        `${normalizedPath} is ${size} bytes > maxEntryUncompressedBytes ${maxEntryUncompressedBytes}`,
      );
    }

    // Text parts only — media and embedded objects are legitimate at ratios up
    // to DEFLATE's ceiling. See the note on DEFAULT_ZIP_PARSE_LIMITS.
    //
    // Checked before inflating rather than after: an entry the archive
    // describes honestly is rejected here without this process ever allocating
    // its expansion. An entry whose declared sizes are a lie passes this, and
    // is only caught by JSZip after it has been inflated.
    if (
      !isBinaryPart(normalizedPath) &&
      compressed !== undefined &&
      size / compressed > maxCompressionRatio
    ) {
      throwZipLimitExceeded(
        `${normalizedPath} expands ${compressed} -> ${size} bytes ` +
          `(${(size / compressed).toFixed(1)}:1) > maxCompressionRatio ${maxCompressionRatio}:1`,
      );
    }

    knownTotalBytes += size;
    if (knownTotalBytes > maxTotalUncompressedBytes) {
      throwZipLimitExceeded(
        `total uncompressed bytes ${knownTotalBytes} > maxTotalUncompressedBytes ${maxTotalUncompressedBytes}`,
      );
    }

    if (normalizedPath.startsWith('ppt/media/')) {
      knownMediaBytes += size;
      if (knownMediaBytes > maxMediaBytes) {
        throwZipLimitExceeded(`media bytes ${knownMediaBytes} > maxMediaBytes ${maxMediaBytes}`);
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
    chartRels: new Map(),
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
      // Compared against what arrived rather than what was declared, and for
      // every media entry rather than only the ones with no declared size: an
      // entry the archive understated passes every check above, so this is the
      // one bound it meets. It runs after the allocation — necessarily, short
      // of inflating under a byte budget.
      const actualBytes = bytes.byteLength;
      if (actualBytes > maxEntryUncompressedBytes) {
        throwZipLimitExceeded(
          `${normalizedPath} is ${actualBytes} bytes > maxEntryUncompressedBytes ${maxEntryUncompressedBytes}`,
        );
      }
      if (!knownSizeByPath.has(normalizedPath)) {
        unknownMediaBytes += actualBytes;
        if (knownMediaBytes + unknownMediaBytes > maxMediaBytes) {
          throwZipLimitExceeded(
            `media bytes ${knownMediaBytes + unknownMediaBytes} > maxMediaBytes ${maxMediaBytes}`,
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

    if (/^ppt\/charts\/_rels\/chart\d+\.xml\.rels$/.test(normalizedPath)) {
      result.chartRels!.set(normalizedPath, await file.async('string'));
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
