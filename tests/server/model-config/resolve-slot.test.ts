import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '@/lib/config/provider-presets';
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
      // The deployment's slots are server defaults: nothing here is locked.
      source: 'default',
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
      source: 'default',
      locked: false,
    });
    const offContent = layer('deployment', 'slots:\n  course.content: null\n');
    expect(resolveSlot('course.content.pbl', [offContent])).toMatchObject({
      status: 'disabled',
      resolvedAt: 'course.content',
      locked: false,
    });
    expect(resolveSlot('image', [deployment])).toEqual({ status: 'unassigned', slot: 'image' });
    expect(resolveSlot('llm', [])).toEqual({ status: 'unassigned', slot: 'llm' });
  });

  it('lets the workspace replace a server default at a node and follow the rest', () => {
    const workspace = layer(
      'workspace',
      'providers:\n  own:\n    preset: deepseek\n    apiKey: k\nslots:\n  course.outline: own:deepseek-v4-flash\n',
    );
    const layers = [deployment, workspace];
    expect(resolveSlot('llm', layers)).toMatchObject({ source: 'default', providerId: 'mm' });
    expect(resolveSlot('course.outline', layers)).toMatchObject({
      source: 'workspace',
      locked: false,
      providerId: 'own',
      modelId: 'deepseek-v4-flash',
    });
    expect(resolveSlot('course.agents', layers)).toMatchObject({
      resolvedAt: 'llm',
      source: 'default',
      providerId: 'mm',
    });
  });

  it('resolves the same whatever order the layers come in', () => {
    const workspace = layer(
      'workspace',
      'providers:\n  mm:\n    preset: deepseek\n    apiKey: other\n  mv:\n    preset: minimax\n    apiKey: other\nslots:\n  llm: mm:deepseek-v4-pro\n  video: mv:MiniMax-Hailuo-2.3\n',
    );
    for (const slot of ['llm', 'video', 'course.content.slide'] as const) {
      expect(resolveSlot(slot, [workspace, deployment])).toEqual(
        resolveSlot(slot, [deployment, workspace]),
      );
    }
    // The workspace's llm names `mm`, which the deployment declares: the
    // deployment's provider answers for it.
    expect(resolveSlot('llm', [workspace, deployment])).toMatchObject({
      source: 'workspace',
      presetId: 'minimax',
      apiKey: 'sk-test',
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

  it('looks up aliases in the catalogue but keeps the configured model id', () => {
    const alias = layer(
      'deployment',
      'providers:\n  o:\n    preset: openai\n    apiKey: k\nslots:\n  agent:\n    model: o:gpt-5.6-sol\n    fallback: o:gpt-5.6-sol\n',
    );
    expect(resolveSlot('agent', [alias])).toMatchObject({
      modelId: 'gpt-5.6-sol',
      requirements: [{ requirement: 'toolCalling', status: 'met' }],
      fallback: { modelId: 'gpt-5.6-sol' },
      fallbackRequirements: [{ requirement: 'toolCalling', status: 'met' }],
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

  it('drops a thinking effort the agent inherits, and only for the agent', () => {
    const inherited = layer(
      'deployment',
      'providers:\n  mm:\n    preset: minimax\n    apiKey: k\nslots:\n  llm:\n    model: mm:MiniMax-M3\n    thinking: { mode: enabled, effort: high, budgetTokens: 2048 }\n',
    );
    expect(resolveSlot('agent', [inherited])).toMatchObject({
      resolvedAt: 'llm',
      thinking: { mode: 'enabled', budgetTokens: 2048 },
    });
    expect(resolveSlot('agent', [inherited])).not.toHaveProperty('thinking.effort');
    // Other slots keep it, and so does the agent's title, which calls no tools.
    expect(resolveSlot('classroom', [inherited])).toMatchObject({
      thinking: { mode: 'enabled', effort: 'high', budgetTokens: 2048 },
    });
    expect(resolveSlot('agent.title', [inherited])).toMatchObject({
      thinking: { effort: 'high' },
    });
  });

  it('leaves the agent no thinking settings when the inherited ones were only an effort', () => {
    const inherited: ModelConfigLayer = {
      source: 'workspace',
      config: {
        providers: { mm: { preset: 'minimax', apiKey: 'k' } },
        slots: { llm: { model: 'mm:MiniMax-M3', thinking: { effort: 'high' } } },
      },
    };
    expect(resolveSlot('agent', [inherited])).not.toHaveProperty('thinking');
  });

  it('fails loudly on a reference no layer can resolve', () => {
    const broken: ModelConfigLayer = {
      source: 'workspace',
      config: { slots: { llm: 'ghost:m' } },
    };
    expect(() => resolveSlot('llm', [broken])).toThrow(SlotResolutionError);
    expect(() => resolveSlot('llm', [broken])).toThrow('slots.llm: the provider is not declared');
    const wrongCapability: ModelConfigLayer = {
      source: 'workspace',
      config: { providers: { k: { preset: 'kimi-coding-plan' } }, slots: { tts: 'k:voice' } },
    };
    expect(() => resolveSlot('tts', [wrongCapability])).toThrow(/does not offer tts/);
    // Built directly so the parser's own checks cannot mask the resolver's.
    const wrongFallback: ModelConfigLayer = {
      source: 'workspace',
      config: {
        providers: { mm: { preset: 'minimax' }, tv: { preset: 'tavily' } },
        slots: { llm: { model: 'mm:MiniMax-M2', fallback: 'tv:search' } },
      } as ModelConfigLayer['config'],
    };
    expect(() => resolveSlot('llm', [wrongFallback])).toThrow(
      /slots\.llm\.fallback: .*does not offer chat/,
    );
  });

  it('does not echo a key pasted into the provider position', () => {
    const secret = 'sk-0123456789abcdef';
    for (const slots of [
      { agent: `${secret}:MiniMax-M3` },
      { agent: { model: 'mm:MiniMax-M3', fallback: `${secret}:MiniMax-M3` } },
    ]) {
      const misplaced: ModelConfigLayer = {
        source: 'workspace',
        config: { providers: { mm: { preset: 'minimax' } }, slots } as ModelConfigLayer['config'],
      };
      expect(() => resolveSlot('agent', [misplaced])).toThrow(/the provider is not declared/);
      try {
        resolveSlot('agent', [misplaced]);
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  it("resolves a provider-only reference to the provider's default model", () => {
    const search: ModelConfigLayer = {
      source: 'deployment',
      config: { providers: { tv: { preset: 'tavily', apiKey: 'k' } }, slots: { webSearch: 'tv' } },
    };
    const resolved = resolveSlot('webSearch', [search]);
    expect(resolved).toMatchObject({ status: 'assigned', registryId: 'tavily', apiKey: 'k' });
    expect(resolved).not.toHaveProperty('modelId');
  });

  it("resolves a provider-only reference to a token plan's own default model", () => {
    const plan = PROVIDER_PRESETS.find(
      (preset) => preset.kind === 'token-plan' && preset.capabilities.video?.defaultModel,
    )!;
    for (const slot of ['video', 'image', 'tts'] as const) {
      const expected = plan.capabilities[slot]?.defaultModel;
      if (!expected) continue;
      const layer: ModelConfigLayer = {
        source: 'deployment',
        config: { providers: { p: { preset: plan.id, apiKey: 'k' } }, slots: { [slot]: 'p' } },
      };
      expect(resolveSlot(slot, [layer])).toMatchObject({ status: 'assigned', modelId: expected });
    }
  });

  it('refuses a fallback on a slot whose calls never use one', () => {
    const layer: ModelConfigLayer = {
      source: 'deployment',
      config: {
        providers: { mm: { preset: 'minimax', apiKey: 'k' } },
        slots: { tts: { model: 'mm:speech-2.8-turbo', fallback: 'mm:speech-2.8-hd' } },
      },
    };
    expect(() => resolveSlot('tts', [layer])).toThrow(
      'slots.tts.fallback: only language model slots use a fallback',
    );
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
      // A key shaped like a provider id reads as a bare reference; either way
      // the error names the path and not the value.
      expect(run).toThrow(
        new RegExp(`^${path.replace('.', '\\.')}: (invalid model reference|a chat model needs)`),
      );
      try {
        run();
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});

describe('resolveSlot with server defaults and locks', () => {
  const providers = `providers:
  mm:
    preset: minimax
    apiKey: \${KEY}
`;
  const own = layer(
    'workspace',
    `providers:
  ds:
    preset: deepseek
    apiKey: k
  mv:
    preset: minimax
    apiKey: k
slots:
  llm: ds:deepseek-v4-pro
  course.content.slide: ds:deepseek-v4-flash
  video: mv:MiniMax-Hailuo-2.3
`,
  );

  it('lets a workspace assignment on a parent leave a server default on its child in place', () => {
    // The child's default is the more specific setting: it wins over the
    // workspace's choice higher up, until the workspace sets the child itself.
    const defaults = layer('deployment', `${providers}slots:\n  course.outline: mm:MiniMax-M2.7\n`);
    expect(resolveSlot('course.outline', [defaults, own])).toMatchObject({
      resolvedAt: 'course.outline',
      source: 'default',
      providerId: 'mm',
    });
    expect(resolveSlot('course.agents', [defaults, own])).toMatchObject({
      resolvedAt: 'llm',
      source: 'workspace',
      providerId: 'ds',
    });
  });

  it('ignores the workspace anywhere inside a locked subtree', () => {
    const locked = layer('deployment', `${providers}slots:\n  llm: mm:MiniMax-M3\nlock: [llm]\n`);
    for (const slot of ['llm', 'course.content', 'course.content.slide', 'agent.title'] as const) {
      expect(resolveSlot(slot, [locked, own])).toMatchObject({
        status: 'assigned',
        resolvedAt: 'llm',
        source: 'locked',
        locked: true,
        providerId: 'mm',
        modelId: 'MiniMax-M3',
      });
    }
    // Other trees are not locked: the workspace's video stands.
    expect(resolveSlot('video', [locked, own])).toMatchObject({
      source: 'workspace',
      locked: false,
    });
  });

  it('resolves a locked subtree from the deployment alone, up to the locked node', () => {
    const locked = layer(
      'deployment',
      `${providers}slots:
  llm: mm:MiniMax-M3
  course.content: mm:MiniMax-M2.7
  course.content.quiz: null
lock: [course.content]
`,
    );
    expect(resolveSlot('course.content.slide', [locked, own])).toMatchObject({
      resolvedAt: 'course.content',
      source: 'locked',
      modelId: 'MiniMax-M2.7',
    });
    expect(resolveSlot('course.content.quiz', [locked, own])).toMatchObject({
      status: 'disabled',
      resolvedAt: 'course.content.quiz',
      source: 'locked',
      locked: true,
    });
    // Above the locked node the workspace still decides.
    expect(resolveSlot('llm', [locked, own])).toMatchObject({ source: 'workspace', locked: false });
  });

  it('locks every slot with lock: all, leaving unwritten roots unconfigured', () => {
    const all = layer('deployment', `${providers}slots:\n  llm: mm:MiniMax-M3\nlock: all\n`);
    expect(resolveSlot('course.content.slide', [all, own])).toMatchObject({
      resolvedAt: 'llm',
      source: 'locked',
      locked: true,
    });
    expect(resolveSlot('video', [all, own])).toEqual({
      status: 'unassigned',
      slot: 'video',
      locked: true,
    });
  });

  it('lets a user turn on a capability that is off by default, but not one locked off', () => {
    const offByDefault = layer('deployment', `${providers}slots:\n  video: null\n`);
    expect(resolveSlot('video', [offByDefault])).toMatchObject({
      status: 'disabled',
      source: 'default',
      locked: false,
    });
    expect(resolveSlot('video', [offByDefault, own])).toMatchObject({
      status: 'assigned',
      source: 'workspace',
      providerId: 'mv',
    });
    const lockedOff = layer('deployment', `${providers}slots:\n  video: null\nlock: [video]\n`);
    expect(resolveSlot('video', [lockedOff, own])).toMatchObject({
      status: 'disabled',
      source: 'locked',
      locked: true,
    });
  });
});
