import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';
import { supportsConfigurableThinking } from '@/lib/ai/thinking-config';

describe('iFlytek Spark provider defaults', () => {
  it('exposes the Astron MaaS pay-as-you-go and Token Plan endpoints', () => {
    const provider = getProvider('iflytek');

    expect(provider?.type).toBe('openai');
    expect(provider?.defaultBaseUrl).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v2');
    expect(provider?.alternateBaseUrls).toEqual([
      {
        label: 'settings.baseUrlRegion.iflytekPayg',
        url: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
      },
      {
        label: 'settings.baseUrlRegion.iflytekTokenPlan',
        url: 'https://maas-token-api.cn-huabei-1.xf-yun.com/v2',
      },
    ]);
  });

  it('registers Spark X2.5 as a toggleable thinking model with tool support', () => {
    const models = getProvider('iflytek')?.models ?? [];

    expect(models.map((model) => model.id)).toEqual(['spark-x2.5']);
    expect(models[0]).toMatchObject({
      contextWindow: 262144,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
        thinking: {
          control: 'toggle',
          requestAdapter: 'iflytek',
          toggleable: true,
          defaultEnabled: true,
        },
      },
    });
    expect(supportsConfigurableThinking(models[0].capabilities?.thinking)).toBe(true);
  });
});
