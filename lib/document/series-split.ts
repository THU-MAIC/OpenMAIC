/**
 * Splitting a material bundle that is too large for one course into several
 * ordered groups, each sized to fit the generation text budget on its own.
 *
 * `buildDocumentBundle` (./bundle.ts) truncates: past its budget, the extra
 * text is simply left out of the prompt. This module instead keeps every
 * character, by dividing the same {@link ParsedDocumentPart}s into N ordered
 * groups of parts (each itself a valid input to `buildDocumentBundle`), one
 * group per course in a course series.
 *
 * The split is by character budget, in original material order; it does not
 * look at headings or page boundaries. A single document longer than the
 * budget by itself is further divided into contiguous slices of its own
 * text, each becoming its own group entry. This is a first cut: splitting by
 * document structure (headings, pages) is future work and would need the
 * extractors to report where those boundaries fall in the flat text they
 * produce today.
 */
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';
import type { ParsedDocumentPart } from './bundle';
import { truncateTextAtBoundary } from './bundle';

/** One ordered slice of the original material, to become one course's materials. */
export interface MaterialSeriesPart {
  /** 1-based position in the series. */
  index: number;
  parts: ParsedDocumentPart[];
}

/**
 * Whether `parts` together exceed the budget {@link buildDocumentBundle} would
 * truncate to, i.e. whether splitting (rather than one course) applies.
 */
export function materialNeedsSeriesSplit(
  parts: readonly ParsedDocumentPart[],
  maxChars: number = MAX_PDF_CONTENT_CHARS,
): boolean {
  return parts.reduce((sum, part) => sum + part.rawTextLength, 0) > maxChars;
}

/**
 * Slice one document's text into contiguous, boundary-respecting chunks of at
 * most `maxChars` each. The last chunk may be shorter; a document at or under
 * the budget comes back as the single original part, unchanged.
 */
function sliceDocumentPart(part: ParsedDocumentPart, maxChars: number): ParsedDocumentPart[] {
  if (part.text.length <= maxChars) return [part];

  const slices: ParsedDocumentPart[] = [];
  let remaining = part.text;
  let sliceIndex = 0;
  while (remaining.length > 0) {
    const cut = truncateTextAtBoundary(remaining, maxChars);
    // `truncateTextAtBoundary` backs off to a boundary before `maxChars`; a
    // slice with no boundary in range (one long unbroken token) still must
    // make progress, so fall back to a hard cut at `maxChars` for just this
    // slice rather than looping forever on an empty cut.
    const taken = cut.length > 0 ? cut : remaining.slice(0, maxChars);
    slices.push({
      ...part,
      source: { ...part.source, id: `${part.source.id}#${sliceIndex + 1}` },
      text: taken,
      rawTextLength: taken.length,
      images: sliceIndex === 0 ? part.images : [],
    });
    remaining = remaining.slice(taken.length);
    sliceIndex += 1;
  }
  return slices;
}

/**
 * Split `parts` into ordered series parts, each at most `maxChars` of
 * original-order text. Every character of every part's `text` is kept
 * somewhere in the result; nothing is dropped. A document longer than
 * `maxChars` by itself is sliced across as many series parts as it needs,
 * each slice tagged with a `#n` suffix on its source id so it stays
 * distinguishable from the next one.
 *
 * Returns a single series part, unchanged, when nothing needs splitting
 * (mirrors {@link materialNeedsSeriesSplit}); callers that only split when
 * that returns true will not usually hit this path, but it stays correct
 * either way.
 */
export function splitMaterialIntoSeries(
  parts: readonly ParsedDocumentPart[],
  maxChars: number = MAX_PDF_CONTENT_CHARS,
): MaterialSeriesPart[] {
  const ordered = [...parts].sort((a, b) => a.source.order - b.source.order);

  const flatSlices = ordered.flatMap((part) => sliceDocumentPart(part, maxChars));

  const groups: ParsedDocumentPart[][] = [];
  let current: ParsedDocumentPart[] = [];
  let currentLength = 0;
  for (const slice of flatSlices) {
    if (current.length > 0 && currentLength + slice.rawTextLength > maxChars) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(slice);
    currentLength += slice.rawTextLength;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);

  return groups.map((group, index) => ({
    index: index + 1,
    parts: group.map((part, order) => ({ ...part, source: { ...part.source, order } })),
  }));
}
