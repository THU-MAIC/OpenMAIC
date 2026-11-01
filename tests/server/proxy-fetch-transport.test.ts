import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  agent: vi.fn(),
  instances: [] as { close: ReturnType<typeof vi.fn> }[],
}));
vi.mock('undici', () => ({
  fetch: transport.fetch,
  ProxyAgent: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(options: unknown) {
      transport.agent(options);
      transport.instances.push(this);
    }
  },
}));
let proxyFetch: typeof import('@/lib/server/proxy-fetch').proxyFetch;
beforeEach(async () => {
  vi.resetModules();
  ({ proxyFetch } = await import('@/lib/server/proxy-fetch'));
  transport.instances.length = 0;
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

it('reuses agents when calls alternate between default and fetch deadline profiles', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://shared-proxy.example:8080');
  const timeouts = { connectTimeout: 5000, headersTimeout: 10000, bodyTimeout: 30000 };
  for (let i = 0; i < 3; i++) {
    await proxyFetch('https://search.example/test');
    await proxyFetch('https://reader.example/test', {}, { timeouts });
  }
  expect(transport.agent).toHaveBeenCalledTimes(2);
  const dispatchers = transport.fetch.mock.calls.map(([, init]) => init.dispatcher);
  expect(dispatchers).toEqual([
    transport.instances[0],
    transport.instances[1],
    transport.instances[0],
    transport.instances[1],
    transport.instances[0],
    transport.instances[1],
  ]);
  for (const agent of transport.instances) expect(agent.close).not.toHaveBeenCalled();
});

it('closes the least recently used agent on eviction and retains recently used profiles', async () => {
  const options = (id: number) => ({ proxy: `http://proxy-${id}.example:8080` });
  for (let i = 0; i < 8; i++) await proxyFetch('https://api.example/test', {}, options(i));
  // Refresh the oldest profile: profile 1 should now be evicted instead.
  await proxyFetch('https://api.example/test', {}, options(0));
  await proxyFetch('https://api.example/test', {}, options(8));
  expect(transport.instances[1].close).toHaveBeenCalledTimes(1);
  expect(transport.instances[0].close).not.toHaveBeenCalled();
  await proxyFetch('https://api.example/test', {}, options(0));
  expect(transport.agent).toHaveBeenCalledTimes(9);
  await proxyFetch('https://api.example/test', {}, options(1));
  expect(transport.agent).toHaveBeenCalledTimes(10);
  expect(transport.instances[2].close).toHaveBeenCalledTimes(1);
});
