import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';

import { chapterSourceFromBlocks, withChapterSource } from '@/lib/document/chapter-source';

import { applyImagePlan } from '@/lib/server/material-extraction/document-image-apply.mjs';
import type { ImagePlan } from '@/lib/server/material-extraction/document-image-apply.mjs';
import {
  DocumentImageInputBudgetError,
  runDocumentImageWorker,
} from '@/lib/server/material-extraction/document-image-parser';
import { createLogger } from '@/lib/logger';
import {
  MaterialExtractionError,
  MaterialSourceRefusedError,
} from '@/lib/server/material-extraction/errors';
import type { ParsedPdfContent } from '@/lib/types/pdf';

import { extractMinerUResult } from './mineru-parser';

const log = createLogger('MinerUChunks');

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Shared page threshold for PDF chunking and optional chapter recognition. */
export function getMinerUChunkPages(): number {
  return positiveInteger('PDF_MINERU_CHUNK_PAGES', 50);
}

/** Only self-hosted PDF parsing uses these limits; Office documents stay whole. */
function chunkConfig() {
  return {
    maxPages: positiveInteger('PDF_MINERU_MAX_PAGES', 1000),
    chunkPages: getMinerUChunkPages(),
    concurrency: positiveInteger('PDF_MINERU_CHUNK_CONCURRENCY', 4),
  };
}

/** Remove page destinations before copyPages can follow them into other pages. */
function removeInternalLinks(document: PDFDocument): void {
  const name = PDFName.of;
  for (const page of document.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    const kept = [];
    for (const raw of annotations.asArray()) {
      const annotation = document.context.lookup(raw);
      if (!(annotation instanceof PDFDict)) {
        kept.push(raw);
        continue;
      }
      const action = annotation.lookup(name('A'));
      if (
        annotation.get(name('Subtype')) === name('Link') &&
        (annotation.has(name('Dest')) ||
          (action instanceof PDFDict && action.get(name('S')) === name('GoTo')))
      ) {
        continue;
      }
      // Even a URI annotation may point back to its source page via /P.
      // Copying that pointer would pull the source page graph into the chunk.
      const copy = annotation.clone();
      copy.delete(name('P'));
      kept.push(copy);
    }
    if (kept.length) page.node.set(name('Annots'), document.context.obj(kept));
    else page.node.delete(name('Annots'));
  }
}

export interface MinerUChunkResult {
  /** Zero-based index of the chunk's first page in the original PDF. */
  startPage: number;
  result: Record<string, unknown>;
}

/** Merge only the existing result fields; no per-chunk artifact is persisted. */
export async function mergeMinerUChunks(
  chunks: readonly MinerUChunkResult[],
  physicalPageCount?: number,
  signal?: AbortSignal,
): Promise<ParsedPdfContent> {
  const markdown: string[] = [];
  const images: Record<string, string> = {};
  const contentList: Record<string, unknown>[] = [];
  for (const { startPage, result } of [...chunks].sort((a, b) => a.startPage - b.startPage)) {
    signal?.throwIfAborted();
    const text = (result.md_content as string) || '';
    let imageEntries = Object.entries((result.images ?? {}) as Record<string, string>);
    let plan: ImagePlan | undefined;
    if (imageEntries.length) {
      try {
        plan = await runDocumentImageWorker(
          { kind: 'plan', text, includeAllTargets: true },
          undefined,
          signal,
        );
      } catch (error) {
        if (signal?.aborted || !(error instanceof DocumentImageInputBudgetError)) throw error;
        // Keep the text, but never publish images whose paths were not namespaced.
        imageEntries = [];
        log.warn('Chunk image rewriting skipped: input exceeds parser budget', {
          firstPage: startPage + 1,
        });
      }
      signal?.throwIfAborted();
    }
    const paths = new Map<string, string>();
    const basenames = new Map<string, string | null>();
    for (const [index, [path, data]] of imageEntries.entries()) {
      const unique = `images/chunk-${startPage + 1}/image-${index + 1}`;
      images[unique] = data;
      paths.set(path, unique);
      const basename = path.split('/').pop()!;
      basenames.set(basename, basenames.has(basename) ? null : unique);
    }
    // Register every real key before aliases so insertion order cannot redirect it.
    for (const [path, data] of imageEntries) {
      const unique = paths.get(path)!;
      for (const alias of [`images/${path}`, ...(/^https?:\/\//i.test(data) ? [data] : [])]) {
        if (!paths.has(alias)) paths.set(alias, unique);
      }
    }
    const imagePath = (path: string): string | undefined => {
      const exact = paths.get(path);
      if (exact) return exact;
      // Only local aliases may fall back to a basename; unrelated URLs stay intact.
      if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) return undefined;
      return basenames.get(path.split('/').pop()!) ?? undefined;
    };
    markdown.push(plan ? applyImagePlan(text, plan, imagePath) : text);
    let items: unknown = result.content_list;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        // As in the single-document parser, malformed optional metadata is ignored.
        items = undefined;
      }
    }
    if (Array.isArray(items)) {
      for (const item of items) {
        contentList.push({
          ...item,
          ...(typeof item.page_idx === 'number' ? { page_idx: item.page_idx + startPage } : {}),
          ...(typeof item.img_path === 'string'
            ? { img_path: imagePath(item.img_path) ?? item.img_path }
            : {}),
        });
      }
    }
  }
  // The same pageCount rule as whole-document parsing: distinct reported page_idx
  // values, not the highest index or the physical page count (blank pages may be absent).
  const parsed = extractMinerUResult({
    md_content: markdown.join('\n\n'),
    images,
    content_list: contentList,
  });
  return physicalPageCount === undefined
    ? parsed
    : withChapterSource(parsed, {
        ...chapterSourceFromBlocks(
          contentList,
          Math.max(physicalPageCount, parsed.metadata?.pageCount ?? 0),
        ),
        physicalPageCount,
      });
}

function chunkFailure(error: unknown, start: number, end: number, attempts: number): Error {
  const message = `MinerU failed to parse PDF pages ${start + 1}–${end} after ${attempts === 1 ? 'one attempt' : 'two attempts'}: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (error instanceof MaterialSourceRefusedError) {
    return new MaterialSourceRefusedError(
      `${message}. PDF_MINERU_CHUNK_PAGES exceeds the parsing service's page limit; reduce it.`,
      {
        cause: error,
        reasonCode: error.reasonCode!,
        reasonValues: error.reasonValues,
      },
    );
  }
  return new MaterialExtractionError(message, false, {
    cause: error,
    reasonCode: 'pages_failed',
    reasonValues: { firstPage: start + 1, lastPage: end },
  });
}

/** Undefined means the original request must be sent unchanged. */
export async function parseMinerUPdfChunks(
  bytes: Buffer,
  parse: (bytes: Buffer, fileName: string, signal: AbortSignal) => Promise<Record<string, unknown>>,
  parentSignal?: AbortSignal,
): Promise<ParsedPdfContent | undefined> {
  parentSignal?.throwIfAborted();
  const config = chunkConfig();
  let document: PDFDocument;
  let pages: number;
  try {
    // Do not ignore encryption: unreadable PDFs keep the existing provider error path.
    document = await PDFDocument.load(bytes, { updateMetadata: false });
    pages = document.getPageCount();
  } catch {
    parentSignal?.throwIfAborted();
    return undefined;
  }
  parentSignal?.throwIfAborted();
  if (pages > config.maxPages) {
    throw new MaterialSourceRefusedError(
      `PDF has ${pages} pages, which exceeds the ${config.maxPages}-page limit`,
      { reasonCode: 'too_many_pages', reasonValues: { pages, maxPages: config.maxPages } },
    );
  }
  if (pages <= config.chunkPages) return undefined;
  removeInternalLinks(document);

  const stopped = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, stopped.signal]) : stopped.signal;
  const results: MinerUChunkResult[] = [];
  let nextPage = 0;
  const worker = async () => {
    try {
      while (nextPage < pages) {
        signal.throwIfAborted();
        const start = nextPage;
        const end = Math.min(start + config.chunkPages, pages);
        nextPage = end;
        const chunk = await PDFDocument.create();
        const copied = await chunk.copyPages(
          document,
          Array.from({ length: end - start }, (_, index) => start + index),
        );
        for (const page of copied) {
          chunk.addPage(page);
          const annotations = page.node.Annots();
          if (annotations instanceof PDFArray) {
            for (const raw of annotations.asArray()) {
              const annotation = chunk.context.lookup(raw);
              if (annotation instanceof PDFDict) annotation.set(PDFName.of('P'), page.ref);
            }
          }
        }
        const chunkBytes = Buffer.from(await chunk.save());
        for (let attempt = 0; attempt < 2; attempt += 1) {
          signal.throwIfAborted();
          try {
            const result = await parse(chunkBytes, `pages-${start + 1}-${end}.pdf`, signal);
            signal.throwIfAborted();
            results.push({ startPage: start, result });
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof MaterialSourceRefusedError)
              throw chunkFailure(error, start, end, attempt + 1);
            if (attempt === 1)
              throw results.length ? chunkFailure(error, start, end, attempt + 1) : error;
          }
        }
      }
    } catch (error) {
      stopped.abort(error);
      throw error;
    }
  };
  // Drain siblings before returning: failed/aborted work must not retain request slots.
  await Promise.allSettled(
    Array.from(
      { length: Math.min(config.concurrency, Math.ceil(pages / config.chunkPages)) },
      worker,
    ),
  );
  parentSignal?.throwIfAborted();
  signal.throwIfAborted();
  return await mergeMinerUChunks(results, pages, signal);
}
