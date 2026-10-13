import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { parseBase64DataUrl } from '@openmaic/generation';
import { MAX_VISION_IMAGE_BYTES, MAX_VISION_IMAGE_DIMENSION } from '@/lib/constants/generation';
import { prepareVisionImages } from '@/lib/server/generation/vision-images';

const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const dataUrl = (buffer: Buffer, mime = 'image/png') =>
  `data:${mime};base64,${buffer.toString('base64')}`;
const tinyImage = () =>
  sharp({ create: { width: 32, height: 24, channels: 4, background: '#00ff0080' } });

async function expectWithinCaps(image: { src: string; width?: number; height?: number }) {
  const parsed = parseBase64DataUrl(image.src)!;
  expect(parsed.mimeType).toBe('image/jpeg');
  const buffer = Buffer.from(parsed.base64, 'base64');
  expect(buffer.byteLength).toBeLessThanOrEqual(MAX_VISION_IMAGE_BYTES);
  const metadata = await sharp(buffer).metadata();
  expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(
    MAX_VISION_IMAGE_DIMENSION,
  );
  expect(image.width).toBe(metadata.width);
  expect(image.height).toBe(metadata.height);
}

describe('vision image preparation', () => {
  it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
    'preserves a small supported %s image',
    async (format) => {
      const log = logger();
      const image = {
        id: 'small',
        src: dataUrl(await tinyImage().toFormat(format).toBuffer(), `image/${format}`),
        width: 32,
        height: 24,
      };
      expect(await prepareVisionImages([image], log)).toEqual([image]);
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it('downscales a large noisy PNG with missing dimensions and compresses it below the byte cap', async () => {
    const buffer = await sharp(randomBytes(4000 * 3000 * 3), {
      raw: { width: 4000, height: 3000, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(buffer.byteLength).toBeGreaterThan(MAX_VISION_IMAGE_BYTES);
    const log = logger();
    const [image] = await prepareVisionImages([{ id: 'large', src: dataUrl(buffer) }], log);
    await expectWithinCaps(image);
    expect(image.width).toBe(2048);
    expect(image.height).toBe(1536);
    expect(log.info).toHaveBeenCalledWith(
      'Transformed vision image',
      expect.objectContaining({
        id: 'large',
        from: { mime: 'image/png', bytes: buffer.byteLength, width: 4000, height: 3000 },
      }),
    );
  }, 20_000);

  it('caps dimensions even when decoded bytes are small', async () => {
    const buffer = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    expect(buffer.byteLength).toBeLessThan(MAX_VISION_IMAGE_BYTES);
    const [image] = await prepareVisionImages([{ id: 'wide', src: dataUrl(buffer) }], logger());
    await expectWithinCaps(image);
    expect(image.width).toBe(2048);
  });

  it('compresses an image over the byte cap even when dimensions fit', async () => {
    const buffer = await sharp(randomBytes(1500 * 1000 * 3), {
      raw: { width: 1500, height: 1000, channels: 3 },
    })
      .png()
      .toBuffer();
    const [image] = await prepareVisionImages(
      [{ id: 'noisy', src: dataUrl(buffer), width: 1500, height: 1000 }],
      logger(),
    );
    await expectWithinCaps(image);
    expect(image.width).toBe(1500);
  });

  it('lowers JPEG quality when the first encoding still exceeds the byte cap', async () => {
    const buffer = await sharp(randomBytes(2048 * 2048 * 3), {
      raw: { width: 2048, height: 2048, channels: 3 },
    })
      .png()
      .toBuffer();
    const firstEncoding = await sharp(buffer).jpeg({ quality: 82 }).toBuffer();
    expect(firstEncoding.byteLength).toBeGreaterThan(MAX_VISION_IMAGE_BYTES);
    const [image] = await prepareVisionImages([{ id: 'quality', src: dataUrl(buffer) }], logger());
    await expectWithinCaps(image);
    expect(image.width).toBe(2048);
    expect(image.height).toBe(2048);
  }, 20_000);

  it('converts TIFF and flattens transparency onto white', async () => {
    const buffer = await tinyImage().tiff().toBuffer();
    const [image] = await prepareVisionImages(
      [{ id: 'tiff', src: dataUrl(buffer, 'image/tiff') }],
      logger(),
    );
    await expectWithinCaps(image);
    expect(
      (await sharp(Buffer.from(parseBase64DataUrl(image.src)!.base64, 'base64')).metadata())
        .hasAlpha,
    ).toBe(false);
  });

  it('drops undecodable data while keeping other attachments in order', async () => {
    const log = logger();
    const good = { id: 'good', src: dataUrl(await tinyImage().png().toBuffer()) };
    const badBytes = Buffer.from('undecodable');
    expect(
      await prepareVisionImages([{ id: 'bad', src: dataUrl(badBytes, 'image/bmp') }, good], log),
    ).toEqual([good]);
    expect(log.warn).toHaveBeenCalledWith(
      'Dropped vision image',
      expect.objectContaining({
        id: 'bad',
        mime: 'image/bmp',
        bytes: badBytes.byteLength,
        reason: expect.any(String),
      }),
    );
  });

  it.each([
    'http://example.org/image.bmp',
    'https://example.org/image.tiff',
    'data:image/svg+xml,<svg/>',
  ])('leaves non-base64 sources untouched: %s', async (src) => {
    const image = { id: 'external', src, width: 4000, height: 3000 };
    const log = logger();
    expect(await prepareVisionImages([image], log)).toEqual([image]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
