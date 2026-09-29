import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forwarded: new Map<string, string>(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  isOwnerRetired: async () => false,
  canonicalizeStoredOwner: async (ownerId: string) => mocks.forwarded.get(ownerId) ?? ownerId,
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { WorkspaceEndpointError, mediaResolutionResponse, resolveMediaSlot, serverMediaConnection } =
  await import('@/lib/server/model-config/media');
const { slotTTSModel } = await import('@/lib/server/provider-config');
const { resolveExtractionServices, slotGovernedRequest } =
  await import('@/lib/server/material-extraction/services');

type Config = import('@/lib/server/model-config/openmaic-yml').ModelConfigFile;
const workspaces = new Map<string, Config>();

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  mocks.forwarded.clear();
  workspaces.clear();
  runtime.setDeploymentConfigForTests({ layer: null, defaults: null, notices: [] });
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

describe('workspace media endpoints', () => {
  it("uses a workspace provider only at its preset's endpoint", async () => {
    workspaces.set('user:alice', {
      providers: { tv: { preset: 'tavily', apiKey: 'k' } },
      slots: { webSearch: 'tv' },
    });
    const connection = await resolveMediaSlot('webSearch', { workspaceId: 'user:alice' });
    // Only the preset's own endpoint: nothing user-typed for the transports to police.
    expect(connection).toMatchObject({ providerId: 'tavily', managed: false, userEndpoint: false });
  });

  it("refuses a self-hosted preset whose default endpoint is on the server's network", async () => {
    workspaces.set('user:alice', {
      providers: { cu: { preset: 'comfyui-image' }, fa: { preset: 'funasr-asr' } },
      slots: { image: 'cu', asr: 'fa' },
    });
    for (const slot of ['image', 'asr'] as const) {
      await expect(resolveMediaSlot(slot, { workspaceId: 'user:alice' })).rejects.toBeInstanceOf(
        WorkspaceEndpointError,
      );
    }
  });

  it('refuses a custom endpoint typed into the workspace settings', async () => {
    workspaces.set('user:alice', {
      providers: { tv: { preset: 'tavily', apiKey: 'k', baseUrl: 'https://search.example' } },
      slots: { webSearch: 'tv' },
    });
    const error = await resolveMediaSlot('webSearch', { workspaceId: 'user:alice' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorkspaceEndpointError);
    expect(mediaResolutionResponse(error, 'web search')?.status).toBe(403);
  });

  it('keeps a custom endpoint the deployment configured', async () => {
    runtime.setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { tv: { preset: 'tavily', apiKey: 'k', baseUrl: 'http://10.0.0.5' } },
          slots: { webSearch: 'tv' },
        },
      },
      defaults: null,
      notices: [],
    });
    expect(await resolveMediaSlot('webSearch', { workspaceId: null })).toMatchObject({
      baseUrl: 'http://10.0.0.5',
      managed: true,
    });
  });
});

describe('serverMediaConnection forwarding', () => {
  const claimed = () => {
    mocks.forwarded.set('anon:old', 'user:alice');
    workspaces.set('user:alice', {
      providers: { tv: { preset: 'tavily', apiKey: 'alice-key' } },
      slots: { webSearch: 'tv' },
    });
  };

  it('follows a claim for a stored owner of background work', async () => {
    claimed();
    expect(await serverMediaConnection('webSearch', 'anon:old')).toMatchObject({
      apiKey: 'alice-key',
    });
  });

  it("never reaches the account's credentials from a request's own workspace", async () => {
    claimed();
    expect(await serverMediaConnection('webSearch', 'anon:old', { forward: false })).toBeNull();
    const services = await resolveExtractionServices('anon:old', { forward: false });
    expect(services.document).toBeNull();
    expect(services.documentStatus).toBe('unassigned');
  });
});

describe('document slot and deprecated request fields', () => {
  const request = {
    providerId: 'alidocmind',
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
    baseUrl: 'https://docmind.example',
  };

  it('passes every request field while the slot is unassigned', async () => {
    const services = await resolveExtractionServices();
    expect(services.documentStatus).toBe('unassigned');
    expect(slotGovernedRequest(services, request)).toEqual(request);
  });

  it('keeps only a self-contained extractor once the slot is turned off', async () => {
    workspaces.set('user:alice', { slots: { document: null } });
    const services = await resolveExtractionServices('user:alice', { forward: false });
    expect(services.documentStatus).toBe('disabled');
    expect(slotGovernedRequest(services, request)).toEqual({});
    expect(slotGovernedRequest(services, { providerId: 'unpdf', apiKey: 'k' })).toEqual({
      providerId: 'unpdf',
    });
    expect(slotGovernedRequest(services, { providerId: 'local-ffmpeg' })).toEqual({
      providerId: 'local-ffmpeg',
    });
  });

  it("never lets a request replace a configured slot's service or credentials", async () => {
    workspaces.set('user:alice', {
      providers: { mu: { preset: 'mineru-cloud', apiKey: 'slot-key' } },
      slots: { document: 'mu' },
    });
    const services = await resolveExtractionServices('user:alice', { forward: false });
    expect(services.documentStatus).toBe('configured');
    expect(slotGovernedRequest(services, request)).toEqual({});
    expect(slotGovernedRequest(services, { providerId: 'mineru-cloud', apiKey: 'other' })).toEqual({
      providerId: 'mineru-cloud',
    });
  });
});

describe('slotTTSModel', () => {
  it("keeps a configured slot's own model, whatever the legacy pins say", () => {
    vi.stubEnv('TTS_OPENAI_MODELS', 'tts-1');
    expect(slotTTSModel('openai-tts', 'gpt-4o-mini-tts', 'alloy')).toBe('gpt-4o-mini-tts');
  });

  it('speaks a cloned Qwen voice through the clone model, a catalog voice never', () => {
    const clone = slotTTSModel('qwen-tts', 'qwen3-tts-flash', 'qwen-tts-vc-custom');
    expect(clone).not.toBe('qwen3-tts-flash');
    expect(slotTTSModel('qwen-tts', clone, 'Cherry')).not.toBe(clone);
    expect(slotTTSModel('qwen-tts', 'qwen3-tts-flash', 'Cherry')).toBe('qwen3-tts-flash');
  });
});
