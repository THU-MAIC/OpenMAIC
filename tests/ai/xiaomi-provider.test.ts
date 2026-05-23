import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';
import { supportsConfigurableThinking } from '@/lib/ai/thinking-config';

describe('Xiaomi MiMo provider defaults', () => {
  it('exposes pay-as-you-go and Token Plan OpenAI-compatible endpoints', () => {
    const provider = getProvider('xiaomi');

    expect(provider?.defaultBaseUrl).toBe('https://api.xiaomimimo.com/v1');
    expect(provider?.alternateBaseUrls).toEqual([
      { label: 'settings.baseUrlRegion.xiaomiPayg', url: 'https://api.xiaomimimo.com/v1' },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanCN',
        url: 'https://token-plan-cn.xiaomimimo.com/v1',
      },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanSGP',
        url: 'https://token-plan-sgp.xiaomimimo.com/v1',
      },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanEU',
        url: 'https://token-plan-ams.xiaomimimo.com/v1',
      },
    ]);
  });

  it('matches the supported MiMo text and multimodal model catalog', () => {
    const modelIds = getProvider('xiaomi')?.models.map((model) => model.id) ?? [];

    expect(modelIds).toEqual([
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2-omni',
      'mimo-v2-flash',
    ]);
  });

  it('marks MiMo reasoning models as configurable thinking models', () => {
    const models = getProvider('xiaomi')?.models ?? [];

    for (const model of models) {
      expect(model.capabilities?.thinking?.requestAdapter).toBe('xiaomi');
      expect(supportsConfigurableThinking(model.capabilities?.thinking)).toBe(true);
    }
  });
});
