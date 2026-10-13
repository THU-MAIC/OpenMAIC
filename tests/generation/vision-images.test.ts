import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { parseBase64DataUrl } from '@openmaic/generation';
import {
  MAX_VISION_IMAGE_BASE64_BYTES,
  MAX_VISION_IMAGE_DIMENSION,
} from '@/lib/constants/generation';
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
  expect(parsed.base64.length).toBeLessThanOrEqual(MAX_VISION_IMAGE_BASE64_BYTES);
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

  it.each(['png', 'jpeg'] as const)('preserves an 8-bit grayscale %s image', async (format) => {
    const buffer = await tinyImage().toColourspace('b-w').toFormat(format).toBuffer();
    expect(await sharp(buffer).metadata()).toMatchObject({ space: 'b-w', depth: 'uchar' });
    const image = { id: 'grayscale', src: dataUrl(buffer, `image/${format}`) };
    expect(await prepareVisionImages([image], logger())).toEqual([image]);
  });

  it.each(['IMAGE/JPEG', 'image/jpg', 'IMAGE/JPG'])(
    'normalizes %s without re-encoding',
    async (mime) => {
      const buffer = await tinyImage().jpeg().toBuffer();
      const log = logger();
      expect(await prepareVisionImages([{ id: 'alias', src: dataUrl(buffer, mime) }], log)).toEqual(
        [{ id: 'alias', src: dataUrl(buffer, 'image/jpeg') }],
      );
      expect(log.info).not.toHaveBeenCalled();
    },
  );

  it.each(['gif', 'webp'] as const)('converts a small animated %s to one frame', async (format) => {
    const buffer = await sharp(randomBytes(32 * 48 * 3), {
      raw: { width: 32, height: 48, channels: 3, pageHeight: 24 },
    })
      .toFormat(format, { loop: 0, delay: [100, 100] })
      .toBuffer();
    expect(await sharp(buffer).metadata()).toMatchObject({ pages: 2 });
    const [image] = await prepareVisionImages(
      [{ id: 'animated', src: dataUrl(buffer, `image/${format}`) }],
      logger(),
    );
    await expectWithinCaps(image);
    expect(image.height).toBe(24);
  });

  it.each(['cmyk', 'rgb16'] as const)('converts a small %s image to 8-bit sRGB', async (space) => {
    const format = space === 'cmyk' ? 'jpeg' : 'png';
    const buffer = await tinyImage().toColourspace(space).toFormat(format).toBuffer();
    expect((await sharp(buffer).metadata()).space).toBe(space);
    const [image] = await prepareVisionImages(
      [{ id: 'color', src: dataUrl(buffer, `image/${format}`) }],
      logger(),
    );
    await expectWithinCaps(image);
    expect(
      await sharp(Buffer.from(parseBase64DataUrl(image.src)!.base64, 'base64')).metadata(),
    ).toMatchObject({ space: 'srgb', depth: 'uchar' });
  });

  it('re-encodes an image whose decoded bytes fit but base64 payload exceeds the cap', async () => {
    const buffer = await sharp(randomBytes(600 * 500 * 3), {
      raw: { width: 600, height: 500, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(buffer.length).toBeLessThan(MAX_VISION_IMAGE_BASE64_BYTES);
    expect(buffer.toString('base64').length).toBeGreaterThan(MAX_VISION_IMAGE_BASE64_BYTES);
    const [image] = await prepareVisionImages([{ id: 'payload', src: dataUrl(buffer) }], logger());
    await expectWithinCaps(image);
    expect(image.width).toBe(600);
  });

  it.each([32, 3000])('drops a truncated JPEG with width %i', async (width) => {
    const buffer = await sharp(randomBytes(width * 100 * 3), {
      raw: { width, height: 100, channels: 3 },
    })
      .jpeg()
      .toBuffer();
    const truncated = buffer.subarray(0, Math.floor(buffer.length * 0.7));
    expect(await sharp(truncated, { failOn: 'none' }).metadata()).toMatchObject({ width });
    const log = logger();
    expect(
      await prepareVisionImages([{ id: 'truncated', src: dataUrl(truncated, 'image/jpeg') }], log),
    ).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Dropped vision image',
      expect.objectContaining({ id: 'truncated' }),
    );
  });

  it('downscales a large noisy PNG with missing dimensions and compresses it below the byte cap', async () => {
    const buffer = await sharp(randomBytes(4000 * 3000 * 3), {
      raw: { width: 4000, height: 3000, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(buffer.byteLength).toBeGreaterThan(MAX_VISION_IMAGE_BASE64_BYTES);
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
    expect(buffer.byteLength).toBeLessThan(MAX_VISION_IMAGE_BASE64_BYTES);
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
    expect(firstEncoding.toString('base64').length).toBeGreaterThan(MAX_VISION_IMAGE_BASE64_BYTES);
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
