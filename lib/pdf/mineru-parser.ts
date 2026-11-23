import { chapterSourceFromBlocks, withChapterSource } from '@/lib/document/chapter-source';
/**
 * Shared MinerU result parser.
 * Used by both self-hosted (pdf-providers.ts) and cloud (mineru-cloud.ts) paths.
 * Normalizes MinerU output (markdown + images dict + content_list) into ParsedPdfContent.
 */

import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';
import { base64ImageMimeType } from '@/lib/utils/base64';
import { basename, normalizePath } from '@/lib/server/material-extraction/document-image-paths.mjs';

const log = createLogger('MinerUParser');

/** The LaTeX of a display equation written as `$$…$$`, if it is one. */
function displayLatex(text: unknown): string | undefined {
  const match = typeof text === 'string' ? /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(text) : null;
  return match?.[1]?.trim() || undefined;
}

/**
 * Whether LaTeX holds the equation itself, not only its number however it is
 * typeset (`\tag{2.7}`, `\tag{A}`, `(2.7a)`, `\left(2.7\right)`,
 * `\mathrm{(A.3)}`). A tag goes whole, whatever it says; other commands are
 * dropped before deciding, so when unsure it answers no and the crop stays.
 */
function hasEquationContent(latex: string): boolean {
  const body = latex
    .replace(/\\tag\*?\s*\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/\\./g, '')
    .replace(/[\s{}~]/g, '');
  return body.length > 0 && !/^\(?[A-Za-z]?[\d.]*\d[\w.-]*\)?$/.test(body);
}

/**
 * The names a markdown target names a file by, normalized as when the text is
 * rewritten (`normalizePath`): no attribute name, `./`, query or URL encoding.
 */
function targetNames(token: string): string[] {
  const target = token.replace(/^[a-z-]+=/i, '');
  if (/^https?:\/\//i.test(target)) return [target];
  const path = normalizePath(target.replace(/[?#].*$/, ''));
  return [path, basename(path)];
}

/** Extract ParsedPdfContent from a single MinerU file result */
export function extractMinerUResult(fileResult: Record<string, unknown>): ParsedPdfContent {
  const markdown: string = (fileResult.md_content as string) || '';
  const imageData: Record<string, string> = {};
  let pageCount = 0;

  // Extract images from the images object (key → base64 string). Only bare
  // base64 of an image is wrapped as a data URL, typed as what its bytes are:
  // a MinerU gateway that hosts the images answers a URL instead, kept as is
  // (the server downloads it when it stores the extraction), and any other
  // value (a path, even one made of base64 characters) is kept as is too, to
  // be dropped, never decoded into garbage bytes.
  if (fileResult.images && typeof fileResult.images === 'object') {
    Object.entries(fileResult.images as Record<string, string>).forEach(([key, value]) => {
      const mimeType = value.startsWith('data:') ? null : base64ImageMimeType(value);
      imageData[key] = mimeType ? `data:${mimeType};base64,${value}` : value;
    });
  }

  // Parse content_list to build image metadata lookup (img_path → metadata)
  const imageMetaLookup = new Map<
    string,
    { pageIdx: number; bbox: number[]; caption?: string; latex?: string }
  >();
  // Names two content_list entries share: an image found by one of them is
  // never left out, whichever entry it belongs to.
  const ambiguousNames = new Set<string>();
  const remember = (name: string, entry: NonNullable<ReturnType<typeof imageMetaLookup.get>>) => {
    const previous = imageMetaLookup.get(name);
    if (previous && previous !== entry) ambiguousNames.add(name);
    imageMetaLookup.set(name, entry);
  };
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

    // Charts, tables and display equations are cropped into images too and
    // referenced by img_path
    const imageTypes = new Set(['image', 'chart', 'table', 'equation']);
    for (const item of contentList) {
      if (imageTypes.has(item.type) && item.img_path) {
        const captions =
          item.type === 'table'
            ? item.table_caption
            : item.type === 'chart'
              ? item.chart_caption
              : item.image_caption;
        const latex = item.type === 'equation' ? displayLatex(item.text) : undefined;
        const metaEntry = {
          pageIdx: item.page_idx ?? 0,
          bbox: item.bbox || [0, 0, 1000, 1000],
          caption: Array.isArray(captions) ? captions[0] : undefined,
          ...(latex && hasEquationContent(latex) ? { latex } : {}),
        };
        // Store under both the full path and basename so lookup works
        // regardless of whether images dict uses "abc.jpg" or "images/abc.jpg"
        remember(item.img_path, metaEntry);
        const fileName = item.img_path.split('/').pop();
        if (fileName && fileName !== item.img_path) {
          remember(fileName, metaEntry);
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
    path?: string;
  }> = [];

  // A display equation's crop is left out when the markdown already carries
  // the equation as LaTeX and does not name the crop: it would only take one
  // of the document's image places. A crop of an equation MinerU recognized
  // no content for (only its number, say) stays, and so does one whose LaTeX
  // the markdown does not hold.
  let markdownMath: Set<string> | undefined;
  const inMarkdownMath = (latex: string): boolean => {
    markdownMath ??= new Set(
      [...markdown.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]!.trim()),
    );
    return markdownMath.has(latex);
  };
  let markdownTargets: Set<string> | undefined;
  // A file name names an image only when one image has it, as when the text
  // is rewritten (`imagePathIndex`): a chunk's image paths
  // (`images/chunk-N/image-M`) repeat theirs, so they are matched whole.
  const fileNameCounts = new Map<string, number>();
  for (const key of Object.keys(imageData)) {
    const name = basename(normalizePath(key));
    fileNameCounts.set(name, (fileNameCounts.get(name) ?? 0) + 1);
  }
  const namedByMarkdown = (key: string, value: string): boolean => {
    // Every name the markdown could give a file, split once, with and without
    // the parentheses a file name may hold; only a token with a `.` or `/`
    // can name one. A word that only looks like a name keeps a crop, never
    // drops one.
    const files = (tokens: string[]) => tokens.filter((t) => t.includes('.') || t.includes('/'));
    markdownTargets ??= new Set([
      ...files(markdown.split(/[\s()<>"'[\]]+/)).flatMap(targetNames),
      ...files(markdown.split(/[\s<>"'[\]]+/)).flatMap((token) =>
        targetNames(token.replace(/^\(/, '').replace(/\)$/, '')),
      ),
    ]);
    const path = normalizePath(key);
    const fileName = basename(path);
    const names = [
      path,
      `images/${path}`,
      ...(fileNameCounts.get(fileName) === 1 ? [fileName] : []),
    ];
    if (/^https?:\/\//i.test(value)) names.push(value);
    return names.some((name) => markdownTargets!.has(name));
  };
  let equationCrops = 0;

  Object.entries(imageData).forEach(([key, base64Url], index) => {
    // Try exact key first, then with 'images/' prefix (MinerU content_list uses prefixed paths).
    // A gateway that hosts the images names them by their URL in content_list too.
    const name = [key, `images/${key}`, base64Url].find((n) => imageMetaLookup.has(n));
    const meta = name === undefined ? undefined : imageMetaLookup.get(name);
    if (
      meta?.latex &&
      !ambiguousNames.has(name!) &&
      inMarkdownMath(meta.latex) &&
      !namedByMarkdown(key, base64Url)
    ) {
      equationCrops += 1;
      return;
    }
    const imageId = key.startsWith('img_') ? key : `img_${index + 1}`;
    imageMapping[imageId] = base64Url;
    pdfImages.push({
      id: imageId,
      src: base64Url,
      pageNumber: meta ? meta.pageIdx + 1 : 0,
      description: meta?.caption,
      width: meta ? meta.bbox[2] - meta.bbox[0] : undefined,
      height: meta ? meta.bbox[3] - meta.bbox[1] : undefined,
      // The file the markdown names this image by; the id above replaces it.
      path: key,
    });
  });

  const images = Object.values(imageMapping);

  log.info(
    `[MinerU] Parsed successfully: ${images.length} images` +
      (equationCrops
        ? ` (${equationCrops} equation crop(s) whose LaTeX is in the text left out)`
        : '') +
      `, ${markdown.length} chars of markdown`,
  );

  return withChapterSource(
    {
      text: markdown,
      images,
      metadata: {
        pageCount,
        parser: 'mineru',
        textFormat: 'markdown',
        imageMapping,
        pdfImages,
      },
    },
    Array.isArray(contentList) ? chapterSourceFromBlocks(contentList, pageCount) : undefined,
  );
}
