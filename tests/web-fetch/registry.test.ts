import { describe, expect, it } from 'vitest';
import { WEB_FETCH_PROVIDERS, getWebFetchProvider } from '@/lib/web-fetch/registry';
import { resolveSlot } from '@/lib/server/model-config/resolve-slot';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { modelSettingsView } from '@/lib/server/model-config/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

describe('web fetch registry and configuration', () => {
  it('lists and looks up each provider', () => {
    expect(Object.keys(WEB_FETCH_PROVIDERS)).toEqual(['builtin', 'kimi']);
    for (const provider of Object.values(WEB_FETCH_PROVIDERS))
      expect(getWebFetchProvider(provider.id)).toBe(provider);
  });
  it.each(['missing', '__proto__', 'constructor'])('does not look up unknown id %s', (id) => {
    expect(getWebFetchProvider(id)).toBeUndefined();
  });
  it('defaults to the keyless reader with no configuration', () => {
    expect(resolveSlot('webFetch', [])).toMatchObject({
      status: 'assigned',
      registryId: 'builtin',
      source: 'default',
    });
  });
  it('retains the default in an omitted locked root', () => {
    expect(
      resolveSlot('webFetch', [{ source: 'deployment', config: { lock: 'all' } }]),
    ).toMatchObject({ status: 'assigned', registryId: 'builtin', source: 'locked', locked: true });
  });
  it('honors explicit null', () => {
    expect(
      resolveSlot('webFetch', [{ source: 'deployment', config: { slots: { webFetch: null } } }]),
    ).toMatchObject({ status: 'disabled' });
  });
  it('validates and resolves a Kimi assignment using existing credentials', () => {
    const config = parseModelConfig(
      'providers:\n  reader:\n    preset: kimi\n    apiKey: test-key\n    baseUrl: https://api.moonshot.cn/v1\nslots:\n  webFetch: reader\n',
    );
    expect(resolveSlot('webFetch', [{ source: 'deployment', config }])).toMatchObject({
      status: 'assigned',
      registryId: 'kimi',
      apiKey: 'test-key',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    expect(getProviderPreset('kimi')?.capabilities).toHaveProperty('chat');
  });
  it('accepts an explicit builtin assignment without credentials', () => {
    expect(parseModelConfig('slots:\n  webFetch: builtin\n').slots?.webFetch).toBe('builtin');
  });
  it.each([
    'slots:\n  webFetch: unknown\n',
    'providers:\n  reader:\n    preset: openai\nslots:\n  webFetch: reader\n',
    'providers:\n  reader:\n    preset: unknown\nslots:\n  webFetch: reader\n',
    'slots:\n  webFetch:\n    model: builtin\n    fallback: builtin\n',
  ])('refuses invalid providers, capabilities and fallbacks', (yaml) => {
    expect(() => parseModelConfig(yaml)).toThrow();
  });
  it('shows the default reader in administrator-configured settings', () => {
    setDeploymentConfigForTests({
      legacy: false,
      notices: [],
      layer: { source: 'deployment', config: { lock: 'all', allowUserKeys: false } },
    });
    try {
      const view = modelSettingsView(null);
      expect(view.providers).toContainEqual(
        expect.objectContaining({
          id: 'builtin',
          capabilities: { webFetch: { models: [], registryId: 'builtin' } },
        }),
      );
      expect(view.slots.find((slot) => slot.slot === 'webFetch')).toMatchObject({
        locked: true,
        effective: { status: 'assigned', registryId: 'builtin' },
      });
    } finally {
      setDeploymentConfigForTests();
    }
  });
});

it('keeps the builtin default when first-run setup adds a hosted reader', async () => {
  const { assignmentsForNewProvider } = await import('@/lib/model-settings/services');
  setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
  try {
    const view = modelSettingsView({
      config: { providers: { reader: { preset: 'kimi', apiKey: 'test-key' } } },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(
      view.providers.find((provider) => provider.id === 'reader')?.capabilities,
    ).toHaveProperty('webFetch');
    expect(assignmentsForNewProvider(view, 'reader')).not.toHaveProperty('webFetch');
  } finally {
    setDeploymentConfigForTests();
  }
});

it('allows workspace selection of the builtin reader', async () => {
  const { applyModelSettingsChange } = await import('@/lib/server/model-config/settings');
  setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
  try {
    const config = await applyModelSettingsChange(null, {
      kind: 'slots',
      set: { webFetch: 'builtin' },
    });
    expect(resolveSlot('webFetch', [{ source: 'workspace', config }])).toMatchObject({
      status: 'assigned',
      registryId: 'builtin',
      source: 'workspace',
    });
  } finally {
    setDeploymentConfigForTests();
  }
});

it('allows official workspace reader endpoints and refuses custom ones', async () => {
  const { applyModelSettingsChange } = await import('@/lib/server/model-config/settings');
  setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
  try {
    for (const baseUrl of ['https://api.moonshot.cn/v1', 'https://api.kimi.com/coding/v1']) {
      const current = { providers: { reader: { preset: 'kimi', apiKey: 'test-key', baseUrl } } };
      const config = await applyModelSettingsChange(current, {
        kind: 'slots',
        set: { webFetch: 'reader' },
      });
      expect(resolveSlot('webFetch', [{ source: 'workspace', config }])).toMatchObject({
        status: 'assigned',
        registryId: 'kimi',
        baseUrl,
      });
      expect(
        modelSettingsView({ config, revision: 1, unreadableSecrets: [] }).providers.find(
          (provider) => provider.id === 'reader',
        )?.capabilities,
      ).toHaveProperty('webFetch');
    }
    const current = {
      providers: {
        reader: { preset: 'kimi', apiKey: 'test-key', baseUrl: 'https://custom.example/v1' },
      },
    };
    await expect(
      applyModelSettingsChange(current, { kind: 'slots', set: { webFetch: 'reader' } }),
    ).rejects.toThrow(/workspace provider with its own endpoint/);
    expect(
      modelSettingsView({ config: current, revision: 1, unreadableSecrets: [] }).providers.find(
        (provider) => provider.id === 'reader',
      )?.capabilities,
    ).not.toHaveProperty('webFetch');
  } finally {
    setDeploymentConfigForTests();
  }
});

it('exposes the keyless default through the media/tool connection resolver', async () => {
  const { resolveMediaSlot } = await import('@/lib/server/model-config/media');
  setDeploymentConfigForTests({ legacy: false, notices: [], layer: null });
  try {
    expect(await resolveMediaSlot('webFetch', { workspaceId: null })).toMatchObject({
      providerId: 'builtin',
      managed: true,
    });
  } finally {
    setDeploymentConfigForTests();
  }
});
