import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));
import { GET } from '@/app/api/export-video/capability/route';

beforeEach(() => {
  vi.stubEnv('RENDER_SERVICE_URL', 'http://render-service:9000/');
  proxyFetch.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function ownerBound(response: Response): Response {
  response.headers.set('x-openmaic-render-owner-bound', '1');
  return response;
}

describe('video export capability', () => {
  it.each([true, false])(
    'forwards accepting=%s without leaking service details',
    async (accepting) => {
      proxyFetch.mockResolvedValue(
        ownerBound(Response.json({ ok: true, accepting, versions: { internal: 'x' } })),
      );
      expect(await (await GET()).json()).toEqual({ success: true, enabled: true, accepting });
      expect(proxyFetch).toHaveBeenCalledWith('http://render-service:9000/health', {
        method: 'GET',
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each([{ ok: true }, { accepting: 'false' }, null])(
    'disables an older service without the owner-binding marker: %j',
    async (body) => {
      proxyFetch.mockResolvedValue(Response.json(body));
      expect(await (await GET()).json()).toEqual({ success: true, enabled: false });
    },
  );

  it('keeps a marked healthy service enabled when its body is not JSON', async () => {
    proxyFetch.mockResolvedValue(ownerBound(new Response('OK')));
    expect(await (await GET()).json()).toEqual({ success: true, enabled: true });
  });

  it('does not probe an unconfigured service', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');
    expect(await (await GET()).json()).toEqual({ success: true, enabled: false });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('disables an unhealthy service', async () => {
    proxyFetch.mockResolvedValue(new Response('', { status: 503 }));
    expect(await (await GET()).json()).toEqual({ success: true, enabled: false });
  });

  it('disables an unreachable service with the existing three-second deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    proxyFetch.mockRejectedValue(new Error('unreachable'));
    expect(await (await GET()).json()).toEqual({ success: true, enabled: false });
    expect(timeout).toHaveBeenCalledWith(3000);
    timeout.mockRestore();
  });
});
