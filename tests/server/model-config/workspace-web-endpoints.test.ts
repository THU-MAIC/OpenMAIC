import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMediaSlot, WorkspaceEndpointError } from '@/lib/server/model-config/media';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import {
  setDeploymentConfigForTests,
  setWorkspaceLayerLoaderForTests,
} from '@/lib/server/model-config/runtime';
import { applyModelSettingsChange, modelSettingsView } from '@/lib/server/model-config/settings';

beforeEach(() => {
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
});

afterEach(() => {
  setDeploymentConfigForTests();
  setWorkspaceLayerLoaderForTests();
});

function workspace(preset: string, baseUrl: string): ModelConfigFile {
  const config = { providers: { account: { preset, apiKey: 'test-key', baseUrl } } };
  setWorkspaceLayerLoaderForTests(async () => ({ source: 'workspace', config }));
  return config;
}

describe.each(['webSearch', 'webFetch'] as const)('%s workspace endpoints', (slot) => {
  describe.each([
    ['deepseek', 'https://api.deepseek.com'],
    ['deepseek', 'https://api.deepseek.com/v1'],
    ['kimi', 'https://api.moonshot.cn/v1'],
    ['kimi', 'https://api.moonshot.ai/v1'],
    ['kimi', 'https://api.kimi.com/coding/v1'],
    ['kimi', 'https://api.kimi.ai/coding/v1'],
    ['kimi-coding-plan', 'https://api.moonshot.cn/v1'],
  ])('%s at %s', (preset, officialBaseUrl) => {
    it.each(['', '/', '///'])('resolves the official endpoint with suffix "%s"', async (suffix) => {
      const baseUrl = officialBaseUrl + suffix;
      const config = workspace(preset, baseUrl);
      config.slots = { [slot]: 'account' };
      await expect(resolveMediaSlot(slot, { workspaceId: 'user:alice' })).resolves.toMatchObject({
        providerId: preset === 'deepseek' ? 'deepseek' : 'kimi',
        apiKey: 'test-key',
        baseUrl,
        managed: false,
        userEndpoint: false,
      });
    });

    it.each(['', '/', '///'])(
      'saves and offers the official endpoint with suffix "%s"',
      async (suffix) => {
        const config = await applyModelSettingsChange(workspace(preset, officialBaseUrl + suffix), {
          kind: 'slots',
          set: { [slot]: 'account' },
        });
        expect(config.slots).toHaveProperty(slot, 'account');
        const account = modelSettingsView({
          config,
          revision: 1,
          unreadableSecrets: [],
        }).providers.find((provider) => provider.id === 'account');
        expect(account?.capabilities).toHaveProperty(slot);
      },
    );
  });

  describe.each(['deepseek', 'kimi', 'kimi-coding-plan'])('%s custom endpoints', (preset) => {
    it.each([
      'https://gateway.example/v1',
      'https://api.deepseek.com.evil.example/v1',
      'https://api.moonshot.cn.evil.example/v1',
      'https://api.deepseek.com/v1/custom',
      'https://api.moonshot.cn/v1/custom',
    ])('refuses resolution and saving at %s', async (baseUrl) => {
      const config = workspace(preset, baseUrl);
      config.slots = { [slot]: 'account' };
      await expect(resolveMediaSlot(slot, { workspaceId: 'user:alice' })).rejects.toBeInstanceOf(
        WorkspaceEndpointError,
      );
      await expect(
        applyModelSettingsChange(config, { kind: 'slots', set: { [slot]: 'account' } }),
      ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
      const account = modelSettingsView({
        config,
        revision: 1,
        unreadableSecrets: [],
      }).providers.find((provider) => provider.id === 'account');
      expect(account?.capabilities).not.toHaveProperty(slot);
    });
  });
});
