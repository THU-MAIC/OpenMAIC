import type { ImageMapping, PdfImage } from './outline-types.js';

export function formatImageDescription(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  const sourceInfo = img.sourceDocumentName ? ` from ${img.sourceDocumentName}` : ' from PDF';
  const desc = img.description ? ` | ${img.description}` : '';
  return `- **${img.id}**:${sourceInfo} page ${img.pageNumber}${dimInfo}${desc}`;
}

export function formatImagePlaceholder(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  const sourceInfo = img.sourceDocumentName ? ` from ${img.sourceDocumentName}` : ' from PDF';
  return `- **${img.id}**: image${sourceInfo} page ${img.pageNumber}${dimInfo} [see attached]`;
}

export function sortDocumentImagesForVision<
  T extends Pick<PdfImage, 'visionPriority' | 'pageNumber' | 'id'>,
>(images: T[]): T[] {
  return [...images].sort((a, b) => {
    const priorityDiff = (b.visionPriority ?? 0) - (a.visionPriority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    const aNumericId = Number(a.id.match(/^img_(\d+)$/)?.[1] ?? Number.NaN);
    const bNumericId = Number(b.id.match(/^img_(\d+)$/)?.[1] ?? Number.NaN);
    if (Number.isFinite(aNumericId) && Number.isFinite(bNumericId)) {
      return aNumericId - bNumericId;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * The ordered partition of assigned images the generator consumes: the vision
 * slice (the first `maxVisionImages` images with a mapping entry) and the
 * text-only remainder.
 *
 * Shared by the app's scene-content route and this package's generator so the
 * two cannot drift (RFC #1153 part 2, N3): the route pre-resolves the SAME
 * ordered candidates (`withSrc`) the generator re-slices, so a dropped image
 * admits the next candidate WITH its resolution, never around it.
 */
export interface VisionImagePartition<T> {
  /** Assigned images in the vision-priority order. */
  sorted: T[];
  /** Sorted images that carry a mapping entry — the attachment candidates. */
  withSrc: T[];
  /** The first `maxVisionImages` of `withSrc` — the vision attachments. */
  visionSlice: T[];
  /** `withSrc` beyond the cap — plain text descriptions, never attached. */
  textOnlySlice: T[];
  /** Sorted images WITHOUT a mapping entry — plain text descriptions. */
  noSrcImages: T[];
}

export function partitionImagesForVision<
  T extends Pick<PdfImage, 'visionPriority' | 'pageNumber' | 'id'>,
>(
  images: T[],
  imageMapping: ImageMapping | undefined,
  maxVisionImages: number,
): VisionImagePartition<T> {
  const sorted = sortDocumentImagesForVision(images);
  const withSrc = imageMapping ? sorted.filter((img) => imageMapping[img.id]) : [];
  return {
    sorted,
    withSrc,
    visionSlice: withSrc.slice(0, maxVisionImages),
    textOnlySlice: withSrc.slice(maxVisionImages),
    noSrcImages: imageMapping ? sorted.filter((img) => !imageMapping[img.id]) : sorted,
  };
}
