import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { applyModelSettingsChange, modelSettingsView } from '@/lib/server/model-config/settings';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
} from '@/lib/model-settings/client';
import { wizardAssignments } from '@/lib/model-settings/edit';
import { serviceEntries } from '@/lib/model-settings/services';
import {
  connectConflicts,
  connectTokenPlan,
  slotsHeldByHigherPlans,
  tokenPlanAssignments,
  tokenPlanConflicts,
  tokenPlanRecommendation,
} from '@/lib/model-settings/token-plan';

const deployment = (config: ModelConfigLayer['config'] | null) =>
  setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    legacy: false,
    notices: [],
  });

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment(null);
});

afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

let revision = 0;
const viewOf = (config: ModelConfigFile | null) =>
  modelSettingsView(config ? { config, revision: ++revision, unreadableSecrets: [] } : null);

/** Apply changes in turn, as the server would store them. */
async function configure(...changes: ModelSettingsChange[]): Promise<ModelConfigFile> {
  let config: ModelConfigFile | null = null;
  for (const change of changes) config = await applyModelSettingsChange(config, change);
  return config ?? {};
}

const addPlan = (id: string, preset = id): ModelSettingsChange => ({
  kind: 'provider',
  id,
  preset,
  apiKey: `sk-${id}-key-0001`,
});

/** The plan's recommendation against a view, for the plan's provider in it. */
function recommendationIn(view: ModelSettingsView, presetId: string) {
  const preset = view.presets.find((entry) => entry.id === presetId)!;
  const provider = view.providers.find((entry) => entry.preset === presetId)!;
  return tokenPlanRecommendation(view, preset, provider);
}

/** A client apply backed by the real settings service, recording each change. */
function serverApply(initial: ModelConfigFile | null) {
  let config = initial;
  const changes: ModelSettingsChange[] = [];
  const apply = async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    config = await applyModelSettingsChange(config, change);
    return { ok: true, view: viewOf(config) };
  };
  return { apply, changes, config: () => config };
}

describe('token plan recommendation', () => {
  it('covers the default model, the course stages it names and every media service', async () => {
    const view = viewOf(await configure(addPlan('tokendance')));
    expect(recommendationIn(view, 'tokendance')).toEqual({
      llm: 'tokendance:cogevol-base',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      agent: 'tokendance:deepseek-v4.1-flash',
      image: 'tokendance:seedream-5.0-lite',
      video: 'tokendance:minimax-h3',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      webSearch: 'tokendance',
    });
  });

  it('leaves out the slots the deployment locks, and only those', async () => {
    deployment({
      providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
      slots: {
        llm: 'operator:deepseek-v4-pro',
        'course.content.slide': 'operator:deepseek-v4-pro',
      },
      lock: ['course.content.slide'],
    });
    const view = viewOf(await configure(addPlan('tokendance')));
    const recommendation = recommendationIn(view, 'tokendance');
    expect(recommendation).not.toHaveProperty('course.content.slide');
    // A server default that is not locked is the plan's to fill.
    expect(recommendation).toHaveProperty('llm');
    expect(recommendation).toHaveProperty(
      'course.content.interactive',
      'tokendance:cogevol-interactive-0828',
    );
  });

  it('never fills a slot inside a locked subtree', async () => {
    deployment({
      providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
      slots: { llm: 'operator:deepseek-v4-pro' },
      lock: ['llm'],
    });
    const view = viewOf(await configure(addPlan('tokendance')));
    const recommendation = recommendationIn(view, 'tokendance');
    const chat = Object.keys(recommendation).filter(
      (slot) => view.slots.find((entry) => entry.slot === slot)?.capability === 'chat',
    );
    expect(chat).toEqual([]);
    expect(Object.keys(recommendation).length).toBeGreaterThan(0);
  });

  it('yields the slots a higher-priority connected plan holds, whatever the connect order', async () => {
    // TokenDance (first in the list) is connected; MiniMax and Kimi come later.
    const config = await configure(
      addPlan('tokendance'),
      addPlan('minimax'),
      addPlan('kimi-coding-plan'),
    );
    const view = viewOf(config);
    expect(recommendationIn(view, 'minimax')).toEqual({});
    expect(recommendationIn(view, 'kimi-coding-plan')).toEqual({
      webFetch: 'kimi-coding-plan',
    });
    // TokenDance itself yields nothing: no plan ranks above it.
    expect(recommendationIn(view, 'tokendance')).toHaveProperty('llm', 'tokendance:cogevol-base');

    // With only MiniMax ahead of it, Kimi yields the default model MiniMax recommends.
    const two = viewOf(await configure(addPlan('minimax'), addPlan('kimi-coding-plan')));
    expect([...slotsHeldByHigherPlans(two, 'kimi-coding-plan')]).toEqual(
      expect.arrayContaining(['llm', 'image', 'video', 'tts', 'webSearch']),
    );
    expect(recommendationIn(two, 'kimi-coding-plan')).toEqual({
      webFetch: 'kimi-coding-plan',
    });
    // MiniMax, ranked above Kimi, takes the default model even though Kimi holds it now.
    const kimiFirst = viewOf(
      await configure(addPlan('kimi-coding-plan'), addPlan('minimax'), {
        kind: 'slots',
        set: { llm: 'kimi-coding-plan:kimi-for-coding' },
      }),
    );
    expect(recommendationIn(kimiFirst, 'minimax')).toHaveProperty('llm', 'minimax:MiniMax-M3');
    expect(tokenPlanConflicts(kimiFirst, recommendationIn(kimiFirst, 'minimax'))).toHaveLength(1);
  });

  it('a higher-priority plan without a usable key holds nothing', async () => {
    const config = await configure(addPlan('tokendance'), addPlan('kimi-coding-plan'), {
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: '',
    });
    expect(recommendationIn(viewOf(config), 'kimi-coding-plan')).toEqual({
      llm: 'kimi-coding-plan:kimi-for-coding',
      webSearch: 'kimi-coding-plan',
      webFetch: 'kimi-coding-plan',
    });
  });
});

describe('token plan assignments', () => {
  it('overwrites the slots the workspace set, or keeps them and fills the empty ones', async () => {
    const config = await configure(
      { kind: 'provider', id: 'ds', preset: 'deepseek', apiKey: 'sk-ds-key-0001' },
      {
        kind: 'slots',
        set: {
          llm: {
            model: 'ds:deepseek-v4-pro',
            thinking: { enabled: true },
          },
          'course.content.slide': 'ds:deepseek-v4-pro',
          image: null,
        },
      },
      addPlan('tokendance'),
    );
    const view = viewOf(config);
    const recommendation = recommendationIn(view, 'tokendance');
    expect(
      tokenPlanConflicts(view, recommendation).map(({ slot, current, recommended }) => [
        slot.slot,
        current,
        recommended,
      ]),
    ).toEqual([
      [
        'llm',
        { model: 'ds:deepseek-v4-pro', thinking: { enabled: true } },
        'tokendance:cogevol-base',
      ],
      ['course.content.slide', 'ds:deepseek-v4-pro', 'tokendance:cogevol-slide-0828'],
      ['image', null, 'tokendance:seedream-5.0-lite'],
    ]);

    const overwrite = tokenPlanAssignments(view, recommendation, 'overwrite');
    // Thinking settings belong to the model they were set for: they go with it.
    expect(overwrite).toEqual(recommendation);
    const keep = tokenPlanAssignments(view, recommendation, 'keep');
    expect(keep).toEqual({
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      agent: 'tokendance:deepseek-v4.1-flash',
      video: 'tokendance:minimax-h3',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      webSearch: 'tokendance',
    });
    // Both resolve on the server.
    await applyModelSettingsChange(config, { kind: 'slots', set: overwrite });
    await applyModelSettingsChange(config, { kind: 'slots', set: keep });
  });

  it('leaves out the slots that already hold the recommended model', async () => {
    const config = await configure(addPlan('tokendance'), {
      kind: 'slots',
      set: { llm: 'tokendance:cogevol-base' },
    });
    const view = viewOf(config);
    const recommendation = recommendationIn(view, 'tokendance');
    expect(tokenPlanConflicts(view, recommendation)).toEqual([]);
    expect(tokenPlanAssignments(view, recommendation, 'overwrite')).not.toHaveProperty('llm');
  });
});

describe('connecting a token plan', () => {
  it('adds the provider, then assigns the recommendation in one slots change', async () => {
    const initial = await configure(
      { kind: 'provider', id: 'ds', preset: 'deepseek', apiKey: 'sk-ds-key-0001' },
      { kind: 'slots', set: { llm: 'ds:deepseek-v4-pro' } },
    );
    const view = viewOf(initial);
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    // Before anything is written, the conflict is known.
    expect(connectConflicts(view, preset).map((conflict) => conflict.slot.slot)).toEqual(['llm']);

    const server = serverApply(initial);
    const result = await connectTokenPlan(server.apply, view, preset, 'sk-td-0001', 'overwrite');
    expect(result).toMatchObject({ status: 'done', providerId: 'tokendance' });
    expect(server.changes).toHaveLength(2);
    expect(server.changes[0]).toEqual({
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: 'sk-td-0001',
    });
    expect(server.changes[1]).toMatchObject({
      kind: 'slots',
      set: {
        llm: 'tokendance:cogevol-base',
        'course.content.slide': 'tokendance:cogevol-slide-0828',
        'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      },
    });
  });

  it('keeping the current setup connects and fills only the empty slots', async () => {
    const initial = await configure(
      { kind: 'provider', id: 'ds', preset: 'deepseek', apiKey: 'sk-ds-key-0001' },
      { kind: 'slots', set: { llm: 'ds:deepseek-v4-pro' } },
    );
    const view = viewOf(initial);
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    const server = serverApply(initial);
    await connectTokenPlan(server.apply, view, preset, 'sk-td-0001', 'keep');
    expect(server.config()?.slots).toMatchObject({
      llm: 'ds:deepseek-v4-pro',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
    });
  });

  it('saving a new key for a connected plan re-applies its recommendation', async () => {
    const initial = await configure(
      addPlan('tokendance'),
      { kind: 'provider', id: 'ds', preset: 'deepseek', apiKey: 'sk-ds-key-0001' },
      { kind: 'slots', set: { llm: 'ds:deepseek-v4-pro' } },
    );
    const view = viewOf(initial);
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    const server = serverApply(initial);
    await connectTokenPlan(server.apply, view, preset, 'sk-td-0002', 'overwrite');
    expect(server.changes[0]).toEqual({
      kind: 'provider',
      id: 'tokendance',
      preset: 'tokendance',
      apiKey: 'sk-td-0002',
    });
    expect(server.config()?.providers).not.toHaveProperty('tokendance-2');
    expect(server.config()?.slots).toMatchObject({ llm: 'tokendance:cogevol-base' });
  });
});

describe('DeepSeek account setup', () => {
  it('assigns chat without automatically enabling search in the wizard', async () => {
    const config = await configure(addPlan('deepseek'));
    const view = viewOf(config);
    const preset = view.presets.find((entry) => entry.id === 'deepseek')!;
    const assignments = wizardAssignments(view, preset, 'deepseek');
    expect(assignments.llm).toMatch(/^deepseek:/);
    expect(assignments).not.toHaveProperty('webSearch');
    const configured = await applyModelSettingsChange(config, { kind: 'slots', set: assignments });
    expect(configured.slots).not.toHaveProperty('webSearch');
    const searchEntries = serviceEntries(viewOf(configured), 'webSearch', ['deepseek']).filter(
      (entry) => entry.provider,
    );
    expect(searchEntries).toHaveLength(1);
    expect(searchEntries[0].provider?.id).toBe('deepseek');
  });
});

describe('Kimi account setup', () => {
  it.each(['kimi', 'kimi-coding-plan'])(
    'shares chat, search and fetch credentials while preserving wizard defaults for %s',
    async (presetId) => {
      const view = viewOf(await configure(addPlan(presetId)));
      const preset = view.presets.find((entry) => entry.id === presetId)!;
      const assignments = wizardAssignments(view, preset, presetId);
      expect(assignments).toHaveProperty('webSearch', presetId);
      expect(assignments.llm).toMatch(new RegExp(`^${presetId}:`));
      const searchEntries = serviceEntries(view, 'webSearch', ['kimi']).filter(
        (entry) => entry.provider,
      );
      expect(searchEntries).toHaveLength(1);
      expect(searchEntries[0].provider?.id).toBe(presetId);
      expect(searchEntries[0].provider?.key?.set).toBe(true);
      const fetchEntries = serviceEntries(view, 'webFetch', ['kimi']).filter(
        (entry) => entry.provider && entry.registryId === 'kimi',
      );
      expect(fetchEntries).toHaveLength(1);
      expect(fetchEntries[0].provider).toBe(searchEntries[0].provider);
      expect(assignments).not.toHaveProperty('webFetch');
      expect(view.slots.find((slot) => slot.slot === 'webFetch')?.effective).toMatchObject({
        status: 'assigned',
        registryId: 'builtin',
      });
    },
  );
});

describe('Kimi wizard endpoints', () => {
  it.each(['kimi', 'kimi-coding-plan'])(
    'does not assign search to a custom proxy account for %s',
    async (presetId) => {
      const view = viewOf(await configure(addPlan(presetId)));
      // Even if a view offers search, the wizard must check the typed endpoint.
      view.providers[0] = { ...view.providers[0], baseUrl: 'https://proxy.openmaic.test/v1' };
      const preset = view.presets.find((entry) => entry.id === presetId)!;
      expect(wizardAssignments(view, preset, presetId)).not.toHaveProperty('webSearch');
      expect(wizardAssignments(view, preset, presetId)).toHaveProperty('llm');
    },
  );

  it.each([
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1',
    'https://api.kimi.com/coding/v1',
    'https://api.kimi.ai/coding/v1/',
  ])('allows an official search account base %s', async (baseUrl) => {
    const view = viewOf(await configure(addPlan('kimi')));
    view.providers[0] = { ...view.providers[0], baseUrl };
    const preset = view.presets.find((entry) => entry.id === 'kimi')!;
    expect(wizardAssignments(view, preset, 'kimi')).toHaveProperty('webSearch', 'kimi');
  });
});

describe('token plan web fetch', () => {
  it.each(['keep', 'overwrite'] as const)(
    'connects without a builtin conflict in %s mode and reconnects after disconnect',
    async (mode) => {
      const view = viewOf(null);
      const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
      const server = serverApply(null);
      expect(connectConflicts(view, preset)).toEqual([]);
      const result = await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', mode);
      expect(result).toMatchObject({ status: 'done', assigned: ['llm', 'webFetch', 'webSearch'] });
      expect(server.config()?.slots).toMatchObject({ webFetch: 'kimi-coding-plan' });
      const connected = viewOf(server.config());
      expect(connected.slots.find((slot) => slot.slot === 'webFetch')?.effective).toMatchObject({
        status: 'assigned',
        providerId: 'kimi-coding-plan',
        registryId: 'kimi',
      });
      const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
      expect(
        resolveSlot('webFetch', [{ source: 'workspace', config: server.config()! }]),
      ).toMatchObject({
        status: 'assigned',
        registryId: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
      });
      await server.apply({ kind: 'remove-provider', id: 'kimi-coding-plan' });
      expect(server.config()?.slots ?? {}).not.toHaveProperty('webFetch');
      expect(
        viewOf(server.config()).slots.find((slot) => slot.slot === 'webFetch')?.effective,
      ).toMatchObject({ status: 'assigned', providerId: 'builtin', registryId: 'builtin' });
      const disconnected = viewOf(server.config());
      expect(connectConflicts(disconnected, preset)).toEqual([]);
      await connectTokenPlan(server.apply, disconnected, preset, 'sk-new-plan-key', 'keep');
      expect(server.config()?.slots?.webFetch).toBe('kimi-coding-plan');
    },
  );

  it.each(['keep', 'overwrite'] as const)(
    'confirms an explicit personal reader and applies %s mode',
    async (mode) => {
      const initial = await configure(addPlan('kimi'), {
        kind: 'slots',
        set: { webFetch: 'kimi' },
      });
      const view = viewOf(initial);
      const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
      expect(connectConflicts(view, preset)).toMatchObject([
        { slot: { slot: 'webFetch' }, current: 'kimi', from: 'workspace' },
      ]);
      const server = serverApply(initial);
      await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', mode);
      expect(server.config()?.slots?.webFetch).toBe(mode === 'keep' ? 'kimi' : 'kimi-coding-plan');
      await server.apply({ kind: 'remove-provider', id: 'kimi-coding-plan' });
      expect(
        viewOf(server.config()).slots.find((slot) => slot.slot === 'webFetch')?.effective,
      ).toMatchObject({ status: 'assigned', providerId: mode === 'keep' ? 'kimi' : 'builtin' });
      expect(server.config()?.providers?.kimi).toEqual(initial.providers?.kimi);
    },
  );

  it('treats an explicit workspace builtin assignment as a choice', async () => {
    const config = await configure(addPlan('kimi-coding-plan'), {
      kind: 'slots',
      set: { webFetch: 'builtin' },
    });
    const view = viewOf(config);
    const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
    expect(connectConflicts(view, preset)).toMatchObject([
      { slot: { slot: 'webFetch' }, current: 'builtin', from: 'workspace' },
    ]);
    const recommendation = recommendationIn(view, 'kimi-coding-plan');
    expect(tokenPlanAssignments(view, recommendation, 'keep')).not.toHaveProperty('webFetch');
    expect(tokenPlanAssignments(view, recommendation, 'overwrite')).toHaveProperty(
      'webFetch',
      'kimi-coding-plan',
    );
  });

  it('fills the implicit builtin default even when a deployment provider uses the builtin id', async () => {
    deployment({ providers: { builtin: { preset: 'kimi', apiKey: 'sk-operator' } } });
    const view = viewOf(null);
    const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
    expect(connectConflicts(view, preset)).toEqual([]);
    const server = serverApply(null);
    await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', 'keep');
    expect(server.config()?.slots?.webFetch).toBe('kimi-coding-plan');
  });

  it('leaves fetch with Kimi when a higher-priority plan does not declare it', async () => {
    const initial = await configure(addPlan('kimi-coding-plan'), {
      kind: 'slots',
      set: { webFetch: 'kimi-coding-plan' },
    });
    const view = viewOf(initial);
    const server = serverApply(initial);
    const preset = view.presets.find((entry) => entry.id === 'tokendance')!;
    await connectTokenPlan(server.apply, view, preset, 'sk-other-plan', 'overwrite');
    expect(server.config()?.slots?.webFetch).toBe('kimi-coding-plan');
    expect(slotsHeldByHigherPlans(viewOf(server.config()), 'kimi-coding-plan')).not.toContain(
      'webFetch',
    );
  });

  it.each(['webSearch', 'webFetch'] as const)(
    'never overrides a locked %s slot',
    async (slotId) => {
      deployment({ slots: { [slotId]: null }, lock: [slotId] });
      const view = viewOf(null);
      const server = serverApply(null);
      const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
      await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', 'overwrite');
      expect(server.config()?.slots).not.toHaveProperty(slotId);
      expect(
        viewOf(server.config()).slots.find((slot) => slot.slot === slotId)?.effective.status,
      ).toBe('disabled');
    },
  );

  it.each(['workspace', 'deployment'] as const)(
    'treats %s null as an explicit choice, like search',
    async (source) => {
      const disabled = { webSearch: null, webFetch: null };
      if (source === 'deployment') deployment({ slots: disabled });
      const config = await configure(
        addPlan('kimi-coding-plan'),
        ...(source === 'workspace' ? [{ kind: 'slots' as const, set: disabled }] : []),
      );
      const view = viewOf(config);
      const recommendation = recommendationIn(view, 'kimi-coding-plan');
      expect(
        tokenPlanConflicts(view, recommendation).map(({ slot, current, from }) => [
          slot.slot,
          current,
          from,
        ]),
      ).toEqual([
        ['webFetch', null, source === 'workspace' ? 'workspace' : 'default'],
        ['webSearch', null, source === 'workspace' ? 'workspace' : 'default'],
      ]);
      expect(tokenPlanAssignments(view, recommendation, 'keep')).not.toHaveProperty('webFetch');
      expect(tokenPlanAssignments(view, recommendation, 'keep')).not.toHaveProperty('webSearch');
      expect(tokenPlanAssignments(view, recommendation, 'overwrite')).toMatchObject({
        webFetch: 'kimi-coding-plan',
        webSearch: 'kimi-coding-plan',
      });
      const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
      expect(wizardAssignments(view, preset, 'kimi-coding-plan')).not.toHaveProperty('webFetch');
      const server = serverApply(config);
      await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', 'keep');
      expect(
        viewOf(server.config()).slots.find((slot) => slot.slot === 'webFetch')?.effective.status,
      ).toBe('disabled');
    },
  );

  it.each(['reader', 'builtin'])(
    'confirms and restores the deployment reader %s after disconnect',
    async (readerId) => {
      deployment({
        providers: { [readerId]: { preset: 'kimi', apiKey: 'sk-operator' } },
        slots: { webFetch: readerId },
      });
      const view = viewOf(null);
      const preset = view.presets.find((entry) => entry.id === 'kimi-coding-plan')!;
      expect(connectConflicts(view, preset)).toMatchObject([
        { slot: { slot: 'webFetch' }, current: readerId, from: 'default' },
      ]);
      const server = serverApply(null);
      await connectTokenPlan(server.apply, view, preset, 'sk-plan-key', 'keep');
      expect(server.config()?.slots).not.toHaveProperty('webFetch');
      await connectTokenPlan(
        server.apply,
        viewOf(server.config()),
        preset,
        'sk-plan-key',
        'overwrite',
      );
      await server.apply({ kind: 'remove-provider', id: 'kimi-coding-plan' });
      expect(
        viewOf(server.config()).slots.find((slot) => slot.slot === 'webFetch')?.effective,
      ).toMatchObject({ status: 'assigned', providerId: readerId, registryId: 'kimi' });
    },
  );
});
