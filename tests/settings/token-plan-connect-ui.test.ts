// @vitest-environment jsdom

/**
 * Connecting a token plan from the Token Plan panel, against the real settings
 * service: the plan's recommended configuration is applied, and when it would
 * replace models the workspace picked the panel asks first.
 *
 * The i18n hook returns keys (with interpolated values appended).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? [key, ...Object.values(options)].join('|') : key,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

import { TokenPlanSettings } from '@/components/settings/token-plan-settings';
import type { ApplyResult, ModelSettingsChange } from '@/lib/model-settings/client';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { applyModelSettingsChange, modelSettingsView } from '@/lib/server/model-config/settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const deployment = (config: ModelConfigLayer['config'] | null) =>
  setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    defaults: null,
    notices: [],
  });

const roots: Root[] = [];
beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment(null);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

let revision = 0;
const viewOf = (config: ModelConfigFile | null) =>
  modelSettingsView(config ? { config, revision: ++revision, unreadableSecrets: [] } : null);

/** A workspace that picked DeepSeek for the default model and the slides. */
async function workspaceWithOwnPicks(): Promise<ModelConfigFile> {
  let config = await applyModelSettingsChange(null, {
    kind: 'provider',
    id: 'ds',
    preset: 'deepseek',
    apiKey: 'sk-ds-key-0001',
  });
  config = await applyModelSettingsChange(config, {
    kind: 'slots',
    set: { llm: 'ds:deepseek-v4-pro', 'course.content.slide': 'ds:deepseek-v4-flash' },
  });
  return config;
}

/** The panel on a workspace, with an apply backed by the real settings service. */
function mountPanel(initial: ModelConfigFile | null) {
  let config = initial;
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    config = await applyModelSettingsChange(config, change);
    return { ok: true, view: viewOf(config) };
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(TokenPlanSettings, { view: viewOf(initial), apply })));
  return { changes, config: () => config };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
  }
}

function byText(text: string, selector = 'button'): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No ${selector} with ${text}`);
  return found;
}

async function connectTokenDance(key = 'td-key-123456') {
  act(() => byText('TokenDance').click());
  const input = document.body.querySelector<HTMLInputElement>(
    '[aria-label="settings.tokenPlan.apiKey"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, key);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    (document.body.querySelector('form') as HTMLFormElement).requestSubmit();
  });
  await flush();
}

const dialog = () => document.body.querySelector('[role="alertdialog"]');

describe('Token Plan → connecting applies the plan’s recommended configuration', () => {
  it('on a fresh workspace, assigns llm and the course stages without asking', async () => {
    const panel = mountPanel(null);
    await connectTokenDance();
    expect(dialog()).toBeNull();
    expect(panel.changes).toEqual([
      { kind: 'provider', id: 'tokendance', preset: 'tokendance', apiKey: 'td-key-123456' },
      {
        kind: 'slots',
        set: {
          llm: 'tokendance:cogevol-base',
          'course.content.slide': 'tokendance:cogevol-slide-0828',
          'course.content.interactive': 'tokendance:cogevol-interactive-0828',
          tts: 'tokendance:minimax-speech-2.8-turbo',
          image: 'tokendance:seedream-5.0-lite',
          video: 'tokendance:minimax-h3',
          webSearch: 'tokendance',
        },
      },
    ]);
  });

  it('asks before replacing the models the workspace picked, and lists them', async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectTokenDance();
    // Nothing is written until the user chooses.
    expect(panel.changes).toEqual([]);
    const shown = dialog();
    expect(shown?.textContent).toContain('settings.tokenPlan.applyTitle');
    const rows = [...shown!.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    // Slot names as the course model map shows them (the id here: the test's
    // translations return keys), then current → recommended.
    expect(rows[0]).toMatch(/^llmDeepSeek V4 Pro · ds → cogevol-base · TokenDance$/);
    expect(rows[1]).toMatch(/^course\.content\.slide.* → cogevol-slide-0828 · TokenDance$/);
  });

  it("“Use plan's recommended setup” overwrites the workspace's picks in one change", async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectTokenDance();
    act(() => byText('settings.tokenPlan.applyRecommended', '[role="alertdialog"] button').click());
    await flush();
    expect(panel.changes).toHaveLength(2);
    expect(panel.changes[1]).toMatchObject({
      kind: 'slots',
      set: {
        llm: 'tokendance:cogevol-base',
        'course.content.slide': 'tokendance:cogevol-slide-0828',
        'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      },
    });
    expect(panel.config()?.slots).toMatchObject({
      llm: 'tokendance:cogevol-base',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
    });
  });

  it('“Keep my current setup” connects and fills only the empty slots', async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectTokenDance();
    act(() => byText('settings.tokenPlan.applyKeep', '[role="alertdialog"] button').click());
    await flush();
    expect(panel.changes[0]).toMatchObject({ kind: 'provider', id: 'tokendance' });
    const set = (panel.changes[1] as Extract<ModelSettingsChange, { kind: 'slots' }>).set!;
    expect(set).not.toHaveProperty('llm');
    expect(set).not.toHaveProperty('course.content.slide');
    expect(set).toMatchObject({
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      image: 'tokendance:seedream-5.0-lite',
    });
    expect(panel.config()?.slots).toMatchObject({
      llm: 'ds:deepseek-v4-pro',
      'course.content.slide': 'ds:deepseek-v4-flash',
    });
  });

  it('leaves the slots the deployment locks out of the question and the change', async () => {
    const picks = await workspaceWithOwnPicks();
    // The deployment locks the default model the workspace had picked.
    deployment({
      providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
      slots: { llm: 'operator:deepseek-v4-pro' },
    });
    const panel = mountPanel(picks);
    await connectTokenDance();
    const rows = [...dialog()!.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^course\.content\.slide/);
    act(() => byText('settings.tokenPlan.applyRecommended', '[role="alertdialog"] button').click());
    await flush();
    const set = (panel.changes[1] as Extract<ModelSettingsChange, { kind: 'slots' }>).set!;
    expect(set).not.toHaveProperty('llm');
    expect(set).toHaveProperty('course.content.slide', 'tokendance:cogevol-slide-0828');
  });
});
