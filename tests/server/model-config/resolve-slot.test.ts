import { describe, expect, it } from 'vitest';
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
      // Inheriting a deployment value does not lock the slot itself.
      locked: false,
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
      locked: false,
    });
    expect(resolveSlot('course.content', [offContent])).toMatchObject({ locked: true });
    expect(resolveSlot('llm', [deployment])).toMatchObject({ locked: true });
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

  function agentOn(preset: string, model: string, extra = '') {
    return layer(
      'deployment',
      `providers:\n  p:\n    preset: ${preset}\n    apiKey: k\n    baseUrl: http://host/v1\n${extra}slots:\n  agent: p:${model}\n`,
    );
  }

  it.each([
    ['atlascloud', 'qwen/qwen3.5-flash', 'unmet'],
    ['tokendance', 'deepseek-v4-pro', 'met'],
    ['tokendance', 'cogevol-base', 'unknown'],
    ['kimi-coding-plan', 'kimi-for-coding', 'unknown'],
    ['atlascloud', 'not-in-the-catalogue', 'unknown'],
  ])('reads tool calling for %s:%s from the catalogue as %s', (preset, model, status) => {
    expect(resolveSlot('agent', [agentOn(preset, model)])).toMatchObject({
      requirements: [{ requirement: 'toolCalling', status }],
    });
  });

  it('does not trust the catalogue for a custom OpenAI-compatible endpoint', () => {
    // gpt-5.6 is in the OpenAI catalogue with tools, but this endpoint only speaks the protocol.
    expect(resolveSlot('agent', [agentOn('openai-compatible', 'gpt-5.6')])).toMatchObject({
      catalogue: false,
      requirements: [{ requirement: 'toolCalling', status: 'unknown' }],
    });
    expect(resolveSlot('agent', [agentOn('openai', 'gpt-5.6')])).toMatchObject({
      requirements: [{ requirement: 'toolCalling', status: 'met' }],
    });
  });

  it('checks the fallback against the slot’s requirements too', () => {
    const agent = layer(
      'deployment',
      'providers:\n  mm:\n    preset: minimax\n    apiKey: k\n  ac:\n    preset: atlascloud\n    apiKey: k\nslots:\n  agent:\n    model: mm:MiniMax-M3\n    fallback: ac:qwen/qwen3.5-flash\n',
    );
    expect(resolveSlot('agent', [agent])).toMatchObject({
      requirements: [{ requirement: 'toolCalling', status: 'met' }],
      fallbackRequirements: [{ requirement: 'toolCalling', status: 'unmet' }],
    });
    // No requirements, no fallback checks.
    expect(resolveSlot('course.content.slide', [deployment])).not.toHaveProperty(
      'fallbackRequirements',
    );
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

  it('reports a malformed reference by path, without echoing it', () => {
    const secret = 'sk-misplaced-key-9c1e';
    for (const [slots, path] of [
      [{ agent: secret }, 'slots.agent'],
      [{ llm: { model: secret } }, 'slots.llm'],
      [{ llm: { model: 'mm:MiniMax-M3', fallback: secret } }, 'slots.llm.fallback'],
    ] as const) {
      const malformed: ModelConfigLayer = {
        source: 'workspace',
        config: { providers: { mm: { preset: 'minimax' } }, slots } as ModelConfigLayer['config'],
      };
      const run = () =>
        resolveSlot(slots === undefined ? 'llm' : (Object.keys(slots)[0] as 'llm'), [malformed]);
      expect(run).toThrow(SlotResolutionError);
      expect(run).toThrow(`${path}: invalid model reference`);
      try {
        run();
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});
