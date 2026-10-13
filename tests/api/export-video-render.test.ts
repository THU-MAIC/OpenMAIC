import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
}));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { POST } from '@/app/api/export-video/render/route';
import { DELETE as CANCEL, GET as POLL } from '@/app/api/export-video/render/[jobId]/route';
import { GET as DOWNLOAD } from '@/app/api/export-video/render/[jobId]/download/route';

function request(headers?: HeadersInit) {
  const form = new FormData();
  form.set('project', new Blob(['project fixture']), 'project.zip');
  return new NextRequest('http://localhost/api/export-video/render', {
    method: 'POST',
    body: form,
    headers,
  });
}

function jobRequest(path: string, method = 'GET') {
  return new NextRequest(`http://localhost/api/export-video/render/${path}`, { method });
}

const context = { params: Promise.resolve({ jobId: 'job-1' }) };

function ownerBound(response: Response): Response {
  response.headers.set('x-openmaic-render-owner-bound', '1');
  return response;
}

function mockOwnerBoundResponse(response: Response): void {
  mocks.proxyFetch.mockResolvedValueOnce(ownerBound(response));
}

describe('POST /api/export-video/render', () => {
  beforeEach(() => {
    mocks.proxyFetch.mockReset();
    mocks.resolveRequestOwnerId.mockReset();
    mocks.resolveRequestOwnerId.mockReturnValue('owner-a');
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false');
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(['queue_full', 'per_identity_limit'])(
    'preserves the 429 envelope and %s reason without interpreting prose',
    async (reason) => {
      mockOwnerBoundResponse(
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

  it.each([undefined, null, 123, { code: 'queue_full' }, 'future_limit'])(
    'omits missing or unrecognized admission reasons (%j)',
    async (reason) => {
      mockOwnerBoundResponse(Response.json({ error: 'Queue busy', reason }, { status: 429 }));
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
      mockOwnerBoundResponse(
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
    mockOwnerBoundResponse(
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
      return ownerBound(Response.json({ jobId: 'unexpected' }));
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

  it('refuses submissions when an older service does not assert owner binding', async () => {
    mocks.proxyFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const response = await POST(request());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'UPSTREAM_ERROR',
      error: 'Render service must be upgraded before accepting jobs',
    });
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      'http://render-service:9000/owner-bound/render',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refuses an unmarked submit response without a health preflight', async () => {
    mocks.proxyFetch.mockResolvedValueOnce(Response.json({ jobId: 'unsafe-job' }, { status: 202 }));

    const response = await POST(request());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'UPSTREAM_ERROR',
      error: 'Render service must be upgraded before accepting jobs',
    });
  });

  it('forwards durable ownership separately from the default admission identity', async () => {
    mockOwnerBoundResponse(Response.json({ jobId: 'job-1' }, { status: 202 }));
    const response = await POST(request({ 'x-forwarded-for': '203.0.113.1' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, jobId: 'job-1', pollIntervalMs: 3000 });
    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      'http://render-service:9000/owner-bound/render',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-openmaic-client': 'direct',
          'x-openmaic-render-owner': 'owner-a',
        }),
      }),
    );
  });
});

describe('owner-scoped render job proxies', () => {
  beforeEach(() => {
    mocks.proxyFetch.mockReset();
    mocks.resolveRequestOwnerId.mockReset();
    mocks.resolveRequestOwnerId.mockReturnValue('owner-a');
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('forwards the durable owner on poll, cancel, and download', async () => {
    mockOwnerBoundResponse(Response.json({ jobId: 'job-1', status: 'running' }));
    mockOwnerBoundResponse(Response.json({ cancelled: true }));
    mockOwnerBoundResponse(
      new Response('video', {
        headers: { 'content-type': 'video/mp4', 'content-length': '5' },
      }),
    );

    expect((await POLL(jobRequest('job-1'), context)).status).toBe(200);
    expect((await CANCEL(jobRequest('job-1', 'DELETE'), context)).status).toBe(200);
    expect((await DOWNLOAD(jobRequest('job-1/download'), context)).status).toBe(200);

    const jobCalls = mocks.proxyFetch.mock.calls;
    expect(jobCalls).toHaveLength(3);
    for (const [url, init] of jobCalls) {
      expect(url).toMatch(/^http:\/\/render-service:9000\/owner-bound\/render\/job-1/);
      expect(init).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-openmaic-render-owner': 'owner-a' }),
        }),
      );
    }
  });

  it('refuses an older service namespace 404 without health preflights', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    expect((await POLL(jobRequest('job-1'), context)).status).toBe(502);
    expect((await CANCEL(jobRequest('job-1', 'DELETE'), context)).status).toBe(502);
    expect((await DOWNLOAD(jobRequest('job-1/download'), context)).status).toBe(502);
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of mocks.proxyFetch.mock.calls) {
      expect(url).toMatch(/^http:\/\/render-service:9000\/owner-bound\/render\/job-1/);
      expect(init).toEqual(
        expect.objectContaining({ headers: { 'x-openmaic-render-owner': 'owner-a' } }),
      );
    }
  });

  it('refuses unmarked job responses without health preflights', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(Response.json({ jobId: 'job-1', status: 'running' }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }))
      .mockResolvedValueOnce(
        new Response('video', {
          headers: { 'content-type': 'video/mp4', 'content-length': '5' },
        }),
      );

    expect((await POLL(jobRequest('job-1'), context)).status).toBe(502);
    expect((await CANCEL(jobRequest('job-1', 'DELETE'), context)).status).toBe(502);
    expect((await DOWNLOAD(jobRequest('job-1/download'), context)).status).toBe(502);
  });

  it.each(['job-1', 'missing'])('preserves upstream 404 when cancelling %s', async (jobId) => {
    const cookies = ['anonymous_id=first; Path=/', 'host_session=second; Path=/'];
    mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
      for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return 'owner-a';
    });
    mockOwnerBoundResponse(Response.json({ error: 'Job not found' }, { status: 404 }));

    const response = await CANCEL(jobRequest(jobId, 'DELETE'), {
      params: Promise.resolve({ jobId }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Render job lookup failed',
    });
  });

  it('keeps every owner cookie on JSON success, JSON error, and early errors', async () => {
    const cookies = [
      'anonymous_id=first; Path=/; HttpOnly',
      'host_session=second; Path=/; HttpOnly',
    ];
    mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
      for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return 'owner-a';
    });
    mockOwnerBoundResponse(Response.json({ jobId: 'job-1', status: 'running' }));
    mockOwnerBoundResponse(Response.json({ error: 'Job not found' }, { status: 404 }));

    const polled = await POLL(jobRequest('job-1'), context);
    expect(polled.status).toBe(200);
    expect(polled.headers.getSetCookie()).toEqual(cookies);

    const missing = await POLL(jobRequest('missing'), {
      params: Promise.resolve({ jobId: 'missing' }),
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.getSetCookie()).toEqual(cookies);

    vi.stubEnv('RENDER_SERVICE_URL', '');
    const disabled = await CANCEL(jobRequest('job-1', 'DELETE'), context);
    expect(disabled.status).toBe(501);
    expect(disabled.headers.getSetCookie()).toEqual(cookies);
  });

  it('puts every owner cookie on redirects without changing the location', async () => {
    const cookies = ['anonymous_id=first; Path=/', 'host_session=second; Path=/'];
    mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
      for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return 'owner-a';
    });
    mockOwnerBoundResponse(
      new Response(null, {
        status: 302,
        headers: { location: 'https://storage.example.test/video.mp4' },
      }),
    );

    const response = await DOWNLOAD(jobRequest('job-1/download'), context);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://storage.example.test/video.mp4');
    expect(response.headers.getSetCookie()).toEqual(cookies);
  });

  it.each([301, 302])(
    'refuses an unmarked %i download before relaying its Location',
    async (status) => {
      const cookies = ['anonymous_id=first; Path=/', 'host_session=second; Path=/'];
      mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
        for (const cookie of cookies) headers.append('Set-Cookie', cookie);
        return 'owner-a';
      });
      mocks.proxyFetch.mockResolvedValueOnce(
        new Response('protected redirect body', {
          status,
          headers: { location: 'https://storage.example.test/protected.mp4' },
        }),
      );

      const response = await DOWNLOAD(jobRequest('job-1/download'), context);
      expect(response.status).toBe(502);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie()).toEqual(cookies);
      expect(await response.text()).not.toContain('protected');
      expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['submit', 'poll', 'cancel', 'download'])(
    'rejects an unmarked %s 404 with owner cookies',
    async (operation) => {
      mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
        headers.append('Set-Cookie', 'anonymous_id=first; Path=/');
        return 'owner-a';
      });
      mocks.proxyFetch.mockResolvedValueOnce(
        new Response('protected old-service body', {
          status: 404,
          headers: { location: 'https://storage.example.test/protected.mp4' },
        }),
      );
      const response =
        operation === 'submit'
          ? await POST(request())
          : operation === 'poll'
            ? await POLL(jobRequest('job-1'), context)
            : operation === 'cancel'
              ? await CANCEL(jobRequest('job-1', 'DELETE'), context)
              : await DOWNLOAD(jobRequest('job-1/download'), context);
      expect(response.status).toBe(502);
      expect(response.headers.getSetCookie()).toEqual(['anonymous_id=first; Path=/']);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).not.toContain('protected');
      expect(mocks.proxyFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('attaches owner cookies before returning a lazy download stream', async () => {
    const cookies = ['anonymous_id=first; Path=/', 'host_session=second; Path=/'];
    mocks.resolveRequestOwnerId.mockImplementation((_req: NextRequest, headers: Headers) => {
      for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return 'owner-a';
    });
    let pulled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('video'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    mockOwnerBoundResponse(
      new Response(stream, {
        headers: { 'content-type': 'video/mp4', 'content-length': '5' },
      }),
    );

    const response = await DOWNLOAD(jobRequest('job-1/download'), context);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(pulled).toBe(false);
    expect(await response.text()).toBe('video');
  });
});
