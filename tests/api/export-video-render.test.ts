import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { POST } from '@/app/api/export-video/render/route';

function request(headers?: HeadersInit) {
  const form = new FormData();
  form.set('project', new Blob(['project fixture']), 'project.zip');
  return new NextRequest('http://localhost/api/export-video/render', {
    method: 'POST',
    body: form,
    headers,
  });
}

describe('POST /api/export-video/render', () => {
  beforeEach(() => {
    mocks.proxyFetch.mockReset();
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false');
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(['queue_full', 'per_identity_limit', 'future_limit'])(
    'preserves the 429 envelope and %s reason without interpreting prose',
    async (reason) => {
      mocks.proxyFetch.mockResolvedValueOnce(
        Response.json({ error: 'Service diagnostic', reason }, { status: 429 }),
      );
      const response = await POST(request());
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        success: false,
        errorCode: 'RATE_LIMITED',
        error: 'Render service rejected the request',
        details: 'Service diagnostic',
        reason,
      });
    },
  );

  it.each([undefined, null, 123, { code: 'queue_full' }])(
    'omits missing or non-string admission reasons (%j)',
    async (reason) => {
      mocks.proxyFetch.mockResolvedValueOnce(
        Response.json({ error: 'Queue busy', reason }, { status: 429 }),
      );
      const response = await POST(request());
      expect(response.status).toBe(429);
      expect(await response.json()).not.toHaveProperty('reason');
    },
  );

  it.each([
    [413, 413, 'INVALID_REQUEST'],
    [400, 502, 'UPSTREAM_ERROR'],
    [500, 502, 'UPSTREAM_ERROR'],
  ])(
    'keeps upstream %i mapping to %i without an admission reason',
    async (upstream, status, code) => {
      mocks.proxyFetch.mockResolvedValueOnce(
        Response.json({ error: 'Diagnostic', reason: 'queue_full' }, { status: upstream }),
      );
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        success: false,
        errorCode: code,
        error: 'Render service rejected the request',
        details: 'Diagnostic',
      });
    },
  );

  it('preserves a reason-less failure when the upstream body is not JSON', async () => {
    mocks.proxyFetch.mockResolvedValueOnce(
      new Response('gateway response', { status: 502, statusText: 'Bad Gateway' }),
    );
    const response = await POST(request());
    expect(await response.json()).toMatchObject({
      errorCode: 'UPSTREAM_ERROR',
      details: 'Bad Gateway',
    });
  });

  it('rejects declared oversize before contacting the service', async () => {
    const response = await POST(request({ 'content-length': String(300 * 1024 * 1024 + 1) }));
    expect(response.status).toBe(413);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('keeps a streaming upload cap failure as 413, not a transport failure', async () => {
    // Reuse one chunk; exercise the real byte counter without buffering a large archive.
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({ pull: (controller) => controller.enqueue(chunk) });
    mocks.proxyFetch.mockImplementationOnce(async (_url, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      while (!(await reader.read()).done) {
        /* drain the upload */
      }
      return Response.json({ jobId: 'unexpected' });
    });
    const response = await POST(
      new NextRequest('http://localhost/api/export-video/render', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
        body,
        duplex: 'half',
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'Export archive is too large' });
  });

  it('returns 501 when unconfigured and 502 when the configured service cannot be reached', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');
    expect((await POST(request())).status).toBe(501);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();

    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    mocks.proxyFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: 'Failed to reach render service',
      details: 'fetch failed',
    });
  });

  it('keeps accepted submissions and the default shared identity unchanged', async () => {
    mocks.proxyFetch.mockResolvedValueOnce(Response.json({ jobId: 'job-1' }, { status: 202 }));
    const response = await POST(request({ 'x-forwarded-for': '203.0.113.1' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, jobId: 'job-1', pollIntervalMs: 3000 });
    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      'http://render-service:9000/render',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-openmaic-client': 'direct' }),
      }),
    );
  });
});
