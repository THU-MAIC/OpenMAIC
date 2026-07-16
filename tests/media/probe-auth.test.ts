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
    'reports HTTP %i as an auth failure with the response body',
    async (status) => {
      const response = new Response('invalid key', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: `Example auth failed (${status}): invalid key`,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('converts request errors into connectivity failures', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: Error: offline',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('converts auth response body errors into connectivity failures', async () => {
    const response = new Response('unused', { status: 401 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('body unavailable'));
    const request = vi.fn().mockResolvedValue(response);

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: Error: body unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
