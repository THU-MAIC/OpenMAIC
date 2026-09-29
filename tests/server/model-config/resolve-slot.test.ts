import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/ai/providers';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import {
  SlotResolutionError,
  resolveSlot,
  type ModelConfigLayer,
} from '@/lib/server/model-config/resolve-slot';

const env = { KEY: 'sk-test' };

function layer(source: ModelConfigLayer['source'], text: string): ModelConfigLayer {
  return { source, config: parseModelConfig(text, { env }) };
}

const deployment = layer(
  'deployment',
  `
providers:
  mm:
    preset: minimax
    apiKey: \${KEY}
  td:
    preset: tokendance
    apiKey: \${KEY}
slots:
  llm: mm:MiniMax-M3
  course.content.slide:
    model: td:cogevol-slide-0828
    fallback: mm:MiniMax-M2.7
    thinking: { enabled: false }
  video: null
`,
);

describe('resolveSlot', () => {
  it('inherits from the nearest assigned ancestor', () => {
    const outline = resolveSlot('course.outline', [deployment]);
    expect(outline).toMatchObject({
      status: 'assigned',
      slot: 'course.outline',
      resolvedAt: 'llm',
      source: 'deployment',
      locked: true,
      providerId: 'mm',
      presetId: 'minimax',
      registryId: 'minimax',
      apiKey: 'sk-test',
      modelId: 'MiniMax-M3',
      capability: 'chat',
    });
    // Two levels up: the quiz page follows course.content, which follows llm.
    expect(resolveSlot('course.content.quiz', [deployment])).toMatchObject({ resolvedAt: 'llm' });
  });

  it('uses the slot’s own assignment with its options, fallback and the preset endpoint', () => {
    const slide = resolveSlot('course.content.slide', [deployment]);
    expect(slide).toMatchObject({
      status: 'assigned',
      resolvedAt: 'course.content.slide',
      providerId: 'td',
      registryId: 'tokendance',
      baseUrl: 'https://tokendance.space/gateway/v1',
      modelId: 'cogevol-slide-0828',
      thinking: { enabled: false },
      fallback: { providerId: 'mm', registryId: 'minimax', modelId: 'MiniMax-M2.7' },
    });
  });

  it('prefers a provider’s own base URL over the preset’s', () => {
    const own = layer(
      'deployment',
      'providers:\n  td:\n    preset: tokendance\n    baseUrl: https://proxy.example/v1\nslots:\n  llm: td:cogevol-base\n',
    );
    expect(resolveSlot('llm', [own])).toMatchObject({ baseUrl: 'https://proxy.example/v1' });
  });

  it('disables a subtree at an explicit null and leaves an unassigned root unassigned', () => {
    expect(resolveSlot('video', [deployment])).toEqual({
      status: 'disabled',
      slot: 'video',
      resolvedAt: 'video',
      source: 'deployment',
      locked: true,
    });
    const offContent = layer('deployment', 'slots:\n  course.content: null\n');
    expect(resolveSlot('course.content.pbl', [offContent])).toMatchObject({
      status: 'disabled',
      resolvedAt: 'course.content',
    });
    expect(resolveSlot('image', [deployment])).toEqual({ status: 'unassigned', slot: 'image' });
    expect(resolveSlot('llm', [])).toEqual({ status: 'unassigned', slot: 'llm' });
  });

  it('lets the deployment win at a node and the workspace fill the rest', () => {
    const workspace = layer(
      'workspace',
      'providers:\n  own:\n    preset: deepseek\n    apiKey: k\nslots:\n  llm: own:deepseek-v4-pro\n  course.outline: own:deepseek-v4-flash\n',
    );
    const layers = [deployment, workspace];
    expect(resolveSlot('llm', layers)).toMatchObject({ source: 'deployment', providerId: 'mm' });
    expect(resolveSlot('course.outline', layers)).toMatchObject({
      source: 'workspace',
      locked: false,
      providerId: 'own',
      modelId: 'deepseek-v4-flash',
    });
    expect(resolveSlot('course.agents', layers)).toMatchObject({
      resolvedAt: 'llm',
      providerId: 'mm',
    });
  });

  it('does not let a workspace shadow a provider the deployment declares', () => {
    const workspace = layer(
      'workspace',
      'providers:\n  mm:\n    preset: deepseek\n    apiKey: other\nslots:\n  course.outline: mm:MiniMax-M2.7\n',
    );
    expect(resolveSlot('course.outline', [deployment, workspace])).toMatchObject({
      providerId: 'mm',
      presetId: 'minimax',
      apiKey: 'sk-test',
    });
  });

  it('checks only the requested slot’s requirements, against the model it resolves to', () => {
    expect(resolveSlot('agent', [deployment])).toMatchObject({
      resolvedAt: 'llm',
      requirements: [{ requirement: 'toolCalling', status: 'met' }],
    });
    expect(resolveSlot('agent.title', [deployment])).toMatchObject({ requirements: [] });
    expect(resolveSlot('llm', [deployment])).toMatchObject({ requirements: [] });
  });

  it('reports unmet and unknown tool calling from the model catalogue', () => {
    const [registryId, noTools] = Object.entries(PROVIDERS)
      .flatMap(([id, provider]) => (provider.models ?? []).map((model) => [id, model] as const))
      .find(([, model]) => model.capabilities?.tools === false)!;
    const withRegistry = (model: string) =>
      layer(
        'deployment',
        `providers:\n  p:\n    preset: ${registryId}\n    apiKey: k\n    baseUrl: http://host/v1\nslots:\n  agent: p:${model}\n`,
      );
    expect(resolveSlot('agent', [withRegistry(noTools.id)])).toMatchObject({
      requirements: [{ requirement: 'toolCalling', status: 'unmet' }],
    });
    expect(resolveSlot('agent', [withRegistry('not-in-the-catalogue')])).toMatchObject({
      requirements: [{ requirement: 'toolCalling', status: 'unknown' }],
    });
  });

  it('keeps agent driver parameters', () => {
    const agent = layer(
      'deployment',
      'providers:\n  mm:\n    preset: minimax\n    apiKey: k\nslots:\n  agent:\n    model: mm:MiniMax-M3\n    api: anthropic-messages\n    contextWindow: 200000\n',
    );
    expect(resolveSlot('agent', [agent])).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 200000,
    });
  });

  it('fails loudly on a reference no layer can resolve', () => {
    const broken: ModelConfigLayer = {
      source: 'workspace',
      config: { slots: { llm: 'ghost:m' } },
    };
    expect(() => resolveSlot('llm', [broken])).toThrow(SlotResolutionError);
    expect(() => resolveSlot('llm', [broken])).toThrow(
      'slots.llm: provider "ghost" is not declared',
    );
    const wrongCapability: ModelConfigLayer = {
      source: 'workspace',
      config: { providers: { k: { preset: 'kimi-coding-plan' } }, slots: { tts: 'k:voice' } },
    };
    expect(() => resolveSlot('tts', [wrongCapability])).toThrow(/does not offer tts/);
  });
});
