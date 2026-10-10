/**
 * The settings test a saved provider by its id: the server resolves it from
 * the deployment or the workspace's own configuration, with the stored key,
 * and the request carries no key or endpoint.
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  testImageConnectivity: vi.fn(),
  callLLM: vi.fn(),
  fetchModels: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  isOwnerRetired: async () => false,
  canonicalizeStoredOwner: async (ownerId: string) => ownerId,
}));
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  requestWorkspaceId: async () => 'user:alice',
}));
vi.mock('@/lib/media/image-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/image-providers')>()),
  testImageConnectivity: mocks.testImageConnectivity,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/model-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-fetch')>()),
  fetchModels: mocks.fetchModels,
}));
// No DNS in tests: the endpoint checks pass.
vi.mock('@/lib/server/ssrf-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { SlotResolutionError } = await import('@/lib/server/model-config/resolve-slot');
const { WorkspaceEndpointError } = await import('@/lib/server/model-config/media');
const { savedProviderRef, savedProviderResponse, savedMediaConnection, SavedProviderError } =
  await import('@/lib/server/model-config/saved-provider');

type Config = import('@/lib/server/model-config/openmaic-yml').ModelConfigFile;
const workspaces = new Map<string, Config>();
const request = (body?: unknown) =>
  new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  workspaces.clear();
  mocks.testImageConnectivity.mockReset();
  mocks.callLLM.mockReset();
  mocks.fetchModels.mockReset();
  runtime.setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: { providers: { operator: { preset: 'openai', apiKey: 'sk-operator' } } },
    },
    legacy: false,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async (ownerId) => {
    const config = workspaces.get(ownerId);
    return config ? { source: 'workspace', config } : null;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
  runtime.setWorkspaceLayerLoaderForTests();
});

describe('savedProviderTarget', () => {
  it("resolves the workspace's own provider with its stored key", async () => {
    workspaces.set('user:alice', {
      providers: { mine: { preset: 'openai', apiKey: 'sk-workspace' } },
    });
    const target = await runtime.savedProviderTarget('mine:gpt-5', 'chat', 'user:alice');
    expect(target).toMatchObject({
      providerId: 'mine',
      providerSource: 'workspace',
      apiKey: 'sk-workspace',
      modelId: 'gpt-5',
    });
  });

  it("resolves the deployment's providers, but not for a workspace-only use", async () => {
    await expect(
      runtime.savedProviderTarget('operator:gpt-5', 'chat', 'user:alice'),
    ).resolves.toMatchObject({ providerSource: 'deployment', apiKey: 'sk-operator' });
    await expect(
      runtime.savedProviderTarget('operator:gpt-5', 'chat', 'user:alice', { workspaceOnly: true }),
    ).rejects.toBeInstanceOf(SlotResolutionError);
  });

  it('refuses a provider nobody declared, or one that does not offer the capability', async () => {
    await expect(
      runtime.savedProviderTarget('nobody:gpt-5', 'chat', 'user:alice'),
    ).rejects.toBeInstanceOf(SlotResolutionError);
    await expect(
      runtime.savedProviderTarget('operator', 'image', 'user:alice'),
    ).rejects.toBeInstanceOf(SlotResolutionError);
  });

  it("does not use the workspace's providers when the policy forbids them", async () => {
    runtime.setDeploymentConfigForTests({
      layer: { source: 'deployment', config: { allowUserKeys: false } },
      legacy: false,
      notices: [],
    });
    workspaces.set('user:alice', {
      providers: { mine: { preset: 'openai', apiKey: 'sk-workspace' } },
    });
    await expect(
      runtime.savedProviderTarget('mine:gpt-5', 'chat', 'user:alice'),
    ).rejects.toBeInstanceOf(SlotResolutionError);
  });
});

describe('saved provider requests', () => {
  it('reads a provider id and model, and refuses a malformed id', () => {
    expect(savedProviderRef(undefined)).toBeUndefined();
    expect(savedProviderRef('mine', 'gpt-5')).toBe('mine:gpt-5');
    expect(savedProviderRef('mine', '  ')).toBe('mine');
    expect(() => savedProviderRef('https://evil.example')).toThrow(SavedProviderError);
    expect(savedProviderResponse(new SavedProviderError('x'), 'image')?.status).toBe(400);
    expect(savedProviderResponse(new SlotResolutionError('x'), 'image')?.status).toBe(400);
  });

  it('keeps the media rules: a self-hosted preset is not a workspace provider', async () => {
    workspaces.set('user:alice', { providers: { cu: { preset: 'comfyui-image' } } });
    await expect(savedMediaConnection(request(), 'image', 'cu')).rejects.toBeInstanceOf(
      WorkspaceEndpointError,
    );
  });

  it('tests an image provider with its stored key', async () => {
    workspaces.set('user:alice', {
      providers: { seed: { preset: 'seedream', apiKey: 'sk-image' } },
    });
    mocks.testImageConnectivity.mockResolvedValue({ success: true, message: 'ok' });
    const { POST } = await import('@/app/api/verify-image-provider/route');
    const response = await POST(request({ provider: 'seed' }));
    expect(response.status).toBe(200);
    expect(mocks.testImageConnectivity).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'seedream', apiKey: 'sk-image' }),
    );
  });

  it('answers 400 for an image provider the workspace does not have', async () => {
    const { POST } = await import('@/app/api/verify-image-provider/route');
    const response = await POST(request({ provider: 'missing' }));
    expect(response.status).toBe(400);
    expect(mocks.testImageConnectivity).not.toHaveBeenCalled();
  });

  it('verifies a saved chat model through the configured provider', async () => {
    workspaces.set('user:alice', {
      providers: { mine: { preset: 'openai', apiKey: 'sk-workspace' } },
    });
    mocks.callLLM.mockResolvedValue({ text: 'OK' });
    const { POST } = await import('@/app/api/verify-model/route');
    const response = await POST(request({ provider: 'mine', model: 'gpt-5' }));
    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it("lists a workspace chat provider's models with its stored endpoint and key", async () => {
    workspaces.set('user:alice', {
      providers: {
        mine: {
          preset: 'openai-compatible',
          apiKey: 'sk-workspace',
          baseUrl: 'https://llm.example/v1',
        },
      },
    });
    mocks.fetchModels.mockResolvedValue([{ id: 'gpt-x' }]);
    const { POST } = await import('@/app/api/provider/probe-models/route');
    const response = await POST(request({ provider: 'mine' }));
    expect(response.status).toBe(200);
    expect(mocks.fetchModels).toHaveBeenCalledWith('https://llm.example/v1', 'sk-workspace', {
      modelsUrlOverride: undefined,
    });
  });

  it("does not list a deployment provider's models (not the workspace's to edit)", async () => {
    mocks.fetchModels.mockResolvedValue([]);
    const { POST } = await import('@/app/api/provider/probe-models/route');
    const response = await POST(request({ provider: 'operator' }));
    expect(response.status).toBe(400);
    expect(mocks.fetchModels).not.toHaveBeenCalled();
  });
});
