import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planCapabilityStates } from '@/components/settings/plan-capabilities';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { applyModelSettingsChange, modelSettingsView } from '@/lib/server/model-config/settings';

const deployment = (config: ModelConfigLayer['config'] | null) =>
  setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    legacy: false,
    notices: [],
  });

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment(null);
});
afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

const minimaxIntl = TOKEN_PLAN_PRESETS.find((plan) => plan.id === 'minimax-intl')!;
const kimiIntl = TOKEN_PLAN_PRESETS.find((plan) => plan.id === 'kimi-intl')!;

async function workspace(slots: Record<string, string | null>) {
  let config = await applyModelSettingsChange(
    null,
    { kind: 'provider', id: 'minimax-intl', preset: 'minimax-intl', apiKey: 'sk-cp-go-0001' },
    { unsupportedCapabilities: ['video'] },
  );
  config = await applyModelSettingsChange(config, {
    kind: 'provider',
    id: 'kimi-intl',
    preset: 'kimi-intl',
    apiKey: 'sk-kimi-0001',
  });
  config = await applyModelSettingsChange(config, { kind: 'slots', set: slots });
  return modelSettingsView({ config, revision: 1, unreadableSecrets: [] });
}

describe('plan capability cards', () => {
  it('reads what the plan offers apart from where each default goes', async () => {
    const view = await workspace({
      llm: 'minimax-intl:MiniMax-M3',
      image: null,
      webFetch: 'kimi-intl',
    });
    const provider = view.providers.find((entry) => entry.id === 'minimax-intl');
    const states = Object.fromEntries(
      planCapabilityStates(view, minimaxIntl, provider).map((state) => [state.capability, state]),
    );
    expect(states.chat).toMatchObject({
      offer: 'included',
      route: { kind: 'this', modelId: 'MiniMax-M3' },
    });
    // Offered, but turned off.
    expect(states.image).toMatchObject({ offer: 'included', route: { kind: 'off' } });
    // The tier lacks it.
    expect(states.video.offer).toBe('not-in-tier');
    // Not set by anyone.
    expect(states.tts).toMatchObject({ offer: 'included', route: { kind: 'unset' } });
    // Not offered by the plan; another plan serves it.
    expect(states.webFetch).toMatchObject({
      offer: 'not-offered',
      route: { kind: 'other', providerId: 'kimi-intl' },
    });
  });

  it('a plan not connected yet offers what its preset declares', async () => {
    const view = await workspace({});
    const states = planCapabilityStates(view, kimiIntl, undefined);
    expect(states.map((state) => [state.capability, state.offer])).toEqual([
      ['chat', 'included'],
      ['image', 'not-offered'],
      ['video', 'not-offered'],
      ['tts', 'not-offered'],
      ['webSearch', 'included'],
      ['webFetch', 'included'],
    ]);
  });
});
