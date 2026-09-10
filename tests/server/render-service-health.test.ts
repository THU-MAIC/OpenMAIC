import { beforeEach, describe, expect, it, vi } from 'vitest';

// The capability endpoint's contract with the render service (#1350): it must
// report reachability AND the queue-cap admission flag forwarded from
// `GET /health` (#1348), while never letting a malformed or missing flag turn a
// reachable service into an unusable one — the service's own 429 stays
// authoritative, so an unknown flag must read as "accepting".

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GET } from '@/app/api/export-video/capability/route';
import { checkRenderServiceHealth } from '@/lib/server/render-service';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('render service health probe', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    proxyFetchMock.mockReset();
  });

  it('is disabled, and still accepting, when no service is configured', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');

    await expect(checkRenderServiceHealth()).resolves.toEqual({
      enabled: false,
      accepting: true,
    });
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it('forwards the admission flag the service reports', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, accepting: false, resourceProfile: 'default' }),
    );

    await expect(checkRenderServiceHealth()).resolves.toEqual({ enabled: true, accepting: false });
    expect(proxyFetchMock.mock.calls[0]?.[0]).toBe('http://render-service:9000/health');
  });

  it('assumes room when the service omits the flag, so older builds still render', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(checkRenderServiceHealth()).resolves.toEqual({ enabled: true, accepting: true });
  });

  it('assumes room when the body is not readable as JSON', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockResolvedValueOnce(
      new Response('<html>gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(checkRenderServiceHealth()).resolves.toEqual({ enabled: true, accepting: true });
  });

  it('is disabled when the service answers non-OK', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ ok: false }, 503));

    await expect(checkRenderServiceHealth()).resolves.toEqual({
      enabled: false,
      accepting: true,
    });
  });

  it('is disabled when the probe throws', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(checkRenderServiceHealth()).resolves.toEqual({
      enabled: false,
      accepting: true,
    });
  });
});

describe('GET /api/export-video/capability', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    proxyFetchMock.mockReset();
  });

  it('surfaces a full queue alongside the enabled flag', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000');
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, accepting: false }));

    const json = await (await GET()).json();

    expect(json).toEqual({ success: true, enabled: true, accepting: false });
  });

  it('reports a disabled service without advertising a queue state', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');

    const json = await (await GET()).json();

    expect(json).toEqual({ success: true, enabled: false, accepting: true });
  });
});
