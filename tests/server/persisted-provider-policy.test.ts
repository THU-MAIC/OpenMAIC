import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerPersistenceProvider: vi.fn(),
  readProviderPolicy: vi.fn(),
  upsertProviderPolicy: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

vi.mock('@/lib/persistence/provider-policy', () => ({
  readProviderPolicy: mocks.readProviderPolicy,
  upsertProviderPolicy: mocks.upsertProviderPolicy,
}));

describe('persisted provider policy resolver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.DATABASE_URL;
    delete process.env.OPENMAIC_LLM_ONLY_PROVIDER;
    delete process.env.OPENMAIC_LLM_ONLY_MODEL;
    delete process.env.OPENMAIC_AUDIO_ONLY_PROVIDER;
    mocks.getServerPersistenceProvider.mockReset();
    mocks.readProviderPolicy.mockReset();
    mocks.upsertProviderPolicy.mockReset();
  });

  it('does not consult a database when persistence is disabled', async () => {
    const { getPersistedProviderPolicy } = await import('@/lib/server/persisted-provider-policy');
    await expect(getPersistedProviderPolicy()).resolves.toBeNull();
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });

  it('uses the persisted row as authoritative', async () => {
    process.env.DATABASE_URL = 'postgres://db';
    const row = {
      scope: 'global',
      llmLocked: true,
      llmProviderId: 'doubao',
      llmModelId: 'doubao-seed-2.0-pro',
      audioLocked: true,
      ttsProviderId: 'doubao-tts',
      asrProviderId: 'doubao-asr',
      updatedAt: null,
    };
    mocks.getServerPersistenceProvider.mockResolvedValue({ pool: {} });
    mocks.readProviderPolicy.mockResolvedValue(row);
    process.env.OPENMAIC_LLM_ONLY_PROVIDER = 'deepseek';
    process.env.OPENMAIC_LLM_ONLY_MODEL = 'deepseek-v4-pro';

    const { getPersistedProviderPolicy } = await import('@/lib/server/persisted-provider-policy');
    await expect(getPersistedProviderPolicy()).resolves.toEqual(row);
    expect(mocks.upsertProviderPolicy).not.toHaveBeenCalled();
  });

  it('seeds the first row from the legacy environment policy', async () => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.OPENMAIC_LLM_ONLY_PROVIDER = 'doubao';
    process.env.OPENMAIC_LLM_ONLY_MODEL = 'doubao-seed-2.0-pro';
    process.env.OPENMAIC_AUDIO_ONLY_PROVIDER = 'doubao';
    mocks.getServerPersistenceProvider.mockResolvedValue({ pool: {} });
    mocks.readProviderPolicy.mockResolvedValueOnce(null).mockResolvedValueOnce({
      scope: 'global',
      llmLocked: true,
      llmProviderId: 'doubao',
      llmModelId: 'doubao-seed-2.0-pro',
      audioLocked: true,
      ttsProviderId: 'doubao-tts',
      asrProviderId: 'doubao-asr',
      updatedAt: null,
    });

    const { getPersistedProviderPolicy } = await import('@/lib/server/persisted-provider-policy');
    const row = await getPersistedProviderPolicy();
    expect(row?.llmProviderId).toBe('doubao');
    expect(mocks.upsertProviderPolicy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        llmLocked: true,
        llmProviderId: 'doubao',
        llmModelId: 'doubao-seed-2.0-pro',
        audioLocked: true,
      }),
    );
  });
});
