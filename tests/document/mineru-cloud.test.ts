/**
 * MinerU Cloud request hardening, driven through a controllable transport.
 *
 * `parseWithMinerUCloud` now routes every request through the strict provider
 * transport (`providerFetch`) and validates the response-supplied presigned
 * upload / result-ZIP URLs before use. These tests stub that transport so they
 * can assert:
 *
 *  - the address policy passed for the config-derived API root (always the
 *    operator policy, so ALLOW_LOCAL_NETWORKS applies) and for the
 *    response-supplied URLs (always strict public);
 *  - that a response URL pointing at a private/metadata address, or using a
 *    non-HTTPS scheme, is refused before the transport is ever called;
 *  - that an address-policy refusal is not retried; and
 *  - the read caps on JSON and ZIP responses.
 *
 * Real-transport behavior (pinned DNS, redirect-hop validation, body bytes on
 * the wire) is covered in `mineru-cloud-transport.test.ts`.
 */
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ providerFetch: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Keep every other export of the audio transport real (notably
// `resolveAllowLocalNetworks`) and only replace the request function, which is
// what `providerFetch` re-exports.
vi.mock('@/lib/server/audio-provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-provider-fetch')>();
  return { ...actual, audioProviderFetch: transport.providerFetch };
});

import {
  parseWithMinerUCloud,
  MAX_JSON_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_TEXT_ENTRY_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from '@/lib/pdf/mineru-cloud';
import { resolveAllowLocalNetworks } from '@/lib/server/provider-fetch';

const PUBLIC_UPLOAD = 'https://93.184.216.34/upload/lesson.pdf';
const PUBLIC_ZIP = 'https://93.184.216.34/result.zip';

type TransportCall = [string | URL, RequestInit | undefined, { allowLocalNetworks?: boolean }];

function calls(): TransportCall[] {
  return transport.providerFetch.mock.calls as unknown as TransportCall[];
}

function callUrls(): string[] {
  return calls().map(([input]) => String(input));
}

function policyFor(substring: string): { allowLocalNetworks?: boolean } | undefined {
  const call = calls().find(([input]) => String(input).includes(substring));
  return call?.[2];
}

async function makeZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface MinerUResponses {
  uploadUrl?: string;
  zipUrl?: string;
  zipBody?: Buffer | Response;
  /** Reply for the ZIP request instead of the default successful body. */
  onZip?: () => Response;
}

/**
 * Install a transport that answers the MinerU v4 control plane and, by default,
 * a valid upload + ZIP download. Individual tests override one URL or reply.
 */
function installMinerU(overrides: MinerUResponses = {}) {
  const uploadUrl = overrides.uploadUrl ?? PUBLIC_UPLOAD;
  const zipUrl = overrides.zipUrl ?? PUBLIC_ZIP;
  return transport.providerFetch.mockImplementation(
    async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        return new Response(
          JSON.stringify({ code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: [uploadUrl] } }),
          { status: 200 },
        );
      }
      if (url === uploadUrl) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/extract-results/batch/b1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              extract_result: { file_name: 'lesson.pdf', state: 'done', full_zip_url: zipUrl },
            },
          }),
          { status: 200 },
        );
      }
      if (url === zipUrl) {
        if (overrides.onZip) return overrides.onZip();
        const provided = overrides.zipBody;
        if (provided instanceof Response) return provided;
        const zipBody = provided ?? (await makeZip({ 'full.md': '# Hardened lesson' }));
        return new Response(new Uint8Array(zipBody), { status: 200 });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    },
  );
}

/** A response whose body streams a single oversized chunk without allocating it. */
function oversizedStreamResponse(byteLength: number, headers?: HeadersInit): Response {
  const fakeChunk = { byteLength } as unknown as Uint8Array;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(fakeChunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

/**
 * Rewrite the first central-directory entry's declared uncompressed size so the
 * declared-size budget can be exercised without building a huge archive. JSZip
 * reads that field from the central directory when loading.
 */
function patchFirstEntryDeclaredSize(zipBuf: Buffer, declared: number): Buffer {
  const patched = Buffer.from(zipBuf);
  const central = patched.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (central < 0) throw new Error('central directory not found');
  patched.writeUInt32LE(declared, central + 24);
  return patched;
}

/**
 * Build a single-entry DEFLATE ZIP by hand so both the local header and the
 * central directory can declare an uncompressed size unrelated to the real
 * raw-deflate payload. JSZip reads the declared size from the central
 * directory and only detects the lie once the entry is fully decompressed; the
 * streaming reader is meant to stop before that point.
 */
function makeSingleEntryZip(
  name: string,
  rawDeflated: Buffer,
  declaredUncompressedSize: number,
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressedSize = rawDeflated.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // general purpose flags
  local.writeUInt16LE(8, 8); // compression method: DEFLATE
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(0, 14); // crc32 (loadAsync does not verify by default)
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(declaredUncompressedSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // general purpose flags
  central.writeUInt16LE(8, 10); // compression method: DEFLATE
  central.writeUInt16LE(0, 12); // mod time
  central.writeUInt16LE(0, 14); // mod date
  central.writeUInt32LE(0, 16); // crc32
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(declaredUncompressedSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra field length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(0, 42); // local header offset

  const localPart = Buffer.concat([local, nameBuf, rawDeflated]);
  const centralPart = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // total entries
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralPart, end]);
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('parseWithMinerUCloud — transport policy and response URL validation', () => {
  afterEach(() => {
    transport.providerFetch.mockReset();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
  });

  it('uploads the exact document bytes and parses the result ZIP', async () => {
    const zip = await makeZip({ 'full.md': '# Parsed lesson', 'content_list.json': '[]' });
    let uploaded: Buffer | undefined;
    let uploadInit: RequestInit | undefined;
    transport.providerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: { batch_id: 'b1', file_urls: [PUBLIC_UPLOAD] },
          }),
          { status: 200 },
        );
      }
      if (url === PUBLIC_UPLOAD) {
        uploadInit = init;
        uploaded = Buffer.from(await (init!.body as Blob).arrayBuffer());
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/extract-results/batch/b1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              extract_result: { file_name: 'lesson.pdf', state: 'done', full_zip_url: PUBLIC_ZIP },
            },
          }),
          { status: 200 },
        );
      }
      if (url === PUBLIC_ZIP) return new Response(new Uint8Array(zip), { status: 200 });
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const documentBuffer = Buffer.from('exact document bytes \u0000\u0001', 'latin1');
    const result = await parseWithMinerUCloud(
      {
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        baseUrl: 'https://mineru.example/api/v4',
      },
      documentBuffer,
      'lesson.pdf',
    );

    expect(result.text).toContain('Parsed lesson');
    expect(result.metadata?.parser).toBe('mineru-cloud');
    expect(uploaded?.equals(documentBuffer)).toBe(true);
    // Unchanged upload shape: PUT, no Content-Type header (presigned URLs are
    // header-sensitive), a Blob body and a timeout signal.
    expect(uploadInit?.method).toBe('PUT');
    expect(new Headers(uploadInit?.headers).has('content-type')).toBe(false);
    expect(uploadInit?.body).toBeInstanceOf(Blob);
    expect(uploadInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a client-supplied local API root on the operator policy while response URLs stay strict', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    installMinerU();
    await parseWithMinerUCloud(
      {
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        // A self-hoster's local MinerU service: reachable under the operator
        // opt-in, unlike the response-supplied URLs asserted below.
        baseUrl: 'http://127.0.0.1:8000/api/v4',
      },
      Buffer.from('bytes'),
      'lesson.pdf',
    );

    const firstHop = policyFor('/file-urls/batch');
    expect(firstHop).toBeDefined();
    // `allowLocalNetworks` is present but explicitly `undefined`, so the
    // transport falls back to the operator opt-in (enabled here) rather than
    // forcing the strict public policy.
    expect('allowLocalNetworks' in firstHop!).toBe(true);
    expect(resolveAllowLocalNetworks(firstHop!.allowLocalNetworks)).toBe(true);
    expect(
      resolveAllowLocalNetworks(policyFor('/extract-results/batch/b1')?.allowLocalNetworks),
    ).toBe(true);
    // Response-supplied URLs never inherit the opt-in, and each carries its
    // own stricter transport mode: the upload rejects every redirect, the ZIP
    // requires HTTPS on every hop.
    expect(policyFor(PUBLIC_UPLOAD)).toMatchObject({
      allowLocalNetworks: false,
      rejectRedirects: true,
    });
    expect(policyFor(PUBLIC_ZIP)).toMatchObject({
      allowLocalNetworks: false,
      requireHttps: true,
    });
  });

  it('still refuses a private response-supplied ZIP URL with ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const zipUrl = 'https://127.0.0.1/result.zip';
    installMinerU({ zipUrl });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'http://127.0.0.1:8000/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/not allowed/);

    // batch + upload + poll, but never the refused private ZIP URL.
    expect(callUrls()).not.toContain(zipUrl);
    expect(callUrls()).toHaveLength(3);
  });
});

describe('parseWithMinerUCloud — response-supplied URL rejection', () => {
  afterEach(() => {
    transport.providerFetch.mockReset();
  });

  const privateUrls: Array<[string, string]> = [
    ['loopback', 'https://127.0.0.1/result.zip'],
    ['RFC1918', 'https://10.0.0.5/result.zip'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['cloud metadata (Aliyun)', 'https://100.100.100.200/result.zip'],
  ];

  it.each(privateUrls)(
    'refuses a response-supplied ZIP URL on a %s address and does not fetch it',
    async (_label, zipUrl) => {
      installMinerU({ zipUrl });

      await expect(
        parseWithMinerUCloud(
          {
            providerId: 'mineru-cloud',
            apiKey: 'cloud-key',
            baseUrl: 'https://mineru.example/api/v4',
          },
          Buffer.from('bytes'),
          'lesson.pdf',
        ),
      ).rejects.toThrow(/(not|never) allowed/);

      // batch + upload + poll, but never the refused ZIP URL.
      expect(callUrls()).not.toContain(zipUrl);
      expect(callUrls()).toHaveLength(3);
    },
  );

  it('refuses a response-supplied upload URL on a private address and does not fetch it', async () => {
    const uploadUrl = 'https://10.1.2.3/upload/lesson.pdf';
    installMinerU({ uploadUrl });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/(not|never) allowed/);

    // Only the batch request; the refused upload URL is never requested.
    expect(callUrls()).toEqual([expect.stringContaining('/file-urls/batch')]);
  });

  it('refuses a non-HTTPS response-supplied URL', async () => {
    installMinerU({ zipUrl: 'http://93.184.216.34/result.zip' });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/must use https/);

    expect(callUrls()).not.toContain('http://93.184.216.34/result.zip');
  });

  it('does not retry an address-policy refusal from the transport', async () => {
    const { UnsafeNetworkTargetError } = await import('@/lib/server/ssrf-guard');
    installMinerU();
    transport.providerFetch.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: { batch_id: 'b1', file_urls: [PUBLIC_UPLOAD] },
          }),
          { status: 200 },
        );
      }
      if (url === PUBLIC_UPLOAD) {
        // Undici surfaces a connect-time refusal as `TypeError: fetch failed`
        // with the policy error as `cause`. The retry wrapper must look through
        // the wrapper rather than retry the transport-shaped message.
        const wrapped = new TypeError('fetch failed');
        (wrapped as { cause?: unknown }).cause = new UnsafeNetworkTargetError(
          'Local/private/reserved network URLs are not allowed',
        );
        throw wrapped;
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toBeInstanceOf(UnsafeNetworkTargetError);

    // Exactly one attempt at the upload: a policy refusal is terminal even when
    // its wrapper message would otherwise look retryable.
    expect(callUrls().filter((url) => url === PUBLIC_UPLOAD)).toHaveLength(1);
  });

  it('surfaces a refused result ZIP URL as an UnsafeNetworkTargetError', async () => {
    const { UnsafeNetworkTargetError } = await import('@/lib/server/ssrf-guard');
    installMinerU({
      onZip: () => {
        // Undici surfaces a connect-time refusal as `TypeError: fetch failed`
        // with the policy error as `cause`; the retry wrapper must rethrow the
        // original typed refusal instead of wrapping it in a message string.
        const wrapped = new TypeError('fetch failed');
        (wrapped as { cause?: unknown }).cause = new UnsafeNetworkTargetError(
          'Local/private/reserved network URLs are not allowed',
        );
        throw wrapped;
      },
    });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toBeInstanceOf(UnsafeNetworkTargetError);

    // The refusal is terminal: the ZIP URL is requested exactly once.
    expect(callUrls().filter((url) => url === PUBLIC_ZIP)).toHaveLength(1);
  });

  it('does not retry a rejected redirect on the presigned upload', async () => {
    installMinerU();
    let uploadAttempts = 0;
    transport.providerFetch.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: { batch_id: 'b1', file_urls: [PUBLIC_UPLOAD] },
          }),
          { status: 200 },
        );
      }
      if (url === PUBLIC_UPLOAD) {
        uploadAttempts += 1;
        // Undici's `redirect: 'error'` reports a 3xx this way; it must be
        // terminal even though the wrapper message looks transport-shaped.
        const wrapped = new TypeError('fetch failed');
        (wrapped as { cause?: unknown }).cause = new Error('unexpected redirect');
        throw wrapped;
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/presigned upload failed/);

    expect(uploadAttempts).toBe(1);
  });
});

describe('parseWithMinerUCloud — bounded reads', () => {
  afterEach(() => {
    transport.providerFetch.mockReset();
  });

  async function runWithZipResponse(zipResponse: Response): Promise<PromiseSettledResult<unknown>> {
    installMinerU({ onZip: () => zipResponse });
    return parseWithMinerUCloud(
      { providerId: 'mineru-cloud', apiKey: 'cloud-key', baseUrl: 'https://mineru.example/api/v4' },
      Buffer.from('bytes'),
      'lesson.pdf',
    ).then(
      (value) => ({ status: 'fulfilled', value }) as PromiseFulfilledResult<unknown>,
      (reason) => ({ status: 'rejected', reason }) as PromiseRejectedResult,
    );
  }

  it('rejects a ZIP whose declared content-length exceeds the cap', async () => {
    const result = await runWithZipResponse(
      oversizedStreamResponse(0, { 'content-length': String(MAX_ZIP_BYTES + 1) }),
    );
    expect(result.status).toBe('rejected');
    expect(String((result as PromiseRejectedResult).reason)).toContain('exceeds');
  });

  it('rejects a streamed ZIP that exceeds the cap without a content-length', async () => {
    const result = await runWithZipResponse(oversizedStreamResponse(MAX_ZIP_BYTES + 1));
    expect(result.status).toBe('rejected');
    expect(String((result as PromiseRejectedResult).reason)).toContain('exceeds');
  });

  it('rejects a ZIP whose full.md expands beyond the per-entry text limit', async () => {
    // A small, compressed archive whose single entry expands beyond the cap;
    // the declared total is under the archive budget, so the extracted length
    // is what has to reject it.
    const zip = new JSZip();
    zip.file('full.md', 'a'.repeat(MAX_ZIP_TEXT_ENTRY_BYTES + 1));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(zipBuf.length).toBeLessThan(MAX_ZIP_BYTES);

    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));

    expect(result.status).toBe('rejected');
    expect(String((result as PromiseRejectedResult).reason)).toContain('text limit');
  });

  it('stops streaming a lying full.md before JSZip would report its size mismatch', async () => {
    // The raw-deflate stream expands to 256 MiB (four times the text cap) but
    // both headers declare 10 bytes. Streaming extraction must trip the
    // per-entry cap while decompressing; buffering the entry first would only
    // fail at the very end with JSZip's "uncompressed data size mismatch".
    const expansionBytes = MAX_ZIP_UNCOMPRESSED_BYTES / 2; // 256 MiB
    const rawDeflated = zlib.deflateRawSync(Buffer.alloc(expansionBytes, 0x61), { level: 6 });
    const zipBuf = makeSingleEntryZip('full.md', rawDeflated, 10);
    expect(zipBuf.length).toBeLessThan(MAX_ZIP_BYTES);

    const startedAt = Date.now();
    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe('rejected');
    const message = String((result as PromiseRejectedResult).reason);
    expect(message).toContain('text limit');
    expect(message).not.toContain('mismatch');
    // Prompt rejection is what shows the cap was enforced during decompression
    // rather than after the whole 256 MiB entry had been materialized.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('rejects a small lying entry (declared 10 bytes, actual 1 KiB)', async () => {
    const rawDeflated = zlib.deflateRawSync(Buffer.alloc(1024, 0x62), { level: 6 });
    const zipBuf = makeSingleEntryZip('full.md', rawDeflated, 10);

    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));

    expect(result.status).toBe('rejected');
    // Under the per-entry cap, so JSZip's own end-of-entry probe (or a limit
    // check) is the error.
    expect(String((result as PromiseRejectedResult).reason)).toMatch(/mismatch|limit/i);
  });

  it('rejects a ZIP with more entries than the entry-count limit', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_ZIP_ENTRY_COUNT + 1; i++) files[`images/${i}.txt`] = '';
    const zipBuf = await makeZip(files);

    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));

    expect(result.status).toBe('rejected');
    expect(String((result as PromiseRejectedResult).reason)).toContain('entry limit');
  });

  it('rejects a ZIP whose declared uncompressed total exceeds the archive budget', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# lesson');
    const zipBuf = patchFirstEntryDeclaredSize(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
      MAX_ZIP_UNCOMPRESSED_BYTES + 1,
    );

    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));

    expect(result.status).toBe('rejected');
    expect(String((result as PromiseRejectedResult).reason)).toContain(
      'declared uncompressed size',
    );
  });

  it('still parses a normal ZIP with text, a content list and an image', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# Normal lesson');
    zip.file('content_list.json', JSON.stringify([{ type: 'image', img_path: 'images/a.png' }]));
    zip.file('images/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await runWithZipResponse(new Response(new Uint8Array(zipBuf), { status: 200 }));

    expect(result.status).toBe('fulfilled');
    expect((result as PromiseFulfilledResult<{ text: string }>).value.text).toContain(
      'Normal lesson',
    );
  });

  it('rejects an oversized JSON control-plane response', async () => {
    const hugeBody = 'x'.repeat(MAX_JSON_BYTES + 1);
    transport.providerFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: hugeBody, data: {} }), { status: 200 }),
    );

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: 'https://mineru.example/api/v4',
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/exceeds/);
  });
});
