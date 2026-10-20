/**
 * Turning a split material bundle into the per-part inputs a course series
 * runs with: each part's `GenerationRunInput.seriesContext.textRanges`, the
 * half-open character range of each material's extracted text that part
 * teaches.
 *
 * Kept separate from the split algorithm itself (`lib/document/series-split`)
 * because this module speaks in terms of the generation run's input shape,
 * while the split module only knows about `ParsedDocumentPart`s; and separate
 * from the orchestrator (`./orchestrator`), which is the part that touches
 * persistence, so this stays a pure function a unit test can call directly.
 */
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';
import type { ParsedDocumentPart } from '@/lib/document/bundle';
import { materialNeedsSeriesSplit, splitMaterialIntoSeries } from '@/lib/document/series-split';
import type { PendingSeriesPart, SeriesPartTextRange } from '@/lib/persistence/course-series';

/**
 * Plan is a no-op (returns null) when `parts` fits the single-course budget:
 * callers that check {@link materialNeedsSeriesSplit} first will not usually
 * see this, but it stays correct either way, same as the split module.
 */
export function planCourseSeries(
  parts: readonly ParsedDocumentPart[],
  maxChars: number = MAX_PDF_CONTENT_CHARS,
): PendingSeriesPart[] | null {
  if (!materialNeedsSeriesSplit(parts, maxChars)) return null;

  // The offset each material's text starts at within itself (always 0: every
  // material's own text, not a concatenation of materials) is irrelevant
  // here; what matters is where each of its *slices* (if sliced at all) falls
  // within that one material's text. Slices are produced in order by
  // `splitMaterialIntoSeries`/`sliceDocumentPart`, contiguously consuming the
  // material's text from the front, so the running offset is reconstructed
  // by walking slices of the same base id in the order they were produced.
  const nextOffsetByMaterialId = new Map<string, number>();

  const seriesParts = splitMaterialIntoSeries(parts, maxChars);
  return seriesParts.map((seriesPart) => {
    const textRanges: Record<string, SeriesPartTextRange> = {};
    for (const part of seriesPart.parts) {
      const materialId = part.source.id.split('#')[0]!;
      const start = nextOffsetByMaterialId.get(materialId) ?? 0;
      const end = start + part.text.length;
      textRanges[materialId] = { start, end };
      nextOffsetByMaterialId.set(materialId, end);
    }
    return { order: seriesPart.index, textRanges };
  });
}
