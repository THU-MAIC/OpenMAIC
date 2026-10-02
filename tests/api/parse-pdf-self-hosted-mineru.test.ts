/**
 * Self-hosted MinerU parsing runs through the strict provider transport.
 *
 * These tests drive the real `/api/parse-pdf` route, the real document
 * extraction boundary, the real SSRF guard and the real pinned transport
 * against loopback HTTP servers. Only three things are stubbed:
 *
 *  - `@/lib/server/provider-config`, so each test chooses whether the provider
 *    is server-managed and what the server resolves for its key/base URL;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding); and
 *  - the global `fetch`, replaced with a spy that must never be called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/parse-pdf/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CONNECTION_FAILED = {
  status: 500,
  json: {
    success: false,
    errorCode: 'PARSE_FAILED',
    error: 'Cannot connect to the self-hosted MinerU server, please check the Base URL',
  },
};

const MINERU_OK = JSON.stringify({
  results: { 'doc.pdf': { md_content: '# Parsed heading', images: {}, content_list: [] } },
});

async function postParsePdf(fields: Record<string, string>) {
  const form = new FormData();
  form.append('pdf', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf'));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new Request('http://localhost/api/parse-pdf', { method: 'POST', body: form });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/parse-pdf with self-hosted MinerU', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;

    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation((_id: string, key?: string) => key);
    mocks.resolvePDFBaseUrl.mockImplementation((_id: string, baseUrl?: string) => baseUrl);
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  describe('with the operator local-network opt-in', () => {
    beforeEach(() => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
    });

    it('parses through the pinned transport and uploads the multipart body intact', async () => {
      const mineru = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(MINERU_OK);
      });

      const res = await postParsePdf({ providerId: 'mineru', baseUrl: mineru.origin });

      expect(res.status).toBe(200);
      expect(res.json.data.text).toContain('Parsed heading');
      expect(mineru.lastUrl()).toBe('/file_parse');
      expect(mineru.lastHeaders()!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
      expect(mineru.lastBody()!.toString('latin1')).toContain('filename="doc.pdf"');
    });

    it('does not echo an error body and keeps only the status', async () => {
      const mineru = await startLoopback((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal-secret-body');
      });

      const res = await postParsePdf({ providerId: 'mineru', baseUrl: mineru.origin });

      expect(res).toEqual({
        status: 500,
        json: { success: false, errorCode: 'PARSE_FAILED', error: 'MinerU API error (500)' },
      });
    });

    it('keeps the missing-dependency classification without quoting the body', async () => {
      const mineru = await startLoopback((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end("ModuleNotFoundError: No module named 'mineru.backend.pipeline' secret-path");
      });

      const res = await postParsePdf({ providerId: 'mineru', baseUrl: mineru.origin });

      expect(res.status).toBe(500);
      expect(res.json.error).toMatch(/pipeline\/core dependencies are not installed/);
      expect(res.json.error).not.toContain('secret-path');
    });

    it('does not surface a JSON parser snippet for a non-JSON success body', async () => {
      const mineru = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>internal-secret-page</html>');
      });

      const res = await postParsePdf({ providerId: 'mineru', baseUrl: mineru.origin });

      expect(res).toEqual({
        status: 500,
        json: {
          success: false,
          errorCode: 'PARSE_FAILED',
          error: 'The self-hosted MinerU server returned an invalid response',
        },
      });
    });

    it('refuses a redirect and never follows it', async () => {
      const target = await startLoopback();
      const origin = await startLoopback((_req, res) => {
        res.writeHead(307, { Location: `${target.origin}/sink` });
        res.end();
      });

      const res = await postParsePdf({ providerId: 'mineru', baseUrl: origin.origin });

      expect(res).toEqual(CONNECTION_FAILED);
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    });
  });

  it('refuses a host that rebinds to loopback between validation and connect', async () => {
    const trap = await startLoopback();

    const res = await postParsePdf({
      providerId: 'mineru',
      apiKey: 'client-key',
      baseUrl: `http://rebind.test:${trap.port}`,
    });

    expect(mocks.promisesLookup).toHaveBeenCalled();
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
    expect(res).toEqual(CONNECTION_FAILED);
    expect(trap.requests()).toBe(0);
  });

  it('ignores the client base URL for a server-managed provider', async () => {
    // No opt-in: a server-managed base URL is operator configuration and may
    // point at a local network.
    const managed = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MINERU_OK);
    });
    const clientTarget = await startLoopback();
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFBaseUrl.mockImplementation((_id: string, baseUrl?: string) =>
      baseUrl === undefined ? managed.origin : baseUrl,
    );

    const res = await postParsePdf({ providerId: 'mineru', baseUrl: clientTarget.origin });

    expect(res.status).toBe(200);
    expect(managed.requests()).toBe(1);
    expect(clientTarget.requests()).toBe(0);
  });

  it('still refuses cloud metadata as a server-managed base URL', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFBaseUrl.mockReturnValue('http://169.254.169.254/latest');

    const res = await postParsePdf({ providerId: 'mineru' });

    expect(res).toEqual(CONNECTION_FAILED);
  });

  it('refuses a client-supplied loopback base URL without the opt-in', async () => {
    const mineru = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MINERU_OK);
    });

    const res = await postParsePdf({ providerId: 'mineru', baseUrl: mineru.origin });

    expect(res.status).toBe(403);
    expect(res.json.errorCode).toBe('INVALID_URL');
    expect(mineru.requests()).toBe(0);
  });

  it.each(['mineru', 'mineru-cloud'])(
    'refuses a client %s base URL with a query or fragment before any request',
    async (providerId) => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
      const internal = await startLoopback();

      const res = await postParsePdf({
        providerId,
        apiKey: 'client-key',
        baseUrl: `${internal.origin}/internal#`,
      });

      expect(res.status).toBe(403);
      expect(res.json.error).toBe('Base URL must not contain a query string or fragment');
      expect(internal.requests()).toBe(0);
    },
  );

  it('parses locally when the request asks for it, whatever service the slot names', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const mineru = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MINERU_OK);
    });
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { mu: { preset: 'mineru', baseUrl: mineru.origin } },
          slots: { document: 'mu' },
        },
      },
      defaults: null,
      notices: [],
    });
    try {
      await postParsePdf({ providerId: 'unpdf', apiKey: 'client-key' });
      expect(mineru.requests()).toBe(0);
      // Without the choice the slot's service parses it.
      expect((await postParsePdf({})).status).toBe(200);
      expect(mineru.requests()).toBe(1);
    } finally {
      runtime.setDeploymentConfigForTests();
    }
  });
});
