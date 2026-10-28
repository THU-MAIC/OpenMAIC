import { describe, expect, it } from 'vitest';

import { getModel, getModelInfo, getProvider } from '@/lib/ai/providers';
import { getProviderPreset, presetModels } from '@/lib/config/provider-presets';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { checkRequirement } from '@/lib/server/model-config/resolve-slot';
import type { ProviderId } from '@/lib/types/provider';

/** 1k = 1024 tokens, matching the DeepSeek and Kimi catalog rows. */
const K = 1024;

/**
 * Agent Plan chat ids whose vendor docs (套餐概览, 2026-10-19) say they accept
 * images, with that page's context and max output. Rows that already exist in
 * another provider's catalog keep that row's stored counts when they encode
 * the same limits.
 */
const VISION_ON: Record<string, { contextWindow: number; outputWindow?: number }> = {
  // 1024k / 256k. Not the dated direct snapshot (256k / 32k).
  'doubao-seed-2.1-pro': { contextWindow: 1024 * K, outputWindow: 256 * K },
  // Model list: doubao-seed-2-1-lite is 多模态理解. Plan table: 1024k / 256k.
  'doubao-seed-2.1-lite': { contextWindow: 1024 * K, outputWindow: 256 * K },
  // Model list: doubao-seed-2-0-mini-260428 is 多模态理解. Plan table: 256k / 128k.
  'doubao-seed-2.0-mini': { contextWindow: 256 * K, outputWindow: 128 * K },
  // 原生多模态. Plan table 1024k / 128k, not MiniMax-M3's 32k output.
  'minimax-m3': { contextWindow: 1024 * K, outputWindow: 128 * K },
  // 原生支持视觉理解. Kimi catalog already stores 1024k / 128k.
  'kimi-k3': { contextWindow: 1024 * K, outputWindow: 128 * K },
  // 支持文本和图片输入. Plan table: 1024k / 1024k. Callers forward
  // outputWindow as max_tokens and do not subtract the prompt, so a cap equal
  // to the context window is omitted.
  'kimi-k2.8-preview': { contextWindow: 1024 * K },
  // 支持多模态视觉理解. Kimi catalog stores 256k context as 256000 and 32k output as 32768.
  'kimi-k2.7-code': { contextWindow: 256_000, outputWindow: 32 * K },
};

/**
 * Plan ids the same docs do not describe as image input.
 * `ark-code-latest` is a console router, not one model, so it has no single window.
 * `glm-5.3` keeps the GLM catalog's 1_000_000 / 128_000 encoding of 1024k / 128k.
 */
const VISION_OFF: Record<string, { contextWindow?: number; outputWindow?: number }> = {
  'ark-code-latest': {},
  'deepseek-v4-pro': { contextWindow: 1024 * K, outputWindow: 384 * K },
  'deepseek-v4-flash': { contextWindow: 1024 * K, outputWindow: 384 * K },
  'glm-5.3': { contextWindow: 1_000_000, outputWindow: 128_000 },
};

const ARK_CHAT_IDS = [...Object.keys(VISION_ON), ...Object.keys(VISION_OFF)];

describe('Ark Agent Plan model metadata', () => {
  it('resolves model info for every token-plan chat model', () => {
    for (const plan of TOKEN_PLAN_PRESETS) {
      const llm = plan.modalities.llm;
      if (!llm?.defaultModels?.length) continue;
      for (const modelId of llm.defaultModels) {
        const info = getModelInfo(llm.providerId as ProviderId, modelId);
        expect(info, `${plan.id} ${modelId}`).toBeTruthy();
      }
    }
  });

  it('covers every Volcengine Ark chat id in the vision cases', () => {
    const ark = TOKEN_PLAN_PRESETS.find((plan) => plan.id === 'volcengine-ark')!;
    expect(new Set(ARK_CHAT_IDS)).toEqual(new Set(ark.modalities.llm!.defaultModels));
  });

  it.each(Object.entries(VISION_ON))(
    'reports image input and plan windows for %s',
    (modelId, windows) => {
      const info = getModelInfo('doubao', modelId);
      expect(info).toMatchObject({
        contextWindow: windows.contextWindow,
        capabilities: { vision: true, tools: true },
      });
      expect(info?.outputWindow).toBe(windows.outputWindow);
    },
  );

  it.each(Object.entries(VISION_OFF))('does not report image input for %s', (modelId, windows) => {
    const info = getModelInfo('doubao', modelId);
    expect(info?.capabilities?.vision).toBe(false);
    expect(info?.capabilities?.tools).toBe(true);
    expect(info?.contextWindow).toBe(windows.contextWindow);
    expect(info?.outputWindow).toBe(windows.outputWindow);
  });

  it('sends the plan id on the wire and still attaches catalog metadata', () => {
    const { model, modelInfo } = getModel({
      providerId: 'doubao',
      modelId: 'doubao-seed-2.1-pro',
      apiKey: 'ark-test',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    });

    // Doubao uses the OpenAI-compatible SDK model, whose wire id is `modelId`.
    // LanguageModel also includes plain strings, so the field is read through a cast.
    expect((model as { modelId: string }).modelId).toBe('doubao-seed-2.1-pro');
    expect(modelInfo).toMatchObject({
      contextWindow: 1024 * K,
      outputWindow: 256 * K,
      capabilities: { vision: true },
    });
  });

  it('keeps a saved glm-5.2 id on the glm-5.3 catalog row', () => {
    expect(getModelInfo('doubao', 'glm-5.2')).toMatchObject({
      id: 'glm-5.3',
      capabilities: { vision: false },
      contextWindow: 1_000_000,
      outputWindow: 128_000,
    });
  });

  it('shows plan capabilities in the Ark preset catalogue without dropping doubao thinking', () => {
    const models = presetModels(getProviderPreset('volcengine-ark')!, 'chat');
    expect(models.find((model) => model.id === 'doubao-seed-2.1-pro')?.capabilities?.vision).toBe(
      true,
    );
    expect(models.find((model) => model.id === 'glm-5.3')?.capabilities?.vision).toBe(false);
    expect(models.find((model) => model.id === 'kimi-k3')).toMatchObject({
      id: 'kimi-k3',
      contextWindow: 1024 * K,
      capabilities: {
        vision: true,
        thinking: { toggleable: false, requestAdapter: 'doubao' },
      },
    });
    expect(models.find((model) => model.id === 'ark-code-latest')?.contextWindow).toBeUndefined();
  });

  it('treats Ark chat models as able to call tools', () => {
    expect(
      checkRequirement('toolCalling', 'chat', {
        registryId: 'doubao',
        modelId: 'kimi-k3',
      }).status,
    ).toBe('met');
    expect(
      checkRequirement('toolCalling', 'chat', {
        registryId: 'doubao',
        modelId: 'doubao-seed-2.1-pro',
      }).status,
    ).toBe('met');
  });

  it('does not add aliased cross-vendor ids to the direct Doubao list', () => {
    const ids = getProvider('doubao')!.models.map((model) => model.id);
    expect(ids).not.toContain('kimi-k3');
    expect(ids).not.toContain('glm-5.3');
    expect(ids).not.toContain('deepseek-v4-pro');
    expect(ids).not.toContain('kimi-k2.7-code');
    expect(ids).toContain('doubao-seed-2-1-pro-260628');
  });

  it('keeps plan-only ids off the direct Kimi and Doubao presets', () => {
    const directKimi = presetModels(getProviderPreset('kimi')!, 'chat').map((model) => model.id);
    const directDoubao = presetModels(getProviderPreset('doubao')!, 'chat').map(
      (model) => model.id,
    );
    const kimiRegistry = getProvider('kimi')!.models.map((model) => model.id);
    const doubaoRegistry = getProvider('doubao')!.models.map((model) => model.id);

    for (const id of ['k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']) {
      expect(directKimi, id).not.toContain(id);
      expect(kimiRegistry, id).not.toContain(id);
      expect(getModelInfo('kimi', id)?.contextWindow, id).toBeGreaterThan(0);
    }

    for (const id of [
      'doubao-seed-2.1-pro',
      'doubao-seed-2.1-lite',
      'doubao-seed-2.0-mini',
      'ark-code-latest',
      'deepseek-v4-flash',
      'minimax-m3',
      'kimi-k2.8-preview',
    ]) {
      expect(directDoubao, id).not.toContain(id);
      expect(doubaoRegistry, id).not.toContain(id);
    }

    const ark = presetModels(getProviderPreset('volcengine-ark')!, 'chat').map((model) => model.id);
    expect(ark).toEqual(
      expect.arrayContaining(['doubao-seed-2.1-pro', 'kimi-k2.8-preview', 'ark-code-latest']),
    );
    const coding = presetModels(getProviderPreset('kimi-coding-plan')!, 'chat').map(
      (model) => model.id,
    );
    expect(coding).toEqual(
      expect.arrayContaining(['k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']),
    );

    expect(getModelInfo('doubao', 'gpt-5.6')).toBeUndefined();
  });
});
