import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type { PdfImage, SessionPdfSource } from '@/lib/types/generation';

export const MAX_PDF_FILES = 5;
export const MAX_TOTAL_PDF_SIZE_BYTES = 150 * 1024 * 1024;
export const PDF_PARSE_CONCURRENCY = 2;

const BASE_BUDGET_PER_FILE = 1500;
const RESERVED_BUDGET_RATIO = 0.4;
const SECTION_SEPARATOR = '\n\n---\n\n';

export interface ParsedPdfAsset extends Omit<PdfImage, 'storageId' | 'visionPriority'> {
  src: string;
}

export interface ParsedPdfPart {
  source: SessionPdfSource;
  text: string;
  rawTextLength: number;
  pageCount: number;
  images: ParsedPdfAsset[];
}

export interface AggregatedPdfResult {
  pdfText: string;
  pdfImages: ParsedPdfAsset[];
  textContentBudget: number;
  totalRawTextLength: number;
  totalImageCount: number;
  visionImageCount: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceImageIds(text: string, idMap: ReadonlyMap<string, string>): string {
  let nextText = text;
  for (const [fromId, toId] of idMap.entries()) {
    nextText = nextText.replace(
      new RegExp(`(?<![\\w-])${escapeRegex(fromId)}(?![\\w-])`, 'g'),
      toId,
    );
  }
  return nextText;
}

function buildSectionHeader(part: ParsedPdfPart, index: number): string {
  const headerLines = [
    `## Source PDF ${index + 1}: ${part.source.name}`,
    `- Order: ${part.source.order}`,
    `- Pages: ${part.pageCount}`,
    '',
  ];
  return `${headerLines.join('\n')}\n`;
}

export function allocateTextBudgets(lengths: number[], maxChars: number): number[] {
  if (lengths.length === 0 || maxChars <= 0) {
    return lengths.map(() => 0);
  }

  const reserved = Math.min(
    lengths.length * BASE_BUDGET_PER_FILE,
    Math.floor(maxChars * RESERVED_BUDGET_RATIO),
  );
  const basePerFile = Math.floor(reserved / lengths.length);
  const initialBudgets = lengths.map((length) => Math.min(length, basePerFile));
  let remainingBudget = maxChars - initialBudgets.reduce((sum, value) => sum + value, 0);

  const unmetIndexes = lengths
    .map((length, index) => ({ index, remaining: Math.max(0, length - initialBudgets[index]) }))
    .filter((entry) => entry.remaining > 0);

  while (remainingBudget > 0 && unmetIndexes.length > 0) {
    const totalRemaining = unmetIndexes.reduce((sum, entry) => sum + entry.remaining, 0);
    if (totalRemaining === 0) break;

    let distributed = 0;
    for (const entry of unmetIndexes) {
      if (remainingBudget === 0) break;
      const proportionalShare = Math.floor((remainingBudget * entry.remaining) / totalRemaining);
      const allocation = Math.min(
        entry.remaining,
        proportionalShare > 0 ? proportionalShare : 1,
        remainingBudget,
      );
      initialBudgets[entry.index] += allocation;
      entry.remaining -= allocation;
      remainingBudget -= allocation;
      distributed += allocation;
    }

    if (distributed === 0) break;

    for (let i = unmetIndexes.length - 1; i >= 0; i -= 1) {
      if (unmetIndexes[i].remaining === 0) {
        unmetIndexes.splice(i, 1);
      }
    }
  }

  return initialBudgets;
}

function compareImagesForVision(a: ParsedPdfAsset, b: ParsedPdfAsset): number {
  const aHasDescription = Number(Boolean(a.description));
  const bHasDescription = Number(Boolean(b.description));
  if (aHasDescription !== bHasDescription) {
    return bHasDescription - aHasDescription;
  }

  if (a.pageNumber !== b.pageNumber) {
    return a.pageNumber - b.pageNumber;
  }

  const aArea = (a.width ?? 0) * (a.height ?? 0);
  const bArea = (b.width ?? 0) * (b.height ?? 0);
  return bArea - aArea;
}

function pickVisionImages(images: ParsedPdfAsset[], maxImages: number): string[] {
  if (images.length === 0 || maxImages <= 0) return [];

  const grouped = new Map<string, ParsedPdfAsset[]>();
  for (const image of images) {
    const key = image.sourceFileId || 'unknown';
    const bucket = grouped.get(key) ?? [];
    bucket.push(image);
    grouped.set(key, bucket);
  }

  const orderedGroups = Array.from(grouped.values()).map((group) =>
    [...group].sort(compareImagesForVision),
  );
  const selectedIds: string[] = [];

  for (const group of orderedGroups) {
    if (selectedIds.length >= maxImages) break;
    if (group.length > 0) {
      selectedIds.push(group.shift()!.id);
    }
  }

  while (selectedIds.length < maxImages) {
    let addedThisRound = false;
    for (const group of orderedGroups) {
      if (selectedIds.length >= maxImages) break;
      if (group.length > 0) {
        selectedIds.push(group.shift()!.id);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
  }

  return selectedIds;
}

export function sortPdfImagesForVision<
  T extends Pick<PdfImage, 'visionPriority' | 'pageNumber' | 'id'>,
>(images: T[]): T[] {
  return [...images].sort((a, b) => {
    const priorityDiff = (b.visionPriority ?? 0) - (a.visionPriority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;

    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;

    return a.id.localeCompare(b.id);
  });
}

export function aggregateParsedPdfs(
  parsedParts: ParsedPdfPart[],
  options?: {
    maxChars?: number;
    maxVisionImages?: number;
  },
): AggregatedPdfResult {
  const maxChars = options?.maxChars ?? MAX_PDF_CONTENT_CHARS;
  const maxVisionImages = options?.maxVisionImages ?? MAX_VISION_IMAGES;

  const orderedParts = [...parsedParts].sort((a, b) => a.source.order - b.source.order);
  const stableParts = orderedParts.map((part) => {
    const stableIdMap = new Map<string, string>();
    const stableImages = part.images.map((image, index) => {
      const stableId = `img_${part.source.order}_${index + 1}`;
      stableIdMap.set(image.id, stableId);
      return {
        ...image,
        id: stableId,
        originalId: image.id,
        sourceFileId: part.source.id,
        sourceFileName: part.source.name,
      };
    });

    return {
      ...part,
      text: replaceImageIds(part.text, stableIdMap),
      images: stableImages,
    };
  });

  const headers = stableParts.map(buildSectionHeader);
  const framingChars =
    headers.reduce((sum, header) => sum + header.length, 0) +
    Math.max(0, stableParts.length - 1) * SECTION_SEPARATOR.length;
  const textContentBudget = Math.max(0, maxChars - framingChars);
  const textBudgets = allocateTextBudgets(
    stableParts.map((part) => part.text.length),
    textContentBudget,
  );

  const flattenedStableImages = stableParts.flatMap((part) => part.images);
  const finalIdMap = new Map<string, string>();
  flattenedStableImages.forEach((image, index) => {
    finalIdMap.set(image.id, `img_${index + 1}`);
  });

  const rewrittenParts = stableParts.map((part, index) => ({
    header: headers[index],
    text: replaceImageIds(part.text, finalIdMap).slice(0, textBudgets[index]),
  }));

  const pdfText = rewrittenParts
    .map((part) => `${part.header}${part.text}`)
    .join(SECTION_SEPARATOR);

  const pdfImages = flattenedStableImages.map((image) => ({
    ...image,
    id: finalIdMap.get(image.id) ?? image.id,
  }));

  const selectedVisionIds = pickVisionImages(pdfImages, maxVisionImages);
  const visionPriorityMap = new Map(
    selectedVisionIds.map((id, index) => [id, selectedVisionIds.length - index]),
  );
  const prioritizedImages = pdfImages.map((image) => ({
    ...image,
    visionPriority: visionPriorityMap.get(image.id) ?? 0,
  }));

  return {
    pdfText,
    pdfImages: prioritizedImages,
    textContentBudget,
    totalRawTextLength: stableParts.reduce((sum, part) => sum + part.rawTextLength, 0),
    totalImageCount: prioritizedImages.length,
    visionImageCount: selectedVisionIds.length,
  };
}
