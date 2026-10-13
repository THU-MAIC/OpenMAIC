import sharp from 'sharp';
import { parseBase64DataUrl, type GenerationLogger } from '@openmaic/generation';
import { MAX_VISION_IMAGE_BYTES, MAX_VISION_IMAGE_DIMENSION } from '@/lib/constants/generation';

interface VisionImage {
  id: string;
  src: string;
  width?: number;
  height?: number;
}

const VISION_FORMATS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const JPEG_QUALITIES = [82, 65, 45, 30, 20];

/** Bound only inline vision attachments, leaving source assets and their ids intact. */
export async function prepareVisionImages<T extends VisionImage>(
  images: readonly T[],
  log: Pick<GenerationLogger, 'info' | 'warn'>,
): Promise<Array<T & VisionImage>> {
  const safeImages: Array<T & VisionImage> = [];
  // Sequential decoding bounds peak memory to one source image and its output.
  for (const image of images) {
    const parsed = parseBase64DataUrl(image.src);
    if (!parsed) {
      safeImages.push(image);
      continue;
    }
    let originalBytes = 0;
    try {
      const buffer = Buffer.from(parsed.base64, 'base64');
      originalBytes = buffer.byteLength;
      const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
      const width = metadata.width;
      const height = metadata.height;
      if (!width || !height) throw new Error('Missing image dimensions');
      if (
        VISION_FORMATS.get(parsed.mimeType) === metadata.format &&
        originalBytes <= MAX_VISION_IMAGE_BYTES &&
        Math.max(width, height, image.width ?? 0, image.height ?? 0) <= MAX_VISION_IMAGE_DIMENSION
      ) {
        safeImages.push(image);
        continue;
      }
      let transformed = false;
      for (const quality of JPEG_QUALITIES) {
        const output = await sharp(buffer, { failOn: 'none' })
          .rotate()
          .resize({
            width: MAX_VISION_IMAGE_DIMENSION,
            height: MAX_VISION_IMAGE_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true });
        if (output.data.byteLength > MAX_VISION_IMAGE_BYTES) continue;
        safeImages.push({
          ...image,
          src: `data:image/jpeg;base64,${output.data.toString('base64')}`,
          width: output.info.width,
          height: output.info.height,
        });
        log.info('Transformed vision image', {
          id: image.id,
          from: { mime: parsed.mimeType, bytes: originalBytes, width, height },
          to: {
            mime: 'image/jpeg',
            bytes: output.data.byteLength,
            width: output.info.width,
            height: output.info.height,
          },
        });
        transformed = true;
        break;
      }
      if (!transformed) throw new Error('Encoded image exceeds the vision byte cap');
    } catch (error) {
      log.warn('Dropped vision image', {
        id: image.id,
        mime: parsed.mimeType,
        bytes: originalBytes,
        reason: error instanceof Error ? error.message : 'Image preparation failed',
      });
    }
  }
  return safeImages;
}
