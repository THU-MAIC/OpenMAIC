import { describe, expect, it, vi } from 'vitest';
import {
  activeTokenPlansInPriorityOrder,
  applyTokenPlan,
  isTokenPlanActive,
  isTokenPlanUsable,
  removeTokenPlan,
  restoreSharedProviderCredentials,
  seedPlanModels,
  setTokenPlanAuthorization,
  type TokenPlanActions,
  type TokenPlanEnrollmentState,
} from '@/lib/config/apply-token-plan';
import { TOKEN_PLAN_PRESETS, type TokenPlanPreset } from '@/lib/config/token-plan-presets';

function makeActions(): TokenPlanActions {
  return {
    setProviderConfig: vi.fn(),
    setImageProviderConfig: vi.fn(),
    setVideoProviderConfig: vi.fn(),
    setTTSProviderConfig: vi.fn(),
    setWebSearchProviderConfig: vi.fn(),
    setModel: vi.fn(),
    setImageProvider: vi.fn(),
    setImageModelId: vi.fn(),
    setStageRoute: vi.fn(),
    setTTSProvider: vi.fn(),
    setWebSearchProvider: vi.fn(),
    getStageRoutes: vi.fn(() => ({})),
    setTokenPlanEnrolled: vi.fn(),
    setTokenPlanEnabled: vi.fn(),
    setTokenPlanSeedVersion: vi.fn(),
    getTokenPlanEnrollments: vi.fn(() => ({})),
  };
}

const minimax = TOKEN_PLAN_PRESETS.find((p) => p.id === 'minimax')!;
// An LLM-only plan shape. The shipped presets are all multi-modal token plans
// now, so use a local fixture to exercise the "only touch declared modalities"
// path without coupling to a particular shipped entry.
const deepseek: TokenPlanPreset = {
  id: 'deepseek',
  name: 'DeepSeek',
  category: 'third_party',
  modalities: {
    llm: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' },
  },
};

describe('applyTokenPlan', () => {
  it('fills one gateway key into every modality for TokenDance', () => {
    const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
    const actions = makeActions();
    const results = applyTokenPlan(tokendance, 'sk-td', actions);

    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'tokendance',
      expect.objectContaining({
        apiKey: 'sk-td',
        baseUrl: 'https://tokendance.space/gateway/v1',
        type: 'openai',
      }),
    );
    // Model catalogue is seeded in a separate (credentials-free) write.
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'tokendance',
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'cogevol-base' }),
          expect.objectContaining({ id: 'deepseek-v4.1-flash', contextWindow: 1000000 }),
        ]),
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'seedream',
      expect.objectContaining({
        apiKey: 'sk-td',
        baseUrl: 'https://tokendance.space/gateway/ark/v3',
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'seedream',
      expect.objectContaining({
        customModels: expect.arrayContaining([
          { id: 'seedream-5.0-lite', name: 'seedream-5.0-lite' },
        ]),
        replaceBuiltInModels: true,
      }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({
        apiKey: 'sk-td',
        baseUrl: 'https://tokendance.space/gateway/minimax',
      }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({
        customModels: expect.arrayContaining([{ id: 'minimax-h3', name: 'minimax-h3' }]),
        replaceBuiltInModels: true,
      }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({
        apiKey: 'sk-td',
        baseUrl: 'https://tokendance.space/gateway/minimax',
        enabled: true,
      }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ modelId: 'minimax-speech-2.8-turbo' }),
    );
    expect(actions.setWebSearchProviderConfig).toHaveBeenCalledWith(
      'bocha',
      expect.objectContaining({
        apiKey: 'sk-td',
        baseUrl: 'https://tokendance.space/gateway/bocha',
      }),
    );
    // The plan's recommended mainline model + per-stage routes are seeded as the
    // default course model configuration (courseware / interactive).
    expect(actions.setModel).toHaveBeenCalledWith('tokendance', 'cogevol-base');
    expect(actions.setStageRoute).toHaveBeenCalledWith('scene-content:slide', {
      providerId: 'tokendance',
      modelId: 'cogevol-slide-0828',
    });
    expect(actions.setStageRoute).toHaveBeenCalledWith('scene-content:interactive', {
      providerId: 'tokendance',
      modelId: 'cogevol-interactive-0828',
    });
    expect(actions.setStageRoute).not.toHaveBeenCalledWith('maic-agent-driver', expect.anything());
    // TTS / web search become the active selections so the pipeline reflects
    // the plan's models out of the box.
    expect(actions.setTTSProvider).toHaveBeenCalledWith('minimax-tts');
    expect(actions.setWebSearchProvider).toHaveBeenCalledWith('bocha');
    expect(results.map((r) => [r.modality, r.status])).toEqual([
      ['llm', 'lit'],
      ['image', 'lit'],
      ['video', 'lit'],
      ['tts', 'lit'],
      ['webSearch', 'lit'],
    ]);
  });

  it('fills every declared modality for a full-set plan (MiniMax)', () => {
    const actions = makeActions();
    const results = applyTokenPlan(minimax, 'sk-test', actions);

    // LLM provider config: apiKey + baseUrl + type + custom name
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({
        apiKey: 'sk-test',
        baseUrl: 'https://api.minimaxi.com/anthropic/v1',
        type: 'anthropic',
      }),
    );
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({
            id: 'MiniMax-M3',
            contextWindow: 1000000,
            capabilities: expect.objectContaining({ vision: true }),
          }),
        ]),
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'minimax-image',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'minimax-image',
      expect.objectContaining({ replaceBuiltInModels: true }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({ replaceBuiltInModels: true }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ modelId: 'speech-2.8-turbo' }),
    );
    expect(actions.setWebSearchProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true }),
    );

    // Result reports each declared modality as lit, and includes llm.
    const lit = results.filter((r) => r.status === 'lit').map((r) => r.modality);
    expect(lit).toEqual(expect.arrayContaining(['llm', 'image', 'video', 'tts', 'webSearch']));
  });

  it('only touches declared modalities for an LLM-only plan (DeepSeek)', () => {
    const actions = makeActions();
    const results = applyTokenPlan(deepseek, 'sk-ds', actions);

    expect(actions.setProviderConfig).toHaveBeenCalledTimes(1);
    expect(actions.setImageProviderConfig).not.toHaveBeenCalled();
    expect(actions.setVideoProviderConfig).not.toHaveBeenCalled();
    expect(actions.setTTSProviderConfig).not.toHaveBeenCalled();
    expect(actions.setWebSearchProviderConfig).not.toHaveBeenCalled();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ modality: 'llm', status: 'lit' });
  });

  it('passes modelsUrl through to the LLM provider config when present', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'x',
          baseUrl: 'https://x.com/v1',
          apiFormat: 'openai' as const,
          modelsUrl: 'https://x.com/custom/models',
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ modelsUrl: 'https://x.com/custom/models' }),
    );
  });

  it('seeds defaultModels into the LLM provider config when present', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'x',
          baseUrl: 'https://x.com/api/plan/v1',
          apiFormat: 'anthropic' as const,
          defaultModels: ['ark-code-latest', 'kimi-k2.5'],
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    const calls = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { models?: Array<{ id: string }> }]
    >;
    const seeded = calls.find(([, cfg]) => Array.isArray(cfg.models));
    expect(seeded?.[1].models?.map((m) => m.id)).toEqual(['ark-code-latest', 'kimi-k2.5']);
  });

  it('enriches seeded models with their built-in thinking capability', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'doubao',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
          apiFormat: 'openai' as const,
          // dotted plan alias of a native Doubao Seed 2.0 model + a cross-vendor
          // model the Ark plan serves through its OpenAI-compatible endpoint
          defaultModels: ['doubao-seed-2.0-pro', 'deepseek-v4-pro'],
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    const calls = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { models?: Array<{ id: string; capabilities?: { thinking?: unknown } }> }]
    >;
    const cfg = calls.find(([, c]) => Array.isArray(c.models))![1];
    // Both keep thinking support instead of silently dropping it.
    expect(cfg.models![0].capabilities?.thinking).toBeDefined();
    expect(cfg.models![1].capabilities?.thinking).toBeDefined();
  });

  it('preserves GPT-5.6 Sol catalog metadata when a plan uses the explicit model ID', () => {
    const actions = makeActions();
    const preset: TokenPlanPreset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiFormat: 'openai',
          defaultModels: ['gpt-5.6-sol'],
        },
      },
    };

    applyTokenPlan(preset, 'sk-test', actions);
    const calls = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
      [
        string,
        {
          models?: Array<{
            id: string;
            contextWindow?: number;
            outputWindow?: number;
            capabilities?: { vision?: boolean; thinking?: unknown };
          }>;
        },
      ]
    >;
    const config = calls.find(([, c]) => Array.isArray(c.models))![1];
    const seeded = config.models!;

    expect(seeded[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: { vision: true },
    });
    expect(seeded[0].capabilities?.thinking).toBeDefined();
  });

  it('isolates a failing modality without aborting the rest', () => {
    const actions = makeActions();
    (actions.setImageProviderConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    const results = applyTokenPlan(minimax, 'sk', actions);

    const image = results.find((r) => r.modality === 'image');
    expect(image?.status).toBe('failed');
    // Other modalities still lit
    expect(results.find((r) => r.modality === 'llm')?.status).toBe('lit');
    expect(results.find((r) => r.modality === 'tts')?.status).toBe('lit');
  });
});

describe('removeTokenPlan', () => {
  it('drops the stage routes this plan seeded on removal, keeping user-repointed ones', () => {
    const actions = makeActions();
    actions.getStageRoutes = vi.fn(() => ({
      'scene-content:slide': { providerId: 'tokendance' },
      'scene-content:quiz': { providerId: 'other-provider' },
    }));
    const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
    removeTokenPlan(tokendance, actions);

    expect(actions.setStageRoute).toHaveBeenCalledWith('scene-content:slide', null);
    expect(actions.setStageRoute).not.toHaveBeenCalledWith('scene-content:quiz', null);
  });

  it('restores the built-in LLM provider + disables every declared modality (MiniMax)', () => {
    const actions = makeActions();
    removeTokenPlan(minimax, actions);

    // Built-in LLM provider: restored to its registry defaults (not just key
    // cleared), so it no longer points at the plan endpoint / plan model ids.
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        isBuiltIn: true,
        modelsUrl: undefined,
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'minimax-image',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ apiKey: '', baseUrl: '', enabled: false }),
    );
    expect(actions.setWebSearchProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({ apiKey: '', baseUrl: '', enabled: false }),
    );
  });

  it('falls back to clearing only the key for a non-built-in LLM provider', () => {
    const actions = makeActions();
    const custom: TokenPlanPreset = {
      id: 'custom-plan',
      name: 'Custom',
      category: 'third_party',
      modalities: {
        llm: {
          providerId: 'not-a-real-provider',
          baseUrl: 'https://x.com/v1',
          apiFormat: 'openai',
        },
      },
    };
    removeTokenPlan(custom, actions);
    expect(actions.setProviderConfig).toHaveBeenCalledWith('not-a-real-provider', { apiKey: '' });
  });
});

describe('token plan enrollment bookkeeping', () => {
  it('isTokenPlanActive requires the explicit enrollment marker, not just a key', async () => {
    const { isTokenPlanActive } = await import('@/lib/config/apply-token-plan');
    const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
    // Personal key on the shared provider, never enrolled — must be inactive
    // (the old apiKey-sniffing heuristic hijacked exactly this state).
    expect(
      isTokenPlanActive(tokendance, {
        tokenPlanEnrollments: {},
        providersConfig: { tokendance: { apiKey: 'sk-personal' } },
      }),
    ).toBe(false);
    // Enrolled + key present — active.
    expect(
      isTokenPlanActive(tokendance, {
        tokenPlanEnrollments: { tokendance: 'tokendance' },
        providersConfig: { tokendance: { apiKey: 'sk-plan' } },
      }),
    ).toBe(true);
    // Enrolled but the key was cleared elsewhere — inactive.
    expect(
      isTokenPlanActive(tokendance, {
        tokenPlanEnrollments: { tokendance: 'tokendance' },
        providersConfig: { tokendance: {} },
      }),
    ).toBe(false);
    // Enrolled onto a DIFFERENT provider — inactive.
    expect(
      isTokenPlanActive(tokendance, {
        tokenPlanEnrollments: { tokendance: 'other' },
        providersConfig: { tokendance: { apiKey: 'sk-plan' } },
      }),
    ).toBe(false);
  });

  it('applyTokenPlan records enrollment and the seed fingerprint on success', () => {
    const actions = makeActions();
    applyTokenPlan(minimax, 'sk-mm', actions);

    expect(actions.setTokenPlanEnrolled).toHaveBeenCalledWith('minimax', 'minimax');
    expect(actions.setTokenPlanSeedVersion).toHaveBeenCalledWith('minimax', expect.any(String));
  });

  it('applyTokenPlan records enrollment even when seeding throws, but not the fingerprint', () => {
    const actions = makeActions();
    // Seed path throws after credentials are written (setModel is inside seeding).
    actions.setModel = vi.fn(() => {
      throw new Error('seed boom');
    });
    const results = applyTokenPlan(minimax, 'sk-mm', actions);

    // Credentials still applied.
    expect(results.some((r) => r.modality === 'llm' && r.status === 'lit')).toBe(true);
    // Enrolled (connected), but the fingerprint is NOT recorded so the next
    // startup reconciliation retries the seed.
    expect(actions.setTokenPlanEnrolled).toHaveBeenCalledWith('minimax', 'minimax');
    expect(actions.setTokenPlanSeedVersion).not.toHaveBeenCalled();
  });

  it('applyTokenPlan does not seed a modality whose credential write failed', () => {
    const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
    const actions = makeActions();
    actions.setImageProviderConfig = vi.fn(() => {
      throw new Error('image write boom');
    });

    applyTokenPlan(tokendance, 'sk-td', actions);

    // Image apply failed → its seeding (customModels + active selection) must
    // not run, or the selection would point at a keyless provider.
    const imageWrites = (actions.setImageProviderConfig as unknown as ReturnType<typeof vi.fn>).mock
      .calls as Array<[string, Record<string, unknown>]>;
    expect(imageWrites.every(([, cfg]) => !('customModels' in (cfg ?? {})))).toBe(true);
    expect(actions.setImageProvider).not.toHaveBeenCalled();
    expect(actions.setImageModelId).not.toHaveBeenCalled();
    // LLM seeding is unaffected.
    expect(actions.setModel).toHaveBeenCalledWith('tokendance', 'cogevol-base');
  });

  it('applyTokenPlan writes enabled:true for the LLM provider (connect = authorize)', () => {
    const actions = makeActions();
    applyTokenPlan(minimax, 'sk-mm', actions);

    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({ apiKey: 'sk-mm', enabled: true }),
    );
  });

  it('removeTokenPlan un-enrolls, clears the fingerprint, and skips providers another enrolled plan owns', () => {
    const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
    const actions = makeActions();
    // volcengine-ark (still enrolled) also rides `seedream` and shares the
    // seeded stage-route provider with… no: its LLM is doubao, but its image
    // provider is seedream — the shared case the guard must protect.
    actions.getTokenPlanEnrollments = vi.fn(() => ({ 'volcengine-ark': 'doubao' }));
    actions.getStageRoutes = vi.fn(() => ({
      'scene-content:slide': { providerId: 'tokendance' },
    }));

    removeTokenPlan(tokendance, actions);

    expect(actions.setTokenPlanEnrolled).toHaveBeenCalledWith('tokendance', null);
    expect(actions.setTokenPlanSeedVersion).toHaveBeenCalledWith('tokendance', null);
    // Own LLM routes are dropped.
    expect(actions.setStageRoute).toHaveBeenCalledWith('scene-content:slide', null);
    // LLM credentials restored/cleared (tokendance is owned by nobody else).
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'tokendance',
      expect.objectContaining({ apiKey: '' }),
    );
    // seedream is owned by the still-enrolled volcengine-ark — its image
    // credentials must NOT be cleared.
    const seedreamWrites = (
      (actions.setImageProviderConfig as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, { apiKey?: string }]
      >
    ).filter(([id]) => id === 'seedream');
    expect(seedreamWrites).toHaveLength(0);
  });
});

describe('授权开关（启用此套餐）', () => {
  const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
  const ark = TOKEN_PLAN_PRESETS.find((p) => p.id === 'volcengine-ark')!;

  const enrolledState = (
    overrides?: Partial<TokenPlanEnrollmentState>,
  ): TokenPlanEnrollmentState => ({
    tokenPlanEnrollments: {
      tokendance: 'tokendance',
      'volcengine-ark': ark.modalities.llm!.providerId,
    },
    providersConfig: {
      tokendance: { apiKey: 'sk-td' },
      [ark.modalities.llm!.providerId]: { apiKey: 'sk-ark' },
    },
    ...overrides,
  });

  it('isTokenPlanUsable：已连接且未被关闭才算可用', () => {
    const state = enrolledState();
    expect(isTokenPlanActive(tokendance, state)).toBe(true);
    expect(isTokenPlanUsable(tokendance, state)).toBe(true);

    const off = enrolledState({ tokenPlanDisabled: { tokendance: true } });
    // 关闭只影响授权层：连接状态仍然成立，页面还要显示「已连接（未启用）」。
    expect(isTokenPlanActive(tokendance, off)).toBe(true);
    expect(isTokenPlanUsable(tokendance, off)).toBe(false);
  });

  it('未连接的套餐即便没被关闭也不可用', () => {
    const state: TokenPlanEnrollmentState = {
      tokenPlanEnrollments: {},
      providersConfig: {},
    };
    expect(isTokenPlanUsable(tokendance, state)).toBe(false);
  });

  it('关闭套餐会把各模态 provider 的 enabled 置为 false', () => {
    const actions = makeActions();
    const state = enrolledState({ tokenPlanDisabled: { tokendance: true } });
    setTokenPlanAuthorization(tokendance, false, actions, state);

    expect(actions.setProviderConfig).toHaveBeenCalledWith('tokendance', { enabled: false });
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith('minimax-video', {
      enabled: false,
    });
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith('minimax-tts', { enabled: false });
  });

  it('关闭时跳过仍被其他生效套餐占用的共享 provider', () => {
    const actions = makeActions();
    // tokendance 关了，volcengine-ark 仍生效；两者共用 seedream 图像 provider。
    const state = enrolledState({ tokenPlanDisabled: { tokendance: true } });
    setTokenPlanAuthorization(tokendance, false, actions, state);

    const seedreamWrites = (
      (actions.setImageProviderConfig as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >
    ).filter(([id]) => id === 'seedream');
    expect(seedreamWrites).toHaveLength(0);
    // 自己独占的模态照常关闭。
    expect(actions.setProviderConfig).toHaveBeenCalledWith('tokendance', { enabled: false });
  });

  it('重新开启会把各模态 provider 的 enabled 置回 true', () => {
    const actions = makeActions();
    setTokenPlanAuthorization(tokendance, true, actions, enrolledState());
    expect(actions.setProviderConfig).toHaveBeenCalledWith('tokendance', { enabled: true });
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith('minimax-tts', { enabled: true });
  });
});

describe('授权标志的生命周期（跨断开-重连不残留）', () => {
  const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;

  it('连接即重新授权：applyTokenPlan 清掉可能残留的「已关闭」标记', () => {
    const actions = makeActions();
    applyTokenPlan(tokendance, 'sk-td', actions);
    expect(actions.setTokenPlanEnabled).toHaveBeenCalledWith('tokendance', true);
  });

  it('部分失败（无模态点亮）时不写授权标记', () => {
    const actions = makeActions();
    actions.setProviderConfig = vi.fn(() => {
      throw new Error('llm write failed');
    });
    const deepseekLike = {
      ...tokendance,
      modalities: { llm: tokendance.modalities.llm },
    };
    applyTokenPlan(deepseekLike, 'sk-x', actions);
    expect(actions.setTokenPlanEnabled).not.toHaveBeenCalled();
  });

  it('解除连接时清掉授权标志，避免下一连接周期以 Connected (off) 回来', () => {
    const actions = makeActions();
    actions.getTokenPlanEnrollments = vi.fn(() => ({ tokendance: 'tokendance' }));
    removeTokenPlan(tokendance, actions);
    expect(actions.setTokenPlanEnabled).toHaveBeenCalledWith('tokendance', true);
  });

  it('「关开关→断开」后内置 provider 的 enabled 被恢复为 true', () => {
    const actions = makeActions();
    removeTokenPlan(tokendance, actions);
    const llmRestores = (
      (actions.setProviderConfig as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, Record<string, unknown>]
      >
    ).filter(([id, cfg]) => id === 'tokendance' && 'isBuiltIn' in cfg);
    expect(llmRestores).toHaveLength(1);
    expect(llmRestores[0][1].enabled).toBe(true);
  });
});

describe('多套餐优先级（按 TOKEN_PLAN_PRESETS 顺序）', () => {
  const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
  const ark = TOKEN_PLAN_PRESETS.find((p) => p.id === 'volcengine-ark')!;

  const bothEnrolled: TokenPlanEnrollmentState = {
    tokenPlanEnrollments: {
      tokendance: 'tokendance',
      'volcengine-ark': ark.modalities.llm!.providerId,
    },
    providersConfig: {
      tokendance: { apiKey: 'sk-td' },
      [ark.modalities.llm!.providerId]: { apiKey: 'sk-ark' },
    },
  };

  it('activeTokenPlansInPriorityOrder 只返回生效套餐，且保持声明顺序', () => {
    const order = activeTokenPlansInPriorityOrder(bothEnrolled).map((p) => p.id);
    const declared = TOKEN_PLAN_PRESETS.map((p) => p.id).filter((id) => order.includes(id));
    expect(order).toEqual(declared);
    // tokendance 在 presets 中声明在 volcengine-ark 之前，优先级更高。
    expect(order.indexOf('tokendance')).toBeLessThan(order.indexOf('volcengine-ark'));
  });

  it('被关闭的套餐退出优先级序列', () => {
    const order = activeTokenPlansInPriorityOrder({
      ...bothEnrolled,
      tokenPlanDisabled: { tokendance: true },
    }).map((p) => p.id);
    expect(order).not.toContain('tokendance');
    expect(order).toContain('volcengine-ark');
  });

  it('低优先级套餐播种时不抢占高优先级套餐的主线模型与 stage route', () => {
    const actions = makeActions();
    // ark 排在 tokendance 之后，且 tokendance 正生效 → ark 让位。
    seedPlanModels(ark, actions, { priorityState: bothEnrolled });

    expect(actions.setModel).not.toHaveBeenCalled();
    // 目录仍然照写：目录不是独占槽位。
    expect(actions.setProviderConfig).toHaveBeenCalled();
  });

  it('高优先级套餐播种时照常占位', () => {
    const actions = makeActions();
    seedPlanModels(tokendance, actions, { priorityState: bothEnrolled });

    const mainModel =
      tokendance.modalities.llm!.defaultModelId ?? tokendance.modalities.llm!.defaultModels![0];
    expect(actions.setModel).toHaveBeenCalledWith('tokendance', mainModel);
    expect(actions.setStageRoute).toHaveBeenCalledWith(
      'scene-content:slide',
      expect.objectContaining({ providerId: 'tokendance' }),
    );
  });

  it('高优先级套餐被关闭后，低优先级套餐可以接管槽位', () => {
    const actions = makeActions();
    seedPlanModels(ark, actions, {
      priorityState: { ...bothEnrolled, tokenPlanDisabled: { tokendance: true } },
    });
    expect(actions.setModel).toHaveBeenCalled();
  });

  it('不传 priorityState 时保持旧行为（后写覆盖，不让位）', () => {
    const actions = makeActions();
    seedPlanModels(ark, actions);
    expect(actions.setModel).toHaveBeenCalled();
  });
});

// ── Review P0-03：共享 provider 凭证归属 = 列表中更靠前的生效套餐 ──
describe('shared provider credential ownership (review P0-03)', () => {
  const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
  const ark = TOKEN_PLAN_PRESETS.find((p) => p.id === 'volcengine-ark')!;
  // tokendance 在 TOKEN_PLAN_PRESETS 中声明在 volcengine-ark 之前（更高优先级），
  // 两者 image 模态共用 seedream。

  const bothUsable: TokenPlanEnrollmentState = {
    tokenPlanEnrollments: { tokendance: 'tokendance', 'volcengine-ark': 'doubao' },
    providersConfig: {
      tokendance: { apiKey: 'sk-td' },
      doubao: { apiKey: 'sk-ark' },
    },
  };

  const imageWrites = (actions: TokenPlanActions) =>
    (
      (actions.setImageProviderConfig as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, Record<string, unknown>]
      >
    ).filter(([id]) => id === 'seedream');

  it('后连低优先级套餐：不覆盖高优先级套餐已占用的共享槽位凭证', () => {
    const actions = makeActions();
    actions.getTokenPlanPriorityState = vi.fn(() => bothUsable);
    applyTokenPlan(ark, 'sk-ark', actions);
    const writes = imageWrites(actions);
    expect(writes).toHaveLength(0);
  });

  it('后连高优先级套餐：正常接管共享槽位（连接顺序无关）', () => {
    const actions = makeActions();
    actions.getTokenPlanPriorityState = vi.fn(() => bothUsable);
    applyTokenPlan(tokendance, 'sk-td', actions);
    const writes = imageWrites(actions);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
  });

  it('禁用低优先级套餐后：共享槽位凭证交还给高优先级套餐（key 取自其 LLM 槽位）', () => {
    const actions = makeActions();
    restoreSharedProviderCredentials(
      'volcengine-ark',
      actions,
      // ark 已被关闭：usable 集合只剩 tokendance。
      { ...bothUsable, tokenPlanDisabled: { 'volcengine-ark': true } },
    );
    const writes = imageWrites(actions);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
    expect(writes.some(([, cfg]) => cfg.baseUrl === tokendance.modalities.image!.baseUrl)).toBe(
      true,
    );
  });

  it('禁用高优先级套餐后：共享槽位交还给低优先级套餐', () => {
    const actions = makeActions();
    restoreSharedProviderCredentials('tokendance', actions, {
      ...bothUsable,
      tokenPlanDisabled: { tokendance: true },
    });
    const writes = imageWrites(actions);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-ark')).toBe(true);
  });

  it('解除连接同样交还共享槽位（removeTokenPlan 末尾）', () => {
    const actions = makeActions();
    actions.getTokenPlanEnrollments = vi.fn(() => bothUsable.tokenPlanEnrollments);
    actions.getTokenPlanPriorityState = vi.fn(() => bothUsable);
    removeTokenPlan(ark, actions);
    const writes = imageWrites(actions);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
  });

  it('无剩余 owner 时不写共享槽位（交由授权级联关闭）', () => {
    const actions = makeActions();
    restoreSharedProviderCredentials('tokendance', actions, {
      tokenPlanEnrollments: { tokendance: 'tokendance' },
      providersConfig: { tokendance: { apiKey: 'sk-td' } },
    });
    expect(imageWrites(actions)).toHaveLength(0);
  });
});

// ── P0-03 复验发现的两个 regression：enable 要夺回、remove 要清理 ──
describe('shared ownership regressions from re-review', () => {
  const tokendance = TOKEN_PLAN_PRESETS.find((p) => p.id === 'tokendance')!;
  const ark = TOKEN_PLAN_PRESETS.find((p) => p.id === 'volcengine-ark')!;

  const bothEnrolled: TokenPlanEnrollmentState = {
    tokenPlanEnrollments: { tokendance: 'tokendance', 'volcengine-ark': 'doubao' },
    providersConfig: {
      tokendance: { apiKey: 'sk-td' },
      doubao: { apiKey: 'sk-ark' },
    },
  };

  const imageWrites = (actions: TokenPlanActions) =>
    (
      (actions.setImageProviderConfig as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, Record<string, unknown>]
      >
    ).filter(([id]) => id === 'seedream');

  it('重新开启高优先级套餐：纳入 owner 解析，夺回共享槽位（regression #1）', () => {
    const actions = makeActions();
    // TD 刚被重新启用（tokenPlanDisabled 已不含 TD），槽位此刻还在 Seed 手里。
    restoreSharedProviderCredentials(
      'tokendance',
      actions,
      { ...bothEnrolled }, // TD usable
      { excludeConcerned: false },
    );
    const writes = imageWrites(actions);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
    expect(writes.some(([, cfg]) => cfg.baseUrl === tokendance.modalities.image!.baseUrl)).toBe(
      true,
    );
  });

  it('重新开启低优先级套餐：不抢走高优先级 owner 的槽位', () => {
    const actions = makeActions();
    restoreSharedProviderCredentials(
      'volcengine-ark',
      actions,
      { ...bothEnrolled }, // 两者 usable，owner = tokendance
      { excludeConcerned: false },
    );
    const writes = imageWrites(actions);
    // 仍重写为 owner（tokendance）的凭证——低优先级启用者不是 owner。
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
  });

  it('移除套餐时另一套餐仅 enrolled-but-disabled：共享槽位被清理而非残留（regression #2）', () => {
    const actions = makeActions();
    actions.getTokenPlanEnrollments = vi.fn(() => bothEnrolled.tokenPlanEnrollments);
    // Seed 已连接但被禁用：usable 集合为空（移除前快照里 TD 仍 enrolled）。
    actions.getTokenPlanPriorityState = vi.fn(() => ({
      ...bothEnrolled,
      tokenPlanDisabled: { 'volcengine-ark': true },
    }));
    removeTokenPlan(tokendance, actions);
    const writes = imageWrites(actions);
    // removeModality(image) 清理 seedream：key 清空 + 禁用 + 目录还原。
    expect(writes.some(([, cfg]) => cfg.apiKey === '' && cfg.enabled === false)).toBe(true);
    const restore = writes.filter(([, cfg]) => cfg.apiKey === 'sk-ark');
    expect(restore).toHaveLength(0);
  });

  it('移除套餐时另一套餐 usable：跳过清理并交还（既有语义回归守卫）', () => {
    const actions = makeActions();
    actions.getTokenPlanEnrollments = vi.fn(() => bothEnrolled.tokenPlanEnrollments);
    actions.getTokenPlanPriorityState = vi.fn(() => ({ ...bothEnrolled }));
    removeTokenPlan(ark, actions);
    const writes = imageWrites(actions);
    expect(writes.some(([, cfg]) => cfg.apiKey === 'sk-td')).toBe(true);
  });
});
