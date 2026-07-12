/**
 * Regression: applying a token plan then writing probed models (two separate
 * setProviderConfig calls) must NOT drop the first write's fields. Reproduces
 * the "custom token plan kept models but lost apiKey" report.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';
import { applyTokenPlan } from '@/lib/config/apply-token-plan';
import type { TokenPlanPreset } from '@/lib/config/token-plan-presets';

const CUSTOM_ID = 'custom-tokenplan-test';

const preset: TokenPlanPreset = {
  id: CUSTOM_ID,
  name: 'My Plan',
  category: 'third_party',
  modalities: {
    llm: { providerId: CUSTOM_ID, baseUrl: 'https://gw.example.com/v1', apiFormat: 'openai' },
  },
};

describe('token plan apply + probe model write', () => {
  beforeEach(() => {
    // Remove any leftover custom provider from a previous run.
    const s = useSettingsStore.getState();
    const next = { ...s.providersConfig };
    delete (next as Record<string, unknown>)[CUSTOM_ID];
    s.setProvidersConfig(next);
  });

  it('keeps apiKey/baseUrl/type after a models-only follow-up write', () => {
    const store = useSettingsStore.getState();

    // Step 1: apply fills key + baseUrl + type (what applyTokenPlan does).
    applyTokenPlan(preset, 'sk-secret', {
      setProviderConfig: store.setProviderConfig,
      setImageProviderConfig: store.setImageProviderConfig,
      setVideoProviderConfig: store.setVideoProviderConfig,
      setTTSProviderConfig: store.setTTSProviderConfig,
      setWebSearchProviderConfig: store.setWebSearchProviderConfig,
    });

    let cfg = useSettingsStore.getState().providersConfig[CUSTOM_ID as never] as
      | { apiKey?: string; baseUrl?: string; type?: string; models?: unknown[] }
      | undefined;
    expect(cfg?.apiKey).toBe('sk-secret');
    expect(cfg?.baseUrl).toBe('https://gw.example.com/v1');

    // Step 2: probe success writes ONLY models (what handleApply does next).
    useSettingsStore.getState().setProviderConfig(
      CUSTOM_ID as never,
      {
        models: [
          { id: 'm1', name: 'm1' },
          { id: 'm2', name: 'm2' },
        ],
      } as never,
    );

    cfg = useSettingsStore.getState().providersConfig[CUSTOM_ID as never] as typeof cfg;
    // The key must survive the models-only merge.
    expect(cfg?.apiKey).toBe('sk-secret');
    expect(cfg?.baseUrl).toBe('https://gw.example.com/v1');
    expect(cfg?.models).toHaveLength(2);
  });
});
