/**
 * An extraction's remote images are downloaded into data URLs under the
 * provider-result policy: the real helper, the real SSRF guard; stubbed are
 * `node:dns` (URL-layer answers) and the strict transport (what it answers).
 */
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import * as providerFetchModule from '@/lib/server/provider-fetch';
import {
  imagesAreInline,
  inlineRemoteImages,
  remoteImageUrl,
} from '@/lib/server/materials/inline-images';
import { PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({ promisesLookup: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: mocks.promisesLookup } };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let PNG: Buffer;
const JPEG_URL = 'https://files.example.com/media/aaa';
const PNG_URL = 'https://files.example.com/media/bbb';

function image(id: string, src: string) {
  return { id, src, pageNumber: 1 };
}

describe('inlineRemoteImages', () => {
  let transport: MockInstance<typeof providerFetchModule.providerFetch>;

  beforeEach(async () => {
    PNG ??= await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    mocks.promisesLookup.mockReset().mockResolvedValue(PUBLIC_ANSWER);
    transport = vi.spyOn(providerFetchModule, 'providerFetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads https images into data URLs and keeps inline ones', async () => {
    transport.mockImplementation(async (url) =>
      url === JPEG_URL
        ? new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), {
            headers: { 'content-type': 'image/jpeg' },
          })
        : // No image type declared: the bytes say what they are.
          new Response(new Uint8Array(PNG), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
    );
    const inline = image('img_3', 'data:image/gif;base64,R0lG');

    const result = await inlineRemoteImages([
      image('img_1', JPEG_URL),
      image('img_2', PNG_URL),
      inline,
    ]);

    expect(result.skipped).toBe(0);
    expect(result.images.map((entry) => entry.id)).toEqual(['img_1', 'img_2', 'img_3']);
    expect(result.images[0]).toMatchObject({
      pageNumber: 1,
      src: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64')}`,
    });
    expect(result.images[1]!.src).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(result.images[2]).toBe(inline);
    expect(imagesAreInline(result.images)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledWith(JPEG_URL, expect.anything(), {
      allowLocalNetworks: false,
      requireHttps: true,
    });
  });

  it('sets a downloaded image to its real pixel size, else keeps the extractor values', async () => {
    transport.mockImplementation(async (url) =>
      url === PNG_URL
        ? new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } })
        : // Declared an image but unreadable: the extractor's values stay.
          new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), {
            headers: { 'content-type': 'image/jpeg' },
          }),
    );

    const result = await inlineRemoteImages([
      { ...image('img_1', PNG_URL), width: 300, height: 150 },
      { ...image('img_2', JPEG_URL), width: 300, height: 150 },
    ]);

    expect(result.skipped).toBe(0);
    expect(result.images[0]).toMatchObject({ id: 'img_1', width: 2, height: 2 });
    expect(result.images[1]).toMatchObject({ id: 'img_2', width: 300, height: 150 });
  });

  it('drops an image whose download fails and keeps the rest', async () => {
    transport.mockImplementation(async (url) => {
      if (url === JPEG_URL) throw new Error('connection reset');
      if (url === PNG_URL) return new Response('gone', { status: 404 });
      return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    });

    const result = await inlineRemoteImages([
      image('img_1', JPEG_URL),
      image('img_2', PNG_URL),
      image('img_3', 'https://files.example.com/ok'),
    ]);

    expect(result.skipped).toBe(2);
    expect(result.images.map((entry) => entry.id)).toEqual(['img_3']);
  });

  it('drops an image over the per-image limit, declared or streamed', async () => {
    transport.mockImplementation(
      async (url) =>
        new Response(new Uint8Array(64), {
          headers:
            url === JPEG_URL
              ? { 'content-type': 'image/png', 'content-length': '64' }
              : { 'content-type': 'image/png' },
        }),
    );

    const result = await inlineRemoteImages([image('img_1', JPEG_URL), image('img_2', PNG_URL)], {
      maxImageBytes: 32,
    });

    expect(result).toEqual({ images: [], skipped: 2 });
  });

  it('stops downloading once the byte budget is spent', async () => {
    transport.mockImplementation(
      async () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    const result = await inlineRemoteImages([image('img_1', JPEG_URL), image('img_2', PNG_URL)], {
      maxTotalBytes: PNG.byteLength,
      concurrency: 1,
    });

    expect(result.images.map((entry) => entry.id)).toEqual(['img_1']);
    expect(result.skipped).toBe(1);
  });

  it('drops a response that is not an image', async () => {
    transport.mockResolvedValue(
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    );

    const result = await inlineRemoteImages([image('img_1', JPEG_URL)]);

    expect(result).toEqual({ images: [], skipped: 1 });
  });

  it('drops a source that is neither inline nor a URL, without a request', async () => {
    const result = await inlineRemoteImages([image('img_1', ''), image('img_2', 'images/abc.jpg')]);

    expect(result).toEqual({ images: [], skipped: 2 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('downloads at most maxImages remote images', async () => {
    transport.mockImplementation(
      async () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    const result = await inlineRemoteImages(
      [image('img_1', JPEG_URL), image('img_2', PNG_URL), image('img_3', JPEG_URL)],
      { maxImages: 2 },
    );

    expect(result.images.map((entry) => entry.id)).toEqual(['img_1', 'img_2']);
    expect(result.skipped).toBe(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://files.example.com/media/aaa',
    'https://127.0.0.1/x.png',
    'https://10.0.0.8/x.png',
    'https://169.254.169.254/latest/meta-data/',
  ])('never requests %s', async (url) => {
    const result = await inlineRemoteImages([image('img_1', url)]);

    expect(result).toEqual({ images: [], skipped: 1 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves to a private address', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    const result = await inlineRemoteImages([image('img_1', JPEG_URL)]);

    expect(result).toEqual({ images: [], skipped: 1 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails with the abort when the caller stops it', async () => {
    const controller = new AbortController();
    transport.mockImplementation(async () => {
      controller.abort(new Error('stopped'));
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      inlineRemoteImages([image('img_1', JPEG_URL)], { signal: controller.signal }),
    ).rejects.toThrow('stopped');
  });

  describe('a deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A CDN that never answers, and ignores the abort too. */
    const stalled = () => transport.mockImplementation(() => new Promise<Response>(() => {}));

    it('drops what is not downloaded by then, without failing', async () => {
      vi.useFakeTimers();
      stalled();
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new Error('out of time')), 60_000);
      const links = Array.from({ length: 6 }, (_, index) => image(`img_${index + 1}`, JPEG_URL));
      const inline = image('img_7', 'data:image/png;base64,AA');

      const result = inlineRemoteImages([...links, inline], {
        deadline: deadline.signal,
        concurrency: 2,
        perImageTimeoutMs: 10 * 60_000,
      });
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(result).resolves.toEqual({ images: [inline], skipped: 6 });
      // Two were running when it fired; the rest were never requested.
      expect(transport).toHaveBeenCalledTimes(2);
    });

    it('still fails with the caller abort', async () => {
      stalled();
      const caller = new AbortController();
      const deadline = new AbortController();

      const result = inlineRemoteImages([image('img_1', JPEG_URL)], {
        signal: caller.signal,
        deadline: deadline.signal,
      });
      await vi.waitFor(() => expect(transport).toHaveBeenCalled());
      caller.abort(new Error('run stopped'));

      await expect(result).rejects.toThrow('run stopped');
    });
  });

  describe('the byte budget', () => {
    const png = () =>
      new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    const links = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        image(`img_${index + 1}`, `https://files.example.com/${index + 1}`),
      );

    it('makes no request at all when it is empty', async () => {
      const result = await inlineRemoteImages(links(3), { maxTotalBytes: 0 });

      expect(result).toEqual({ images: [], skipped: 3 });
      expect(transport).not.toHaveBeenCalled();
    });

    it('once spent, requests nothing more and stops a stalled download', async () => {
      transport.mockImplementation(async (url) =>
        String(url).endsWith('/1') ? png() : new Promise<Response>(() => {}),
      );

      // Real timers: this resolves at once, not after the per-image timeout.
      const result = await inlineRemoteImages(links(4), {
        maxTotalBytes: PNG.byteLength,
        concurrency: 2,
      });

      expect(result.images.map((entry) => entry.id)).toEqual(['img_1']);
      expect(result.skipped).toBe(3);
      expect(transport.mock.calls.map(([url]) => url)).toEqual([
        'https://files.example.com/1',
        'https://files.example.com/2',
      ]);
    });

    it('once spent by the last download, stops one still running', async () => {
      transport.mockImplementation(async (url) =>
        String(url).endsWith('/1') ? png() : new Promise<Response>(() => {}),
      );

      const result = await inlineRemoteImages(links(2), {
        maxTotalBytes: PNG.byteLength,
        concurrency: 2,
      });

      expect(result.images.map((entry) => entry.id)).toEqual(['img_1']);
      expect(result.skipped).toBe(1);
    });

    it('once an image does not fit in what is left, stops the rest too', async () => {
      transport.mockImplementation(async (url) =>
        String(url).endsWith('/1')
          ? new Response(new Uint8Array(64), {
              headers: { 'content-type': 'image/png', 'content-length': '64' },
            })
          : new Promise<Response>(() => {}),
      );

      const result = await inlineRemoteImages(links(4), { maxTotalBytes: 32, concurrency: 2 });

      expect(result).toEqual({ images: [], skipped: 4 });
      expect(transport).toHaveBeenCalledTimes(2);
    });
  });

  it('gives up on one stalled download after its timeout and goes on', async () => {
    vi.useFakeTimers();
    try {
      transport.mockImplementation(async (url) =>
        url === JPEG_URL
          ? new Promise<Response>(() => {})
          : new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
      );

      const result = inlineRemoteImages([image('img_1', JPEG_URL), image('img_2', PNG_URL)], {
        concurrency: 1,
      });
      await vi.advanceTimersByTimeAsync(30_000);

      const settled = await result;
      expect(settled.images.map((entry) => entry.id)).toEqual(['img_2']);
      expect(settled.skipped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('downloads a URL an earlier parser wrapped as base64, never decoding it', async () => {
    transport.mockImplementation(
      async () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } }),
    );

    const result = await inlineRemoteImages([image('img_1', `data:image/png;base64,${PNG_URL}`)]);

    expect(result.skipped).toBe(0);
    expect(result.images[0]!.src).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(transport).toHaveBeenCalledWith(PNG_URL, expect.anything(), expect.anything());
  });

  it('classifies sources', () => {
    expect(remoteImageUrl('https://a/b')).toBe('https://a/b');
    expect(remoteImageUrl('HTTP://a/b')).toBe('HTTP://a/b');
    expect(remoteImageUrl('data:image/png;base64,https://a/b')).toBe('https://a/b');
    expect(remoteImageUrl('data:image/png;base64,AA')).toBeUndefined();
    expect(remoteImageUrl('')).toBeUndefined();
    expect(imagesAreInline([{ src: 'data:x' }, { src: '' }])).toBe(false);
    expect(imagesAreInline([{ src: 'data:image/png;base64,https://a/b' }])).toBe(false);
    expect(imagesAreInline([{ src: 'data:image/png;base64,AA' }])).toBe(true);
    expect(imagesAreInline([])).toBe(true);
  });
});
