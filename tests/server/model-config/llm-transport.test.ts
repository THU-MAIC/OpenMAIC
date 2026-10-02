import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ fetchImpl?: unknown; apiKey?: string }>);

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  getModel: (config: { fetchImpl?: unknown; apiKey?: string }) => {
    calls.push(config);
    return { model: {}, modelInfo: null };
  },
}));

const { languageModelFor } = await import('@/lib/server/model-config/llm');
const { clientBaseUrlLlmFetch } = await import('@/lib/server/llm-provider-fetch');
const { fetchWithRedirectValidation } = await import('@/lib/server/fetch-with-redirect-validation');

const target = (providerSource: 'deployment' | 'workspace' | 'default') => ({
  providerId: 'p',
  providerSource,
  presetId: 'openai',
  registryId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt-5.6',
});

describe('the transport a slot model gets', () => {
  it('refuses redirects for a workspace endpoint', async () => {
    await languageModelFor(target('workspace'));
    expect(calls.at(-1)?.fetchImpl).toBe(clientBaseUrlLlmFetch);
  });

  it.each(['deployment', 'default'] as const)(
    'keeps the operator transport for a %s provider',
    async (source) => {
      await languageModelFor(target(source));
      expect(calls.at(-1)?.fetchImpl).toBe(fetchWithRedirectValidation);
    },
  );
});
