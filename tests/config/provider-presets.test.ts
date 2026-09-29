import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/ai/providers';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { getSlot, isSlotId, type SlotCapability, type SlotId } from '@/lib/config/model-slots';
import { PROVIDER_PRESETS, getProviderPreset } from '@/lib/config/provider-presets';

const REGISTRIES: Record<SlotCapability, Record<string, unknown>> = {
  chat: PROVIDERS,
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
  webSearch: WEB_SEARCH_PROVIDERS,
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
    expect(Object.keys(getProviderPreset('kimi-coding-plan')!.capabilities)).toEqual(['chat']);
  });

  it('carries plan recommendations onto slots', () => {
    const tokendance = getProviderPreset('tokendance')!;
    expect(tokendance.recommended).toMatchObject({
      llm: 'cogevol-base',
      'course.content.slide': 'cogevol-slide-0828',
      'course.content.interactive': 'cogevol-interactive-0828',
    });
    for (const preset of PROVIDER_PRESETS) {
      for (const [slot, model] of Object.entries(preset.recommended ?? {})) {
        expect(isSlotId(slot), `${preset.id} → ${slot}`).toBe(true);
        const capability = getSlot(slot as SlotId).capability;
        const models = preset.capabilities[capability]?.models;
        if (models) expect(models, `${preset.id} → ${slot}`).toContain(model);
      }
    }
  });
});
