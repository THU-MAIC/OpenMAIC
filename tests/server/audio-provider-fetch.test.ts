/**
 * Live regression tests for the strict audio-provider transport.
 *
 * `audioProviderFetch` is the one helper every `lib/audio` provider request now
 * goes through. These tests drive real loopback HTTP servers so both halves of
 * the protection are exercised end to end:
 *
 *  - a `302` answer to a loopback/metadata address is re-validated at the URL
 *    layer and never followed; and
 *  - a hostname whose DNS answer changes between the URL-layer guard and the
 *    connect-time lookup (rebinding) is refused by the pinned dispatcher before
 *    a socket reaches the private address.
 *
 * The transport is undici's own `fetch` with an undici Agent, so a dispatcher
 * that the transport silently ignored would let the rebinding test reach the
 * internal server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audioProviderFetch,
  destroyAudioProviderDispatchersForTests,
} from '@/lib/server/audio-provider-fetch';
import { validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';

const dnsMocks = vi.hoisted(() => ({
  // Used by the URL-layer guard (`node:dns` promises API).
  promisesLookup: vi.fn(),
  // Used by the pinned dispatcher's connect-time lookup (callback API).
  callbackLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => dnsMocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: dnsMocks.promisesLookup },
  };
});

type Answer = { address: string; family: number };

const PUBLIC: Answer[] = [{ address: '93.184.216.34', family: 4 }];
const LOOPBACK: Answer[] = [{ address: '127.0.0.1', family: 4 }];

const PRIVATE_BLOCK_MESSAGE = 'Local/private network URLs are not allowed';
const METADATA_BLOCK_MESSAGE = 'Cloud instance metadata endpoints are never allowed';

/** A callback-style `dns.lookup` stand-in that always returns `addresses`. */
function answerWith(addresses: Answer[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ): void => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  };
}

const servers: Server[] = [];

interface LoopbackServer {
  port: number;
  requests: () => number;
  lastHeaders: () => IncomingMessage['headers'] | undefined;
  lastBody: () => Buffer | undefined;
}

async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let headers: IncomingMessage['headers'] | undefined;
  let body: Buffer | undefined;
  const server = createServer((req, res) => {
    count += 1;
    headers = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length > 0) body = Buffer.concat(chunks);
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => count,
    lastHeaders: () => headers,
    lastBody: () => body,
  };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('audioProviderFetch — redirect + rebinding hardening', () => {
  beforeEach(() => {
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    destroyAudioProviderDispatchersForTests();
  });

  afterEach(async () => {
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    } else {
      process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    }
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('returns a normal 200 response and its body', async () => {
    const origin = await startLoopback();

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/audio/speech`,
      { method: 'POST', body: '{}' },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(origin.requests()).toBe(1);
  });

  it('refuses a 302 to a cloud metadata address and never follows it', async () => {
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    await expect(
      audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow(METADATA_BLOCK_MESSAGE);

    expect(origin.requests()).toBe(1);
  });

  it('refuses a 302 to a loopback address under the strict public policy', async () => {
    const internal = await startLoopback();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/secret` });
      res.end();
    });

    await expect(
      audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

    expect(origin.requests()).toBe(1);
    expect(internal.requests()).toBe(0);
  });

  it('follows a 302 to a loopback address when the operator policy allows local networks', async () => {
    const internal = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/final` });
      res.end();
    });

    const response = await audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
      allowLocalNetworks: true,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    expect(internal.requests()).toBe(1);
  });

  it('refuses a hostname that rebinds to loopback between guard and connect', async () => {
    const internal = await startLoopback();
    const url = `http://rebind.test:${internal.port}/secret`;

    // The URL-layer guard sees a public answer and passes...
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    await expect(
      validateUrlForSSRFWithPolicy(url, { allowLocalNetworks: false }),
    ).resolves.toBeNull();

    // ...but the connect-time lookup is offered loopback instead.
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    await expect(audioProviderFetch(url, undefined, { allowLocalNetworks: false })).rejects.toThrow(
      PRIVATE_BLOCK_MESSAGE,
    );

    // A transport that ignored the pinned dispatcher would have connected here.
    expect(internal.requests()).toBe(0);
    expect(dnsMocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('strips provider credential headers before a cross-origin redirect hop', async () => {
    const internal = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/final` });
      res.end();
    });

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/start`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          'Ocp-Apim-Subscription-Key': 'azure-secret',
          'xi-api-key': 'eleven-secret',
          'content-type': 'application/json',
        },
      },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    const headers = internal.lastHeaders()!;
    expect(headers.authorization).toBeUndefined();
    expect(headers['ocp-apim-subscription-key']).toBeUndefined();
    expect(headers['xi-api-key']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('audioProviderFetch — cross-copy body normalization', () => {
  beforeEach(() => {
    destroyAudioProviderDispatchersForTests();
  });

  afterEach(async () => {
    destroyAudioProviderDispatchersForTests();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('serializes a platform-global FormData as real multipart, not "[object FormData]"', async () => {
    const origin = await startLoopback();

    // Exactly the shapes lib/audio adapters build: platform-global FormData
    // and Blob, with the audio payload as a named file plus scalar fields.
    const wav = Buffer.concat([Buffer.from('RIFF0000WAVE', 'ascii'), Buffer.alloc(64, 0x07)]);
    const formData = new FormData();
    formData.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.set('model', 'qwen3-asr');
    formData.set('response_format', 'json');

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/v1/audio/transcriptions`,
      { method: 'POST', headers: { Authorization: 'Bearer sk-test' }, body: formData },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(origin.lastHeaders()!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = origin.lastBody()!;
    const text = body.toString('latin1');
    expect(text).toContain('name="file"; filename="audio.wav"');
    expect(text).toContain('name="model"');
    expect(text).toContain('qwen3-asr');
    expect(text).not.toContain('[object FormData]');
    // The audio bytes themselves ride along (the 64-byte 0x07 payload).
    expect(body.includes(Buffer.alloc(64, 0x07))).toBe(true);
  });

  it('serializes a bare platform-global Blob body as binary with its type', async () => {
    const origin = await startLoopback();
    const payload = Buffer.from('RIFFxxxxWAVEfake-audio-bytes');

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/v1/audio/transcriptions`,
      { method: 'POST', body: new Blob([payload], { type: 'audio/wav' }) },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(origin.lastHeaders()!['content-type']).toBe('audio/wav');
    expect(origin.lastBody()!.equals(payload)).toBe(true);
  });

  it('preserves repeated field names when rebuilding a foreign FormData', async () => {
    const origin = await startLoopback();

    // `append` semantics: two declarations under one name must both ride the
    // wire — a rebuild that used `set` would collapse them to the last value.
    const formData = new FormData();
    formData.append('channel', 'stable');
    formData.append('channel', 'beta');

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/v1/audio/transcriptions`,
      { method: 'POST', body: formData },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    const text = origin.lastBody()!.toString('latin1');
    expect(text.match(/name="channel"/g)).toHaveLength(2);
    expect(text).toContain('stable');
    expect(text).toContain('beta');
  });

  it('serializes an empty FormData as empty multipart, not "[object FormData]"', async () => {
    const origin = await startLoopback();

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/v1/audio/transcriptions`,
      { method: 'POST', body: new FormData() },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(origin.lastHeaders()!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = origin.lastBody()!.toString('latin1');
    expect(text).not.toContain('[object FormData]');
    // No fields were declared, so nothing but the boundary delimiters is sent.
    expect(text).not.toContain('name="');
  });

  it('replays a multipart body across a redirect hop as real multipart', async () => {
    const sink = await startLoopback();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${sink.port}/v1/audio/transcriptions` });
      res.end();
    });

    const wav = Buffer.concat([Buffer.from('RIFF0000WAVE', 'ascii'), Buffer.alloc(32, 0x07)]);
    const formData = new FormData();
    formData.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.set('model', 'qwen3-asr');

    // A 307 must preserve the method and body: the per-hop loop re-issues the
    // normalized init, so the rebuilt FormData has to survive re-serialization
    // on the second request just like the first.
    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/upload`,
      { method: 'POST', headers: { Authorization: 'Bearer sk-test' }, body: formData },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(origin.requests()).toBe(1);
    expect(sink.requests()).toBe(1);
    expect(sink.lastHeaders()!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = sink.lastBody()!;
    const text = body.toString('latin1');
    expect(text).toContain('name="file"; filename="audio.wav"');
    expect(text).toContain('qwen3-asr');
    expect(text).not.toContain('[object FormData]');
    expect(body.includes(Buffer.alloc(32, 0x07))).toBe(true);
  });
});
