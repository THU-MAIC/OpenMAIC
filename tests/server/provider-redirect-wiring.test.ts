import { beforeEach, describe, expect, it, vi } from 'vitest';

// resolveModel is the single server-side funnel that builds LLM models for the
// BYOK chat / verify-model paths. It must install the redirect-validating
// transport on every model it resolves — a client-supplied base URL cannot be
// the only protected hop, because the redirect target is not known until the
// origin answers.

const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
  serverManaged: false,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: (args: Record<string, unknown>) => {
      mocks.getModelCalls.push(args);
      return { model: { id: args.modelId }, modelInfo: undefined };
    },
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.serverManaged,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

describe('resolveModel — installs the redirect-validating transport on every model', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
    mocks.getModelCalls.length = 0;
    mocks.serverManaged = false;
  });

  it('passes fetchWithRedirectValidation as the fetch implementation for a client-supplied base URL', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const { fetchWithRedirectValidation } =
      await import('@/lib/server/fetch-with-redirect-validation');
    await resolveModel({
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://8.8.8.8/v1',
    });

    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      baseUrl: 'https://8.8.8.8/v1',
      fetchImpl: fetchWithRedirectValidation,
    });
  });

  it('keeps the same hop re-validation for managed providers, whose origin is operator-trusted but whose redirects are not', async () => {
    mocks.serverManaged = true;
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const { fetchWithRedirectValidation } =
      await import('@/lib/server/fetch-with-redirect-validation');
    await resolveModel({
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'server-key',
    });

    const call = mocks.getModelCalls.at(-1)!;
    expect(call.baseUrl).toBeUndefined();
    expect(call.fetchImpl).toBe(fetchWithRedirectValidation);
  });
});
