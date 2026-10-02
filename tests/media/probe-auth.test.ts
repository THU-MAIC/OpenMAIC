import { describe, expect, it, vi } from 'vitest';

import { probeAuth } from '@/lib/media/probe-auth';

describe('probeAuth', () => {
  it.each([200, 299, 400, 404, 429, 500])(
    'treats HTTP %i as authenticated without reading the response body',
    async (status) => {
      const response = new Response('unused', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: true,
        message: 'Connected to Example',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it.each([300, 301, 302, 303, 304, 307, 308, 399])(
    'rejects HTTP %i redirects without reading the response body',
    async (status) => {
      const response = new Response(status === 304 ? null : 'unused', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: 'Example connectivity error: Redirects are not allowed',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    'reports HTTP %i as an auth failure without reading the response body',
    async (status) => {
      const response = new Response('invalid key', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: `Example auth failed (${status}), please check the API Key`,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it('converts request errors into one fixed connectivity failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:80'));

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: cannot reach the provider, please check the Base URL',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('maps a transport-refused redirect to the redirect message', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      );

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: Redirects are not allowed',
    });
  });
});
