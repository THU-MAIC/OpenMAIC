import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { modelSettingsView } from '@/lib/server/model-config/settings';
import {
  canAddService,
  narrationVoicesManageable,
  tokenPlanListed,
  canChangeDefaultModel,
  canResetToServerDefault,
  capabilityEditable,
  settingsSections,
  settingsShape,
  slotEditable,
  tokenPlanCanChange,
} from '@/lib/model-settings/shape';
import type { ModelSettingsView } from '@/lib/model-settings/client';

// The views come from the real settings service over a deployment layer, so
// the shape is derived from what the server would answer.
const providers = {
  operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' },
  voice: { preset: 'minimax', apiKey: 'sk-operator-secret-0002' },
};

function viewFor(config: ModelConfigLayer['config'] | null): ModelSettingsView {
  setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    legacy: false,
    notices: [],
  });
  return modelSettingsView(null);
}

const slot = (view: ModelSettingsView, id: string) =>
  view.slots.find((entry) => entry.slot === id)!;
const plan = (view: ModelSettingsView, id: string) =>
  view.presets.find((preset) => preset.id === id)!;

beforeEach(() => vi.stubEnv('ALLOW_LOCAL_NETWORKS', ''));
afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

describe('settingsShape', () => {
  it('is "set it up yourself" with nothing configured, and with server defaults', () => {
    for (const config of [null, { providers, slots: { llm: 'operator:deepseek-v4-pro' } }]) {
      const view = viewFor(config);
      expect(settingsShape(view)).toBe('yourself');
      const sections = settingsSections(view);
      expect(sections.tokenPlan).toBe(true);
      expect(sections.modelServices).toEqual([
        'chat',
        'image',
        'video',
        'tts',
        'asr',
        'document',
        'webSearch',
      ]);
    }
  });

  it('is "choose a model" without user keys: only the map', () => {
    const view = viewFor({
      providers,
      slots: { llm: 'operator:deepseek-v4-pro', document: null },
      allowUserKeys: false,
      lock: ['document'],
    });
    expect(settingsShape(view)).toBe('choose');
    expect(settingsSections(view)).toEqual({
      shape: 'choose',
      tokenPlan: false,
      modelServices: [],
    });
    expect(canAddService(view, 'chat')).toBe(false);
    // The deployment's providers are still there to choose among.
    expect(slotEditable(slot(view, 'llm'))).toBe(true);
    expect(slotEditable(slot(view, 'document'))).toBe(false);
  });

  it('is "configured by the administrator" when every slot is locked', () => {
    const view = viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: 'all' });
    expect(settingsShape(view)).toBe('admin');
    expect(settingsSections(view)).toEqual({
      shape: 'admin',
      tokenPlan: false,
      modelServices: [],
    });
    // Unwritten roots resolve to nothing, and are shown so.
    expect(slot(view, 'image')).toMatchObject({
      locked: true,
      effective: { status: 'unassigned' },
    });
  });

  it('is "configured by the administrator" whatever allowUserKeys says once all is locked', () => {
    const view = viewFor({ lock: 'all', allowUserKeys: true });
    expect(settingsShape(view)).toBe('admin');
  });
});

describe('a mixed deployment (llm locked, user keys allowed)', () => {
  const config = {
    providers,
    slots: { llm: 'operator:deepseek-v4-pro' },
    lock: ['llm'],
  } satisfies ModelConfigLayer['config'];

  it('locks the whole language model tree, children included', () => {
    const view = viewFor(config);
    for (const id of ['llm', 'course.outline', 'course.content.slide', 'agent', 'classroom']) {
      expect(slotEditable(slot(view, id))).toBe(false);
    }
    expect(capabilityEditable(view, 'chat')).toBe(false);
    expect(capabilityEditable(view, 'image')).toBe(true);
  });

  it('offers adding a service only where a slot can still be set', () => {
    const view = viewFor(config);
    expect(canAddService(view, 'chat')).toBe(false);
    expect(canAddService(view, 'image')).toBe(true);
    expect(settingsSections(view).modelServices).not.toContain('chat');
    expect(settingsSections(view).modelServices).toContain('image');
  });

  it('keeps a plan that can still fill media slots, and drops one that only serves chat', () => {
    const view = viewFor(config);
    expect(tokenPlanCanChange(view, plan(view, 'tokendance'))).toBe(true);
    expect(tokenPlanCanChange(view, plan(view, 'kimi-coding-plan'))).toBe(false);
    expect(settingsSections(view).tokenPlan).toBe(true);
  });

  it('hides Token Plan when no plan can fill an unlocked slot', () => {
    const view = viewFor({ ...config, lock: ['llm', 'tts', 'image', 'video', 'webSearch'] });
    for (const preset of view.presets.filter((entry) => entry.kind === 'token-plan')) {
      expect(tokenPlanCanChange(view, preset)).toBe(false);
    }
    expect(settingsSections(view).tokenPlan).toBe(false);
  });
});

describe('canResetToServerDefault', () => {
  it('offers the reset only once the workspace replaced a default on the slot itself', () => {
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: { providers, slots: { llm: 'operator:deepseek-v4-pro' } },
      },
      legacy: false,
      notices: [],
    });
    const untouched = modelSettingsView(null);
    expect(canResetToServerDefault(slot(untouched, 'llm'))).toBe(false);
    const changed = modelSettingsView({
      config: { slots: { llm: 'operator:deepseek-v4-flash', 'course.outline': null } },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(canResetToServerDefault(slot(changed, 'llm'))).toBe(true);
    // No default on the outline itself: it follows its parent instead.
    expect(canResetToServerDefault(slot(changed, 'course.outline'))).toBe(false);
  });
});

describe('canChangeDefaultModel', () => {
  it('holds while llm is not locked and some provider serves chat', () => {
    expect(
      canChangeDefaultModel(viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' } })),
    ).toBe(true);
    expect(
      canChangeDefaultModel(
        viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, allowUserKeys: false }),
      ),
    ).toBe(true);
  });

  it('fails when llm is locked, everything is locked, or nothing offers a language model', () => {
    const fixed = { providers, slots: { llm: 'operator:deepseek-v4-pro' } };
    expect(canChangeDefaultModel(viewFor({ ...fixed, lock: ['llm'] }))).toBe(false);
    expect(canChangeDefaultModel(viewFor({ ...fixed, lock: 'all' }))).toBe(false);
    expect(
      canChangeDefaultModel(viewFor({ providers: { tts: { preset: 'qwen-tts', apiKey: 'k' } } })),
    ).toBe(false);
    expect(canChangeDefaultModel(viewFor({}))).toBe(false);
  });
});

describe('narration voices', () => {
  const qwen = { preset: 'qwen-tts', apiKey: 'sk-operator-secret-0003' };

  it('keeps the Text-to-Speech tab for user voices in every shape', () => {
    for (const extra of [{ allowUserKeys: false }, { lock: 'all' as const }]) {
      const view = viewFor({
        providers: { ...providers, qwen },
        slots: { llm: 'operator:deepseek-v4-pro', tts: 'qwen:qwen3-tts-flash' },
        ...extra,
      });
      expect(narrationVoicesManageable(view)).toBe(true);
      expect(settingsSections(view).modelServices).toEqual(['tts']);
    }
  });

  it('does not for narration without user voices', () => {
    const view = viewFor({
      providers,
      slots: { llm: 'operator:deepseek-v4-pro', tts: 'voice:speech-2.8-turbo' },
      lock: 'all',
    });
    expect(narrationVoicesManageable(view)).toBe(false);
    expect(settingsSections(view).modelServices).toEqual([]);
  });
});

describe('connected token plans', () => {
  it('stay listed to manage or disconnect when their slots are locked', () => {
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: { providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: 'all' },
      },
      legacy: false,
      notices: [],
    });
    const connected = modelSettingsView({
      config: { providers: { tokendance: { preset: 'tokendance', apiKey: 'sk-plan-key-0001' } } },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(tokenPlanListed(connected, plan(connected, 'tokendance'))).toBe(true);
    expect(tokenPlanListed(connected, plan(connected, 'minimax'))).toBe(false);
    expect(settingsSections(connected).tokenPlan).toBe(true);
    expect(settingsSections(modelSettingsView(null)).tokenPlan).toBe(false);
  });
});

describe('reset to server default', () => {
  it('is not offered when the workspace value says the same as the default', () => {
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers,
          slots: { llm: { model: 'operator:deepseek-v4-pro', thinking: { enabled: false } } },
        },
      },
      legacy: false,
      notices: [],
    });
    const same = modelSettingsView({
      config: {
        slots: { llm: { thinking: { enabled: false }, model: 'operator:deepseek-v4-pro' } },
      },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(canResetToServerDefault(slot(same, 'llm'))).toBe(false);
    const different = modelSettingsView({
      config: { slots: { llm: 'operator:deepseek-v4-pro' } },
      revision: 1,
      unreadableSecrets: [],
    });
    // Same model, but the default turns thinking off: a difference.
    expect(canResetToServerDefault(slot(different, 'llm'))).toBe(true);
  });
});
