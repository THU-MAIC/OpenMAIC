import * as undici from 'undici';
import * as dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAndExtractUrl,
  buildFetchUrlTool,
  FetchUrlError,
} from '@/lib/server/agent-runtime/fetch-url';
import { kimi as provider } from '@/lib/web-fetch/providers/kimi';
import { firecrawl } from '@/lib/web-fetch/providers/firecrawl';
import {
  setDeploymentConfigForTests,
  setWorkspaceLayerLoaderForTests,
} from '@/lib/server/model-config/runtime';

vi.mock('undici', async (importActual) => ({
  ...(await importActual<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const url = 'https://example.com/article';
const text = 'An extracted article with useful details. '.repeat(40).trim();
const options = {
  providerId: 'kimi',
  credentials: { apiKey: 'test-key' },
  isUrlAllowed: vi.fn(async (_url: string) => true),
};

beforeEach(() => {
  vi.mocked(dns.lookup).mockReset();
  options.isUrlAllowed.mockClear();
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  vi.spyOn(provider, 'extract').mockResolvedValue({ title: 'Article', markdown: text });
  options.isUrlAllowed.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setDeploymentConfigForTests();
  setWorkspaceLayerLoaderForTests();
});

describe('hosted web fetch trust boundary', () => {
  it('authorizes the URL and every DNS answer before dispatch', async () => {
    await fetchAndExtractUrl(url, options);
    expect(options.isUrlAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dns.lookup).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(dns.lookup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(provider.extract).mock.invocationCallOrder[0],
    );
  });
  it('never forwards a session-refused URL', async () => {
    options.isUrlAllowed.mockResolvedValue(false);
    await expect(fetchAndExtractUrl(url, options)).rejects.toMatchObject({ reason: 'blocked' });
    expect(provider.extract).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
  });
  it.each([
    'http://127.0.0.1',
    'http://2130706433',
    'http://metadata.google.internal',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'file:///tmp/example',
  ])('never forwards an unsafe URL: %s', async (input) => {
    await expect(fetchAndExtractUrl(input, options)).rejects.toBeInstanceOf(FetchUrlError);
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('refuses mixed public and private DNS answers before dispatch', async () => {
    vi.mocked(dns.lookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ] as never);
    await expect(fetchAndExtractUrl(url, options)).rejects.toMatchObject({ reason: 'network' });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it.each([
    { addresses: [] },
    { addresses: [{ address: '100.64.0.1', family: 4 }] },
    { addresses: [{ address: '::1', family: 6 }] },
  ])('fails closed for an unverifiable or unsafe DNS set', async ({ addresses }) => {
    vi.mocked(dns.lookup).mockResolvedValue(addresses as never);
    await expect(fetchAndExtractUrl(url, options)).rejects.toBeInstanceOf(FetchUrlError);
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('fails closed on DNS errors', async () => {
    vi.mocked(dns.lookup).mockRejectedValue(new Error('DNS failed'));
    await expect(fetchAndExtractUrl(url, options)).rejects.toMatchObject({ reason: 'network' });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('accepts a safe reported final URL', async () => {
    vi.mocked(provider.extract).mockResolvedValue({
      markdown: text,
      finalUrl: 'https://example.com/final',
    });
    expect(await fetchAndExtractUrl(url, options)).toMatchObject({
      finalUrl: 'https://example.com/final',
    });
  });
  it.each(['http://10.0.0.1/internal', 'https://unseen.example/final'])(
    'rejects an unsafe or unobserved final URL: %s',
    async (finalUrl) => {
      vi.mocked(provider.extract).mockResolvedValue({ markdown: text, finalUrl });
      options.isUrlAllowed.mockImplementation(async (input) => !input.includes('unseen'));
      await expect(fetchAndExtractUrl(url, options)).rejects.toBeInstanceOf(FetchUrlError);
    },
  );
  it('maps adapter failure to the existing network failure without fallback', async () => {
    vi.mocked(provider.extract).mockRejectedValue(new Error('Provider unavailable'));
    await expect(fetchAndExtractUrl(url, options)).rejects.toMatchObject({ reason: 'network' });
    expect(provider.extract).toHaveBeenCalledTimes(1);
  });
  it.each([
    { markdown: 'Complete the captcha to continue' },
    { title: 'Captcha', markdown: text },
    { markdown: '' },
  ])('detects challenge or empty hosted output', async (result) => {
    vi.mocked(provider.extract).mockResolvedValue(result);
    await expect(fetchAndExtractUrl(url, options)).rejects.toMatchObject({
      reason: result.markdown ? 'blocked' : 'empty',
    });
  });
  it('caps UTF-8 bytes and marks truncation', async () => {
    vi.mocked(provider.extract).mockResolvedValue({ markdown: '🌍'.repeat(400) });
    const page = await fetchAndExtractUrl(url, { ...options, maxBytes: 300, minChars: 1 });
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(page.markdown)).toBeLessThanOrEqual(300);
    expect(page.markdown).toContain('[Content truncated]');
    expect(page.markdown).not.toContain('\uFFFD');
  });
  it('does not count the truncation notice toward the minimum content threshold', async () => {
    vi.mocked(provider.extract).mockResolvedValue({ markdown: 'x'.repeat(400) });
    await expect(
      fetchAndExtractUrl(url, { ...options, maxBytes: 220, minChars: 210 }),
    ).rejects.toMatchObject({ reason: 'empty' });
  });
  it('passes PDF URLs directly to the hosted provider', async () => {
    await fetchAndExtractUrl('https://example.com/paper.pdf', options);
    expect(provider.extract).toHaveBeenCalledWith(
      'https://example.com/paper.pdf',
      expect.anything(),
    );
  });
  it('does not dispatch an already aborted request', async () => {
    await expect(
      fetchAndExtractUrl(url, { ...options, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ reason: 'network' });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('resolves the configured slot and persists hosted content with the existing result shape', async () => {
    setDeploymentConfigForTests({
      legacy: false,
      notices: [],
      layer: {
        source: 'deployment',
        config: {
          providers: { reader: { preset: 'kimi', apiKey: 'test-key' } },
          slots: { webFetch: 'reader' },
        },
      },
    });
    const save = vi.fn().mockResolvedValue({ id: 'material-1' });
    const tool = buildFetchUrlTool({
      sessionId: 'session-1',
      isUrlAllowed: async () => true,
      saveWebMaterial: save,
    });
    const result = await tool.execute('call-1', { url } as never, undefined);
    expect(save).toHaveBeenCalledWith('session-1', expect.objectContaining({ markdown: text }));
    expect(result.details).toMatchObject({
      trusted: { status: 'done', materialId: 'material-1' },
      untrusted: { title: 'Article', content: text },
    });
  });
});

it('uses the real slot lookup and builtin reader when webFetch is unconfigured', async () => {
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  vi.mocked(undici.fetch).mockResolvedValue(
    new Response(text, { headers: { 'Content-Type': 'text/plain' } }) as never,
  );
  const save = vi.fn().mockResolvedValue({ id: 'builtin-material' });
  const tool = buildFetchUrlTool({
    sessionId: 'session-1',
    isUrlAllowed: async () => true,
    saveWebMaterial: save,
  });
  const result = await tool.execute('call-1', { url } as never, undefined);
  expect(undici.fetch).toHaveBeenCalled();
  expect(provider.extract).not.toHaveBeenCalled();
  expect(result.details).toMatchObject({
    trusted: { status: 'done', materialId: 'builtin-material' },
    untrusted: { content: text },
  });
});

it('fails loudly for a stale workspace reference, like other media slots', async () => {
  const { resolveMediaSlot } = await import('@/lib/server/model-config/media');
  const { SlotResolutionError } = await import('@/lib/server/model-config/resolve-slot');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  setWorkspaceLayerLoaderForTests(async () => ({
    source: 'workspace',
    config: { slots: { webFetch: 'deleted', webSearch: 'deleted', document: 'deleted' } },
  }));
  for (const slot of ['webFetch', 'webSearch', 'document'] as const) {
    await expect(resolveMediaSlot(slot, { workspaceId: 'user:test' })).rejects.toBeInstanceOf(
      SlotResolutionError,
    );
  }
  const fetch = buildFetchUrlTool({
    sessionId: 'session-1',
    ownerId: 'user:test',
    isUrlAllowed: async () => true,
  });
  await expect(fetch.execute('call-1', { url } as never, undefined)).rejects.toBeInstanceOf(
    SlotResolutionError,
  );
});

it('forwards the resolved provider proxy and options through the shared media path', async () => {
  setDeploymentConfigForTests({
    legacy: false,
    notices: [],
    layer: {
      source: 'deployment',
      config: {
        providers: {
          reader: {
            preset: 'kimi-coding-plan',
            apiKey: 'test-key',
            proxy: 'http://proxy.example:8080',
            options: { custom: true },
          },
        },
        slots: { webFetch: 'reader' },
      },
    },
  });
  const fetch = buildFetchUrlTool({
    sessionId: 'session-1',
    isUrlAllowed: async () => true,
    saveWebMaterial: vi.fn().mockResolvedValue({ id: 'material' }),
  });
  await fetch.execute('call-1', { url } as never, undefined);
  expect(provider.extract).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      credentials: {
        apiKey: 'test-key',
        baseUrl: 'https://api.kimi.com/coding/v1',
        proxy: 'http://proxy.example:8080',
        options: { custom: true },
      },
    }),
  );
});

describe('Firecrawl behind the same trust boundary', () => {
  const firecrawlOptions = { ...options, providerId: 'firecrawl' };
  beforeEach(() => {
    vi.spyOn(firecrawl, 'extract').mockResolvedValue({ title: 'Article', markdown: text });
  });
  it('dispatches a safe URL to Firecrawl after the local checks', async () => {
    expect(await fetchAndExtractUrl(url, firecrawlOptions)).toMatchObject({
      sourceUrl: url,
      title: 'Article',
      markdown: text,
    });
    expect(vi.mocked(dns.lookup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(firecrawl.extract).mock.invocationCallOrder[0],
    );
  });
  it.each(['http://127.0.0.1', 'http://metadata.google.internal', 'file:///tmp/example'])(
    'never forwards an unsafe URL to Firecrawl: %s',
    async (input) => {
      await expect(fetchAndExtractUrl(input, firecrawlOptions)).rejects.toBeInstanceOf(
        FetchUrlError,
      );
      expect(firecrawl.extract).not.toHaveBeenCalled();
    },
  );
  it('never forwards a session-refused URL to Firecrawl', async () => {
    options.isUrlAllowed.mockResolvedValue(false);
    await expect(fetchAndExtractUrl(url, firecrawlOptions)).rejects.toMatchObject({
      reason: 'blocked',
    });
    expect(firecrawl.extract).not.toHaveBeenCalled();
  });
  it('checks a redirect target against the session gate before accepting it', async () => {
    vi.mocked(firecrawl.extract).mockResolvedValue({
      markdown: text,
      finalUrl: 'https://unapproved.example/landed',
    });
    options.isUrlAllowed.mockImplementation(async (input) => !input.includes('unapproved'));
    await expect(fetchAndExtractUrl(url, firecrawlOptions)).rejects.toMatchObject({
      reason: 'blocked',
    });
  });
  it('rejects a private final URL reported by Firecrawl', async () => {
    vi.mocked(firecrawl.extract).mockResolvedValue({
      markdown: text,
      finalUrl: 'http://10.0.0.1/internal',
    });
    await expect(fetchAndExtractUrl(url, firecrawlOptions)).rejects.toBeInstanceOf(FetchUrlError);
  });
});
