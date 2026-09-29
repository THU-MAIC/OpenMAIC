import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { resolveSlot } from '@/lib/server/model-config/resolve-slot';
import type { StageRoute } from '@/lib/server/model-routes';
import type { ServerConfig } from '@/lib/server/provider-config';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    providers: {},
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
    disabled: {
      tts: new Set(),
      asr: new Set(),
      image: new Set(),
      video: new Set(),
      webSearch: new Set(),
    },
    ...overrides,
  };
}

const withProviders = server({
  providers: {
    openai: { apiKey: 'sk-openai', models: ['gpt-5.6'], proxy: 'http://127.0.0.1:7890' },
    deepseek: { apiKey: 'sk-ds' },
    ollama: { apiKey: '', baseUrl: 'http://ollama:11434/v1' },
  },
  tts: { 'minimax-tts': { apiKey: 'sk-mm' } },
  webSearch: { minimax: { apiKey: 'sk-mm' }, tavily: { apiKey: 'tv' } },
  image: { lemonade: { apiKey: '', baseUrl: 'http://lemonade:8000' } },
  pdf: { alidocmind: { apiKey: '', accessKeyId: 'ak', accessKeySecret: 'sk' } },
});

const noDisabled = (): ServerConfig['disabled'] => ({
  tts: new Set(),
  asr: new Set(),
  image: new Set(),
  video: new Set(),
  webSearch: new Set(),
});

describe('translateLegacyConfig: providers', () => {
  it('declares every configured provider under its preset id', () => {
    const { config, notices } = translateLegacyConfig(withProviders);
    expect(notices).toEqual([]);
    expect(config.providers).toEqual({
      openai: {
        preset: 'openai',
        apiKey: 'sk-openai',
        models: ['gpt-5.6'],
        proxy: 'http://127.0.0.1:7890',
      },
      deepseek: { preset: 'deepseek', apiKey: 'sk-ds' },
      ollama: { preset: 'ollama', baseUrl: 'http://ollama:11434/v1' },
      'minimax-tts': { preset: 'minimax-tts', apiKey: 'sk-mm' },
      'minimax-search': { preset: 'minimax-search', apiKey: 'sk-mm' },
      tavily: { preset: 'tavily', apiKey: 'tv' },
      'lemonade-image': { preset: 'lemonade-image', baseUrl: 'http://lemonade:8000' },
      alidocmind: {
        preset: 'alidocmind',
        credentials: { accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
    });
  });

  it('leaves out switched-off providers and says the switch does not carry over', () => {
    const disabled = server({
      webSearch: { tavily: { apiKey: 'tv' }, bocha: { apiKey: 'bc' } },
      disabled: {
        ...noDisabled(),
        webSearch: new Set(['tavily']),
        tts: new Set(['browser-native-tts']),
      },
    });
    const { config, notices } = translateLegacyConfig(disabled);
    expect(Object.keys(config.providers ?? {})).toEqual(['bocha']);
    expect(notices).toEqual([
      'tts.browser-native-tts is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null',
      'webSearch.tavily is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null',
    ]);
  });

  it('leaves out entries the new schema rejects, naming fields and not values', () => {
    const { config, notices } = translateLegacyConfig(
      server({
        providers: {
          azure: { apiKey: 'sk-azure' },
          openai: { apiKey: 'sk-openai', baseUrl: 'sk-pasted-here' },
          deepseek: { apiKey: 'sk-ds' },
        },
      }),
    );
    expect(Object.keys(config.providers ?? {})).toEqual(['deepseek']);
    expect(notices).toEqual([
      'providers.azure is not carried over: it needs a base URL',
      'providers.openai is not carried over: invalid baseUrl',
    ]);
  });
});

describe('translateLegacyConfig: models', () => {
  const route = (model: string, extra: Partial<StageRoute> = {}): StageRoute => ({
    model,
    ...extra,
  });
  const driver = (model: string, extra: Partial<StageRoute> = {}) =>
    route(model, { api: 'openai-completions', ...extra });

  it('puts DEFAULT_MODEL on the llm root and keeps the unrouted agent off', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
    });
    expect(notices).toEqual([]);
    expect(config.slots).toEqual({ llm: 'openai:gpt-5.6', agent: null });
    const layers = [{ source: 'deployment' as const, config }];
    expect(resolveSlot('agent', layers)).toMatchObject({ status: 'disabled' });
    expect(resolveSlot('agent.title', layers)).toMatchObject({ status: 'disabled' });
  });

  it('leaves the agent open when there is no server model at all', () => {
    expect(translateLegacyConfig(withProviders).config.slots).toBeUndefined();
  });

  it('leaves a model whose provider has no server configuration to the browser', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'anthropic:claude',
    });
    expect(config.slots).toBeUndefined();
    expect(notices).toEqual([
      'DEFAULT_MODEL uses provider "anthropic" without server configuration; it is left to the browser',
    ]);
  });

  it('never repeats a credential pasted into a model variable', () => {
    const secret = 'sk-live-0123456789';
    const { notices } = translateLegacyConfig(withProviders, {
      defaultModel: `${secret}:m`,
      globalFallback: `${secret}:m`,
      stageRoutes: {
        'scene-actions': route(`${secret}:m`),
        'agent-profiles': route('openai:gpt-5.6', { fallback: `${secret}:m` }),
        'maic-agent-driver': driver(`${secret}:m`),
      },
    });
    expect(notices.length).toBeGreaterThanOrEqual(5);
    for (const notice of notices) expect(notice).not.toContain(secret);
  });

  it('maps stage routes onto their slots, keeping options', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: {
        'scene-content:slide': route('deepseek:deepseek-v4-pro', { thinking: { enabled: false } }),
        'scene-outlines-stream': route('deepseek:deepseek-v4-flash', {
          fallback: 'openai:gpt-5.6',
        }),
        'maic-agent-driver': driver('deepseek:deepseek-v4-pro', {
          api: 'openai-responses',
          contextWindow: 200000,
          fallback: 'openai:gpt-5.6',
        }),
      },
    });
    expect(notices).toEqual([]);
    expect(config.slots).toEqual({
      llm: 'openai:gpt-5.6',
      'course.content.slide': { model: 'deepseek:deepseek-v4-pro', thinking: { enabled: false } },
      'course.outline': { model: 'deepseek:deepseek-v4-flash', fallback: 'openai:gpt-5.6' },
      // The driver runs outside callLLM: no fallback.
      agent: { model: 'deepseek:deepseek-v4-pro', api: 'openai-responses', contextWindow: 200000 },
      // Unrouted titles reuse the driver's model with thinking off.
      'agent.title': { model: 'deepseek:deepseek-v4-pro', thinking: { mode: 'disabled' } },
    });
  });

  it('keeps the agent off when its route would not work today', () => {
    for (const [bad, reason] of [
      [route('deepseek-v4-pro', { api: 'openai-completions' }), 'its model has no provider prefix'],
      [route('deepseek:deepseek-v4-pro'), 'its api is not openai-completions or openai-responses'],
      [
        driver('deepseek:deepseek-v4-pro', { thinking: { effort: 'high' } }),
        'it sets thinking.effort',
      ],
    ] as const) {
      const { config, notices } = translateLegacyConfig(withProviders, {
        defaultModel: 'openai:gpt-5.6',
        stageRoutes: { 'maic-agent-driver': bad },
      });
      expect(config.slots).toEqual({ llm: 'openai:gpt-5.6', agent: null });
      expect(notices).toEqual([
        `MODEL_ROUTES (maic-agent-driver) is not usable today (${reason}); the agent slot stays off`,
      ]);
    }
  });

  it('gives a routed title thinking off by default and the usual fallback', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: { 'conversation-title': route('deepseek:deepseek-v4-flash') },
    });
    expect(config.slots).toMatchObject({
      agent: null,
      'agent.title': {
        model: 'deepseek:deepseek-v4-flash',
        thinking: { mode: 'disabled' },
        fallback: 'deepseek:deepseek-v4-flash',
      },
    });
    // A title under a switched-off agent still resolves: it is assigned itself.
    expect(resolveSlot('agent.title', [{ source: 'deployment', config }])).toMatchObject({
      status: 'assigned',
      modelId: 'deepseek-v4-flash',
    });
  });

  it('assigns a shared slot only when all of its stages agree', () => {
    const pbl = route('deepseek:deepseek-v4-pro');
    const allClassroom = {
      'chat-adapter': pbl,
      'quiz-grade': pbl,
      'pbl-v2-runtime': pbl,
      'pbl-v2-runtime:instructor': pbl,
      'pbl-v2-runtime:open-task': pbl,
      'pbl-v2-runtime:evaluate': pbl,
      'pbl-v2-runtime:simulator': pbl,
    };
    expect(
      translateLegacyConfig(withProviders, { stageRoutes: allClassroom }).config.slots,
    ).toEqual({
      classroom: 'deepseek:deepseek-v4-pro',
    });

    // Only the PBL runtime is routed: chat and grading still use the default
    // model, which one classroom slot cannot express.
    const pblOnly = { 'pbl-v2-runtime': pbl, 'pbl-v2-runtime:instructor': pbl };
    const { config, notices } = translateLegacyConfig(withProviders, { stageRoutes: pblOnly });
    expect(config.slots).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^MODEL_ROUTES gives the stages that now share the slot classroom different models/,
    );
  });

  it('lets a scene type inherit when it only follows the scene-content route', () => {
    const content = route('deepseek:deepseek-v4-pro');
    const { config } = translateLegacyConfig(withProviders, {
      stageRoutes: {
        'scene-content': content,
        'scene-content:slide': content,
        'scene-content:quiz': content,
        'scene-content:interactive': route('openai:gpt-5.6'),
        'scene-content:pbl': content,
      },
    });
    expect(config.slots).toEqual({
      'course.content': 'deepseek:deepseek-v4-pro',
      'course.content.interactive': 'openai:gpt-5.6',
    });
  });

  it('keeps unrouted stages on DEFAULT_MODEL under a routed parent', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: {
        'scene-content': route('deepseek:deepseek-v4-pro'),
        'scene-content:slide': route('deepseek:deepseek-v4-pro'),
        'scene-content:quiz': route('deepseek:deepseek-v4-pro'),
      },
    });
    expect(notices).toEqual([]);
    expect(config.slots).toEqual({
      llm: 'openai:gpt-5.6',
      'course.content': 'deepseek:deepseek-v4-pro',
      // Neither had a route (not even through scene-content in this fixture).
      'course.content.interactive': 'openai:gpt-5.6',
      'course.content.pbl': 'openai:gpt-5.6',
      agent: null,
    });
    const layers = [{ source: 'deployment' as const, config }];
    expect(resolveSlot('course.content.pbl', layers)).toMatchObject({ modelId: 'gpt-5.6' });
    expect(resolveSlot('course.outline', layers)).toMatchObject({ modelId: 'gpt-5.6' });
  });

  it('reports stages that used the browser but would inherit a server route', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      stageRoutes: { 'generate-classroom': route('deepseek:deepseek-v4-pro') },
    });
    expect(config.slots).toEqual({ llm: 'deepseek:deepseek-v4-pro', agent: null });
    expect(notices).toEqual([
      "course.research, course.outline, course.agents, course.content, course.content.slide, course.content.quiz, course.content.interactive, course.content.pbl, course.actions, classroom used the browser's model and now inherit a server model; set them in openmaic.yml to change that",
    ]);
  });

  it('keeps DEFAULT_MODEL on llm when generate-classroom is routed elsewhere', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: { 'generate-classroom': route('deepseek:deepseek-v4-pro') },
    });
    expect(config.slots).toEqual({ llm: 'openai:gpt-5.6', agent: null });
    expect(notices).toEqual([
      'MODEL_ROUTES.generate-classroom differs from DEFAULT_MODEL; DEFAULT_MODEL is kept for the llm slot',
    ]);
  });

  it('applies MODEL_FALLBACK where a route has no fallback of its own', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: {
        'scene-actions': route('deepseek:deepseek-v4-pro'),
        'agent-profiles': route('deepseek:deepseek-v4-pro', { fallback: 'openai:gpt-5.6' }),
      },
    });
    expect(config.slots).toEqual({
      llm: { model: 'openai:gpt-5.6', fallback: 'deepseek:deepseek-v4-flash' },
      'course.actions': {
        model: 'deepseek:deepseek-v4-pro',
        fallback: 'deepseek:deepseek-v4-flash',
      },
      'course.agents': { model: 'deepseek:deepseek-v4-pro', fallback: 'openai:gpt-5.6' },
      agent: null,
    });
  });

  it('does not put MODEL_FALLBACK in place of a route fallback that cannot carry over', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: {
        // Same model as the default, but a different retry: must not inherit.
        'scene-actions': route('openai:gpt-5.6', { fallback: 'anthropic:claude' }),
      },
    });
    expect(config.slots?.['course.actions']).toBe('openai:gpt-5.6');
    expect(notices).toEqual([
      'MODEL_ROUTES (scene-actions) fallback uses provider "anthropic" without server configuration; it is left to the browser',
    ]);
  });

  it('drops what the new schema rejects instead of failing', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: {
        'scene-actions': route('deepseek:deepseek-v4-pro', {
          thinking: { budgetTokens: 0 },
          // Driver-only options are inert elsewhere today.
          api: 'openai-completions',
          contextWindow: 1000,
        }),
        'maic-agent-driver': driver('deepseek:deepseek-v4-pro', { contextWindow: 1.5 }),
      },
    });
    expect(config.slots).toMatchObject({
      'course.actions': 'deepseek:deepseek-v4-pro',
      agent: { model: 'deepseek:deepseek-v4-pro', api: 'openai-completions' },
    });
    expect(notices).toEqual([
      'MODEL_ROUTES (scene-actions): thinking is not carried over (invalid budgetTokens)',
      'MODEL_ROUTES (maic-agent-driver): contextWindow is not carried over (not a positive integer)',
    ]);
    expect(parseModelConfig(yaml.dump(config), { env: {} })).toEqual(config);
  });
});

describe('translateLegacyConfig output', () => {
  it('is a valid openmaic.yml that resolves the same models', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: {
        'scene-content:slide': { model: 'deepseek:deepseek-v4-pro' },
        'maic-agent-driver': { model: 'deepseek:deepseek-v4-pro', api: 'openai-completions' },
        'conversation-title': { model: 'openai:gpt-5.6', thinking: { mode: 'enabled' } },
      },
    });
    const reparsed = parseModelConfig(yaml.dump(config), { env: {} });
    expect(reparsed).toEqual(config);
    const layers = [{ source: 'deployment' as const, config: reparsed }];
    expect(resolveSlot('course.outline', layers)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      fallback: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    });
    expect(resolveSlot('course.content.slide', layers)).toMatchObject({
      modelId: 'deepseek-v4-pro',
    });
    expect(resolveSlot('agent', layers)).toMatchObject({
      modelId: 'deepseek-v4-pro',
      api: 'openai-completions',
    });
    expect(resolveSlot('agent', layers)).not.toHaveProperty('fallback');
    expect(resolveSlot('agent.title', layers)).toMatchObject({
      modelId: 'gpt-5.6',
      thinking: { mode: 'enabled' },
    });
  });
});
