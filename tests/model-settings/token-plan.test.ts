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
    defaults: null,
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
      image: 'tokendance:seedream-5.0-lite',
      video: 'tokendance:minimax-h3',
      tts: 'tokendance:minimax-speech-2.8-turbo',
      webSearch: 'tokendance',
    });
  });

  it('leaves out the slots the deployment locks', async () => {
    deployment({
      providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
      slots: {
        llm: 'operator:deepseek-v4-pro',
        'course.content.slide': 'operator:deepseek-v4-pro',
      },
    });
    const view = viewOf(await configure(addPlan('tokendance')));
    const recommendation = recommendationIn(view, 'tokendance');
    expect(recommendation).not.toHaveProperty('llm');
    expect(recommendation).not.toHaveProperty('course.content.slide');
    expect(recommendation).toHaveProperty(
      'course.content.interactive',
      'tokendance:cogevol-interactive-0828',
    );
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
    expect(recommendationIn(view, 'kimi-coding-plan')).toEqual({});
    // TokenDance itself yields nothing: no plan ranks above it.
    expect(recommendationIn(view, 'tokendance')).toHaveProperty('llm', 'tokendance:cogevol-base');

    // With only MiniMax ahead of it, Kimi yields the default model MiniMax recommends.
    const two = viewOf(await configure(addPlan('minimax'), addPlan('kimi-coding-plan')));
    expect([...slotsHeldByHigherPlans(two, 'kimi-coding-plan')]).toEqual(
      expect.arrayContaining(['llm', 'image', 'video', 'tts', 'webSearch']),
    );
    expect(recommendationIn(two, 'kimi-coding-plan')).toEqual({});
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
