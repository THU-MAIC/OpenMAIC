import { WEB_FETCH_PROVIDERS } from '@/lib/web-fetch/registry';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/ai/providers';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import { MODALITY_ORDER, TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { getSlot, isSlotId, type SlotCapability, type SlotId } from '@/lib/config/model-slots';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  presetModels,
  tokenPlanToPreset,
} from '@/lib/config/provider-presets';

const REGISTRIES: Record<SlotCapability, Record<string, unknown>> = {
  chat: PROVIDERS,
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
  webSearch: WEB_SEARCH_PROVIDERS,
  webFetch: WEB_FETCH_PROVIDERS,
  document: PDF_PROVIDERS,
};

describe('provider presets', () => {
  it('has unique ids', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves every registry entry through at least one preset', () => {
    for (const [capability, registry] of Object.entries(REGISTRIES) as [SlotCapability, object][]) {
      for (const registryId of Object.keys(registry)) {
        const served = PROVIDER_PRESETS.some(
          (preset) => preset.capabilities[capability]?.registryId === registryId,
        );
        expect(served, `${capability}/${registryId}`).toBe(true);
      }
    }
  });

  it('only points at registry entries that exist', () => {
    for (const preset of PROVIDER_PRESETS) {
      for (const [capability, target] of Object.entries(preset.capabilities)) {
        const registry = REGISTRIES[capability as SlotCapability];
        expect(
          target!.registryId in registry,
          `${preset.id} → ${capability}/${target!.registryId}`,
        ).toBe(true);
      }
    }
  });

  it('renames registry ids that collide across capabilities', () => {
    expect(getProviderPreset('minimax-search')?.capabilities.webSearch?.registryId).toBe('minimax');
    expect(getProviderPreset('doubao-search')?.capabilities.webSearch?.registryId).toBe('doubao');
    expect(getProviderPreset('lemonade-image')?.capabilities.image?.registryId).toBe('lemonade');
    expect(getProviderPreset('lemonade')?.capabilities.chat?.registryId).toBe('lemonade');
    expect(getProviderPreset('doubao')?.capabilities).toEqual({ chat: { registryId: 'doubao' } });
  });

  it('turns every token plan into a multi-capability preset', () => {
    expect(PROVIDER_PRESETS.filter((preset) => preset.kind === 'token-plan')).toHaveLength(
      TOKEN_PLAN_PRESETS.length,
    );
    const minimax = getProviderPreset('minimax')!;
    expect(minimax.kind).toBe('token-plan');
    expect(Object.keys(minimax.capabilities).sort()).toEqual(
      ['chat', 'image', 'tts', 'video', 'webSearch'].sort(),
    );
    // The coding plan is not the Moonshot open platform, so the chat provider keeps its id.
    expect(getProviderPreset('kimi')?.kind).toBe('single');
    expect(Object.keys(getProviderPreset('kimi-coding-plan')!.capabilities)).toEqual([
      'chat',
      'webSearch',
      'webFetch',
    ]);
    expect(getProviderPreset('kimi')?.capabilities).toEqual({
      chat: { registryId: 'kimi' },
      webSearch: { registryId: 'kimi' },
      webFetch: { registryId: 'kimi', baseUrl: undefined },
    });
  });

  it('offers Firecrawl search and fetch as one shared-account preset', () => {
    expect(PROVIDER_PRESETS.filter((preset) => preset.id === 'firecrawl')).toHaveLength(1);
    expect(getProviderPreset('firecrawl')).toMatchObject({
      kind: 'single',
      capabilities: {
        webSearch: { registryId: 'firecrawl' },
        webFetch: { registryId: 'firecrawl' },
      },
    });
    expect(Object.keys(getProviderPreset('firecrawl')!.capabilities).sort()).toEqual([
      'webFetch',
      'webSearch',
    ]);
  });

  it('carries plan recommendations onto slots', () => {
    const tokendance = getProviderPreset('tokendance')!;
    expect(tokendance.recommended).toMatchObject({
      llm: 'cogevol-base',
      'course.content.slide': 'cogevol-slide-0828',
      'course.content.interactive': 'cogevol-interactive-0828',
      // Web search has no models: the plan's search serves it by itself.
      webSearch: 'bocha',
    });
    expect(getProviderPreset('minimax')!.recommended).toMatchObject({ webSearch: 'minimax' });
    for (const preset of PROVIDER_PRESETS) {
      for (const [slot, model] of Object.entries(preset.recommended ?? {})) {
        expect(isSlotId(slot), `${preset.id} → ${slot}`).toBe(true);
        const capability = getSlot(slot as SlotId).capability;
        const models = preset.capabilities[capability]?.models;
        if (models) expect(models, `${preset.id} → ${slot}`).toContain(model);
      }
    }
  });

  it('offers Ark migration targets with thinking metadata at the plan endpoint', () => {
    const preset = getProviderPreset('volcengine-ark')!;
    expect(preset.capabilities.chat?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/plan/v3');
    const models = presetModels(preset, 'chat');
    for (const id of ['doubao-seed-2.1-lite', 'glm-5.3', 'kimi-k3', 'kimi-k2.8-preview']) {
      const model = models.find((entry) => entry.id === id);
      expect(model, id).toBeDefined();
      expect(model?.capabilities?.thinking?.defaultMode, id).toBe('enabled');
    }
    for (const id of ['glm-5.3', 'kimi-k3', 'kimi-k2.8-preview']) {
      expect(models.find((entry) => entry.id === id)?.capabilities?.thinking?.toggleable, id).toBe(
        false,
      );
    }
    expect(preset.capabilities.chat?.models).not.toContain('glm-5.2');
    expect(preset.recommended?.llm).toBe('doubao-seed-2.1-pro');
  });
});

it('preserves the Coding Plan endpoint for web fetch', () => {
  expect(getProviderPreset('kimi-coding-plan')?.capabilities.webFetch).toEqual({
    registryId: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
  });
});

it('lets any token plan declare a fetch provider and endpoint', () => {
  expect(MODALITY_ORDER).toContain('webFetch');
  const preset = tokenPlanToPreset({
    id: 'fetch-plan',
    name: 'Fetch Plan',
    category: 'token_plan',
    modalities: { webFetch: { providerId: 'kimi', baseUrl: 'https://api.kimi.ai/coding/v1' } },
  });
  expect(preset.capabilities).toEqual({
    webFetch: { registryId: 'kimi', baseUrl: 'https://api.kimi.ai/coding/v1' },
  });
  expect(preset.recommended).toEqual({ webFetch: 'kimi' });
  expect(getProviderPreset('kimi-coding-plan')?.recommended).toMatchObject({
    webFetch: 'kimi',
    webSearch: 'kimi',
  });
  expect(getProviderPreset('kimi')?.recommended).not.toHaveProperty('webFetch');
});

it('shares one DeepSeek account across chat, search and fetch without recommending tool assignments', () => {
  expect(getProviderPreset('deepseek')?.capabilities).toEqual({
    chat: { registryId: 'deepseek' },
    webSearch: { registryId: 'deepseek' },
    webFetch: { registryId: 'deepseek', baseUrl: undefined },
  });
  expect(getProviderPreset('deepseek')?.recommended).toBeUndefined();
});
