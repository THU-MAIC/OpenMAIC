import type { PdfImage } from './outline-types.js';

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
