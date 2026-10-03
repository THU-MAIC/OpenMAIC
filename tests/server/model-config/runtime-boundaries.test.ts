import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  outcome: undefined as unknown,
  retired: new Set<string>(),
  forwarded: new Map<string, string>(),
  stored: new Map<string, unknown>(),
  loads: 0,
}));

vi.mock('@/lib/server/identity/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/identity/resolve')>()),
  resolveRequestOwner: async () => mocks.outcome,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  isOwnerRetired: async (_pool: unknown, ownerId: string) => mocks.retired.has(ownerId),
  canonicalizeStoredOwner: async (ownerId: string) => mocks.forwarded.get(ownerId) ?? ownerId,
}));
vi.mock('@/lib/persistence/workspace-model-config', () => ({
  readWorkspaceModelConfig: async (_pool: unknown, ownerId: string) =>
    mocks.stored.get(ownerId) ?? null,
}));
vi.mock('@/lib/server/model-config/deployment-layer', () => ({
  loadDeploymentLayer: () => {
    mocks.loads += 1;
    return { layer: null, legacy: false, notices: [] };
  },
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { InvalidOwnerCredentialError } = await import('@/lib/server/identity/resolve');

const principal = (ownerId: string, assurance = 'verified') => ({
  ok: true,
  principal: { ownerId, kind: 'user', roles: new Set(), assurance },
});
const request = { headers: new Headers() };

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  mocks.retired.clear();
  mocks.forwarded.clear();
  mocks.stored.clear();
  mocks.loads = 0;
  runtime.setDeploymentConfigForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
});

describe('requestWorkspaceId', () => {
  it("names the request's owner", async () => {
    mocks.outcome = principal('user:alice');
    expect(await runtime.requestWorkspaceId(request)).toBe('user:alice');
  });

  it('refuses a refused credential instead of falling back to the deployment', async () => {
    mocks.outcome = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };
    await expect(runtime.requestWorkspaceId(request)).rejects.toBeInstanceOf(
      InvalidOwnerCredentialError,
    );
  });

  it('has no workspace for an owner minted by this request', async () => {
    mocks.outcome = principal('anon:new', 'minted');
    expect(await runtime.requestWorkspaceId(request)).toBeNull();
  });

  it("never hands a retired owner the account's settings", async () => {
    mocks.outcome = principal('anon:old');
    mocks.retired.add('anon:old');
    mocks.forwarded.set('anon:old', 'user:alice');
    mocks.stored.set('user:alice', { config: { slots: { llm: null } }, unreadableSecrets: [] });
    expect(await runtime.requestWorkspaceId(request)).toBeNull();
  });
});

describe('workspaceLayer', () => {
  it('reads exactly the owner it is given, never forwarded through a claim', async () => {
    // Claimed after the request's owner check: the settings moved to the account.
    mocks.forwarded.set('anon:old', 'user:alice');
    mocks.stored.set('user:alice', {
      config: { slots: { video: null } },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(await runtime.workspaceLayer('anon:old')).toBeNull();
    expect(await runtime.workspaceLayer('user:alice')).toEqual({
      source: 'workspace',
      config: { slots: { video: null } },
    });
  });

  it('lets a database failure fail the call, without falling back', async () => {
    runtime.setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { o: { preset: 'openai', apiKey: 'k' } },
          slots: { llm: 'o:gpt-5.6' },
        },
      },
      legacy: true,
      notices: [],
    });
    runtime.setWorkspaceLayerLoaderForTests(async () => {
      throw new Error('connection refused');
    });
    const legacyRequest = vi.fn();
    const { resolveStageModel } = await import('@/lib/server/model-config/llm');
    try {
      await expect(
        resolveStageModel({ stage: 'quiz-grade', workspaceId: 'user:alice', legacyRequest }),
      ).rejects.toThrow('connection refused');
      expect(legacyRequest).not.toHaveBeenCalled();
    } finally {
      runtime.setWorkspaceLayerLoaderForTests();
    }
  });

  it('reads nothing without a database', async () => {
    vi.stubEnv('DATABASE_URL', '');
    mocks.stored.set('user:alice', { config: {}, unreadableSecrets: [] });
    expect(await runtime.workspaceLayer('user:alice')).toBeNull();
  });
});

describe('deploymentConfig', () => {
  it('loads once per process', () => {
    runtime.deploymentConfig();
    runtime.deploymentConfig();
    expect(mocks.loads).toBe(1);
    runtime.setDeploymentConfigForTests();
    runtime.deploymentConfig();
    expect(mocks.loads).toBe(2);
  });
});
