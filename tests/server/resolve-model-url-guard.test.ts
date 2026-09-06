import { beforeEach, describe, expect, it, vi } from 'vitest';

// resolveModel throws when a client-supplied base URL is unsafe, in every
// environment — the ALLOW_LOCAL_NETWORKS escape hatch stays honored by the
// guard itself. This file keeps the real ssrf-guard (no mock) so the private
// address classification is exercised end to end.

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

describe('resolveModel — client-supplied base URL guard applies in every environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
    mocks.getModelCalls.length = 0;
    mocks.serverManaged = false;
  });

  it('rejects a metadata-address base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(
      resolveModel({
        modelString: 'openai:gpt-5.4-mini',
        apiKey: 'client-key',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('still allows the same local base URL when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const result = await resolveModel({
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(result.modelId).toBe('gpt-5.4-mini');
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });
  });
});
