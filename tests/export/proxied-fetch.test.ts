import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProxiedFetch } from '@/lib/export/proxied-fetch';

describe('createProxiedFetch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs the original url to /api/proxy-media and returns the proxy response', async () => {
    const spy = vi.fn(
      async () =>
        new Response('BYTES', { status: 200, headers: { 'content-type': 'text/javascript' } }),
    );
    vi.stubGlobal('fetch', spy);
    const pfetch = createProxiedFetch();
    const res = await pfetch('https://cdn.tailwindcss.com');
    expect(spy).toHaveBeenCalledWith(
      '/api/proxy-media',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://cdn.tailwindcss.com' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('BYTES');
  });

  it('handles URL objects', async () => {
    const spy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await createProxiedFetch()(new URL('https://x/y.css'));
    expect(spy).toHaveBeenCalledWith(
      '/api/proxy-media',
      expect.objectContaining({
        body: JSON.stringify({ url: 'https://x/y.css' }),
      }),
    );
  });
});
