import { afterEach, expect, it, vi } from 'vitest';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { resolveMediaSlot } from '@/lib/server/model-config/media';
import {
  resolveWebSearchConnection,
  resolveSafeClientWebSearchBaseUrl,
} from '@/lib/server/web-search-config';
import { searchWeb } from '@/lib/web-search';
import { deepseek } from '@/lib/web-fetch/providers/deepseek';
import { applyModelSettingsChange } from '@/lib/server/model-config/settings';

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));
afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
  proxyFetch.mockReset();
});

it.each([
  'https://gateway.example/v1',
  'https://gateway.example/prefix/v1/',
  'https://gateway.example',
])('uses an explicit openmaic.yml DeepSeek base for both tools: %s', async (baseUrl) => {
  vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', '');
  const config = parseModelConfig(
    `providers:\n  account:\n    preset: deepseek\n    apiKey: shared-key\n    baseUrl: ${baseUrl}\nslots:\n  webSearch: account\n  webFetch: account\n`,
  );
  setDeploymentConfigForTests({
    legacy: false,
    notices: [],
    layer: { source: 'deployment', config },
  });
  const search = await resolveWebSearchConnection(null);
  const fetch = await resolveMediaSlot('webFetch', { workspaceId: null });
  expect(search).toMatchObject({ providerId: 'deepseek', apiKey: 'shared-key', baseUrl });
  expect(fetch).toMatchObject({
    providerId: 'deepseek',
    apiKey: 'shared-key',
    baseUrl,
    managed: true,
  });
  proxyFetch
    .mockResolvedValueOnce(Response.json({ results: [] }))
    .mockResolvedValueOnce(Response.json({ content: 'Body' }));
  await searchWeb({ ...search, query: 'q' });
  expect(await deepseek.extract('https://example.com', { credentials: fetch })).toEqual({
    markdown: 'Body',
  });
  const base = baseUrl.replace(/\/+$/, '') + (new URL(baseUrl).pathname === '/' ? '/v1' : '');
  expect(proxyFetch.mock.calls.map(([url]) => url)).toEqual([
    `${base}/tools/search`,
    `${base}/tools/fetch`,
  ]);
});

it.each(['https://api.deepseek.com', 'https://api.deepseek.com/v1/'])(
  'allows official client search and workspace fetch bases: %s',
  async (baseUrl) => {
    expect(resolveSafeClientWebSearchBaseUrl('deepseek', baseUrl)).toBe(
      baseUrl.replace(/\/+$/, ''),
    );
    setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
    await expect(
      applyModelSettingsChange(
        { providers: { account: { preset: 'deepseek', apiKey: 'key', baseUrl } } },
        { kind: 'slots', set: { webFetch: 'account' } },
      ),
    ).resolves.toHaveProperty('slots.webFetch', 'account');
  },
);

it('refuses arbitrary client bases and workspace fetch overrides while preserving deployment support', async () => {
  expect(() => resolveSafeClientWebSearchBaseUrl('deepseek', 'https://gateway.example/v1')).toThrow(
    /Unsupported DeepSeek/,
  );
  setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
  await expect(
    applyModelSettingsChange(
      {
        providers: {
          account: { preset: 'deepseek', apiKey: 'key', baseUrl: 'https://gateway.example/v1' },
        },
      },
      { kind: 'slots', set: { webFetch: 'account' } },
    ),
  ).rejects.toThrow(/workspace provider with its own endpoint/);
});
