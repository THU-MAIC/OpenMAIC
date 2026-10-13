import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn() }));
vi.mock('undici', () => ({
  fetch: transport.fetch,
  ProxyAgent: class {
    constructor(options: unknown) {
      transport.agent(options);
    }
  },
}));
import { proxyFetch } from '@/lib/server/proxy-fetch';
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
  ])
    vi.stubEnv(key, '');
  transport.fetch.mockResolvedValue(new Response('proxied'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('uses standard environment proxies', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.example:8080');
  await proxyFetch('https://api.example/test');
  expect(transport.agent).toHaveBeenCalledWith({ uri: 'http://environment-proxy.example:8080' });
  expect(transport.fetch).toHaveBeenCalled();
});
it('uses an explicit provider proxy before environment/NO_PROXY and retains deadlines', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.example:8080');
  vi.stubEnv('NO_PROXY', '*');
  await proxyFetch(
    'https://api.example/test',
    {},
    {
      proxy: 'http://provider-proxy.example:8080',
      timeouts: { connectTimeout: 5000, headersTimeout: 10000, bodyTimeout: 30000 },
    },
  );
  expect(transport.agent).toHaveBeenCalledWith({
    uri: 'http://provider-proxy.example:8080',
    requestTls: { timeout: 5000 },
    proxyTls: { timeout: 5000 },
    headersTimeout: 10000,
    bodyTimeout: 30000,
  });
  expect(transport.fetch).toHaveBeenCalled();
});
it('retains direct fetch when no proxy is configured', async () => {
  const direct = vi.fn().mockResolvedValue(new Response('direct'));
  vi.stubGlobal('fetch', direct);
  await proxyFetch('https://api.example/test');
  expect(direct).toHaveBeenCalled();
  expect(transport.fetch).not.toHaveBeenCalled();
});
