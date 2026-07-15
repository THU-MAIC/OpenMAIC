import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// sharp isn't needed — overflow/allowlist rejections return before any decode.
vi.mock('sharp', () => ({
  default: () => ({ png: () => ({ toBuffer: async () => Buffer.from([]) }) }),
}));

import { fetchAliDocMindImageAsBase64 } from '@/lib/pdf/pdf-providers';

const OSS = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/img.png?sig=x';
const realFetch = global.fetch;

/** Build a Response whose body streams `chunks` and omits Content-Length. */
function streamingResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  // No content-length header — forces the cumulative streaming check.
  return new Response(stream, { status: 200, headers: {} });
}

describe('fetchAliDocMindImageAsBase64', () => {
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('rejects a non-OSS host without fetching (SSRF allowlist)', async () => {
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;
    const result = await fetchAliDocMindImageAsBase64('https://169.254.169.254/latest/meta-data');
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('aborts and rejects an oversized stream with no Content-Length', async () => {
    // 12 x 1MiB chunks = 12 MiB > 10 MiB cap, streamed with no content-length.
    const oneMiB = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 12 }, () => oneMiB);
    global.fetch = vi.fn(async () => streamingResponse(chunks)) as unknown as typeof fetch;
    const result = await fetchAliDocMindImageAsBase64(OSS);
    expect(result).toBeNull(); // aborted before buffering the whole body
  });

  it('rejects a declared oversized Content-Length up front', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': String(20 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const result = await fetchAliDocMindImageAsBase64(OSS);
    expect(result).toBeNull();
  });
});
