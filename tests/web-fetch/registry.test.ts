import { describe, expect, it } from 'vitest';
import { WEB_FETCH_PROVIDERS, getWebFetchProvider } from '@/lib/web-fetch/registry';
import { resolveSlot } from '@/lib/server/model-config/resolve-slot';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { modelSettingsView } from '@/lib/server/model-config/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

describe('web fetch registry and configuration', () => {
  it('lists and looks up each provider', () => {
    expect(Object.keys(WEB_FETCH_PROVIDERS)).toEqual(['builtin', 'kimi', 'deepseek', 'firecrawl']);
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
  it('validates and resolves a Firecrawl assignment with its own key', () => {
    const config = parseModelConfig(
      'providers:\n  reader:\n    preset: firecrawl\n    apiKey: test-key\nslots:\n  webFetch: reader\n',
    );
    expect(resolveSlot('webFetch', [{ source: 'deployment', config }])).toMatchObject({
      status: 'assigned',
      registryId: 'firecrawl',
      apiKey: 'test-key',
    });
    // One Firecrawl account serves web search and web fetch.
    expect(getProviderPreset('firecrawl')?.capabilities).toEqual({
      webSearch: { registryId: 'firecrawl' },
      webFetch: { registryId: 'firecrawl' },
    });
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

it.each([true, false])('prevents workspace builtin shadowing with locked=%s', (locked) => {
  const deployment = {
    source: 'deployment' as const,
    config: {
      slots: { webFetch: 'builtin' },
      ...(locked ? { lock: ['webFetch'] as ['webFetch'] } : {}),
    },
  };
  const workspace = {
    source: 'workspace' as const,
    config: { providers: { builtin: { preset: 'kimi', apiKey: 'user-key' } } },
  };
  expect(resolveSlot('webFetch', [deployment, workspace])).toMatchObject({
    registryId: 'builtin',
    providerId: 'builtin',
    providerSource: 'deployment',
    source: locked ? 'locked' : 'default',
  });
  expect(resolveSlot('webFetch', [deployment, workspace])).not.toHaveProperty('apiKey');
  expect(resolveSlot('webFetch', [workspace])).toMatchObject({
    registryId: 'builtin',
    providerSource: 'deployment',
  });
});

it('reserves the implicit builtin id against workspace provider writes', async () => {
  const { applyModelSettingsChange } = await import('@/lib/server/model-config/settings');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  try {
    await expect(
      applyModelSettingsChange(null, {
        kind: 'provider',
        id: 'builtin',
        preset: 'kimi',
        apiKey: 'user-key',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESERVED' });
  } finally {
    setDeploymentConfigForTests();
  }
});

it('keeps registry ids available for workspace providers except the implicit reader', async () => {
  const { newProviderId } = await import('@/lib/model-settings/edit');
  const { serviceEntries } = await import('@/lib/model-settings/services');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  try {
    const view = modelSettingsView(null);
    expect(newProviderId(view, 'kimi')).toBe('kimi');
    expect(newProviderId(view, 'builtin')).toBe('builtin-2');
    expect(
      serviceEntries(
        view,
        'webFetch',
        view.webFetchProviders!.map((provider) => provider.id),
      ).find((entry) => entry.registryId === 'kimi')?.id,
    ).toBe('kimi');
  } finally {
    setDeploymentConfigForTests();
  }
});

it('lets an existing workspace kimi provider rotate or clear its key, edit models and be removed', async () => {
  const { applyModelSettingsChange } = await import('@/lib/server/model-config/settings');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  try {
    const current = {
      providers: { kimi: { preset: 'kimi', apiKey: 'old-key', models: ['kimi-k2.6'] } },
      slots: { llm: 'kimi:kimi-k2.6', webFetch: 'kimi' },
    };
    const rotated = await applyModelSettingsChange(current, {
      kind: 'provider',
      id: 'kimi',
      preset: 'kimi',
      apiKey: 'new-key',
    });
    expect(rotated.providers?.kimi.apiKey).toBe('new-key');
    expect(rotated.slots).toEqual(current.slots);
    const edited = await applyModelSettingsChange(rotated, {
      kind: 'provider',
      id: 'kimi',
      preset: 'kimi',
      models: ['kimi-k2.6', 'custom-model'],
    });
    expect(edited.providers?.kimi.models).toEqual(['kimi-k2.6', 'custom-model']);
    expect(edited.providers?.kimi.apiKey).toBe('new-key');
    const cleared = await applyModelSettingsChange(edited, {
      kind: 'provider',
      id: 'kimi',
      preset: 'kimi',
      apiKey: '',
    });
    expect(cleared.providers?.kimi).not.toHaveProperty('apiKey');
    expect(cleared).not.toHaveProperty('slots');
    const removed = await applyModelSettingsChange(edited, { kind: 'remove-provider', id: 'kimi' });
    expect(removed).not.toHaveProperty('providers');
    expect(removed).not.toHaveProperty('slots');
  } finally {
    setDeploymentConfigForTests();
  }
});

it('keeps a legacy browser kimi provider and its assignments on import', async () => {
  const { buildModelSettingsProposal } = await import('@/lib/legacy-browser-import/model-settings');
  const { importModelSettings } = await import('@/lib/server/model-config/settings');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  try {
    const proposal = buildModelSettingsProposal({
      providerId: 'kimi',
      modelId: 'kimi-k2.6',
      providersConfig: { kimi: { apiKey: 'legacy-key', baseUrl: '' } },
    })!;
    const result = await importModelSettings(null, proposal);
    expect(result.skipped).toEqual([]);
    expect(result.config.providers?.kimi).toEqual({ preset: 'kimi', apiKey: 'legacy-key' });
    expect(result.config.slots?.llm).toBe('kimi:kimi-k2.6');
    expect(result.imported).toEqual([
      { kind: 'provider', id: 'kimi' },
      { kind: 'slot', id: 'llm' },
    ]);
  } finally {
    setDeploymentConfigForTests();
  }
});
