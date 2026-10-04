// @vitest-environment jsdom

/**
 * The settings take the shape the configuration allows (RFC #1701, "What the
 * settings show"): every control renders only if using it can change
 * something. Driven through the components over views from the real settings
 * service, so locks, defaults and allowUserKeys come out as the server says.
 */
import 'fake-indexeddb/auto';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

// The dialog's panels are stubbed where a test only looks at what is listed.
vi.mock('@/components/settings/general-settings', () => ({
  GeneralSettings: () => createElement('div', { 'data-testid': 'panel-general' }),
}));
vi.mock('@/components/settings/skill-settings', () => ({
  SkillSettings: () => createElement('div', { 'data-testid': 'panel-skills' }),
}));

import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { SettingsDialog } from '@/components/settings';
import { CourseModelMap } from '@/components/settings/models';
import { ModelMap } from '@/components/settings/models/model-map';
import { SlotPicker } from '@/components/settings/models/slot-picker';
import {
  modelSettingsClient,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
} from '@/lib/model-settings/client';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import {
  applyModelSettingsChange,
  modelSettingsView,
  type StoredWorkspaceConfig,
} from '@/lib/server/model-config/settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});

const roots: Root[] = [];
/** What GET /api/model-config answers. */
let served: ModelSettingsView | null = null;

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  served = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/model-config')
        ? Response.json(served)
        : // The agent runtime probe: off, so Skills is not listed.
          Response.json({ enabled: false, runtimeEnabled: false }),
    ),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  modelSettingsClient.adopt(null);
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return host;
}

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
  }
}

function click(element: HTMLElement) {
  act(() => element.click());
}

function byText(text: string, selector = 'button'): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No ${selector} with ${text}`);
  return found;
}

const T = (key: string, options?: Record<string, unknown>) =>
  options ? [key, ...Object.values(options)].join('|') : key;

const providers = {
  operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' },
  voice: { preset: 'minimax', apiKey: 'sk-operator-secret-0002' },
};

/** The view the server answers for a deployment configuration (and a workspace's own). */
function viewFor(
  config: ModelConfigLayer['config'],
  stored: StoredWorkspaceConfig | null = null,
): ModelSettingsView {
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
  return modelSettingsView(stored);
}

function recordingApply(view: ModelSettingsView) {
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    return { ok: true, view };
  });
  return { apply, changes };
}

async function openDialog(view: ModelSettingsView) {
  served = view;
  modelSettingsClient.adopt(view);
  mount(createElement(SettingsDialog, { open: true, onOpenChange: () => {} }));
  await flush();
  return [...document.body.querySelectorAll('[data-testid^="settings-nav-"]')].map((item) =>
    item.getAttribute('data-testid')!.replace('settings-nav-', ''),
  );
}

describe('the settings sections', () => {
  it('lists Token Plan, Model Services and Course Model when users may set things up', async () => {
    const nav = await openDialog(
      viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' } }),
    );
    expect(nav).toEqual(['token-plan', 'model-services', 'course-models', 'general']);
  });

  it('lists only Course Model without user keys', async () => {
    const nav = await openDialog(
      viewFor({
        providers,
        slots: { llm: 'operator:deepseek-v4-pro', document: null },
        allowUserKeys: false,
        lock: ['document'],
      }),
    );
    expect(nav).toEqual(['course-models', 'general']);
    // Opened on its default section (Token Plan), it lands on Course Model.
    expect(document.body.textContent).toContain('settings.courseModels.nav');
  });

  it('keeps the Text-to-Speech tab for user voices without user keys', async () => {
    const nav = await openDialog(
      viewFor({
        providers: {
          ...providers,
          qwen: { preset: 'qwen-tts', apiKey: 'sk-operator-secret-0003' },
        },
        slots: { llm: 'operator:deepseek-v4-pro', tts: 'qwen:qwen3-tts-flash' },
        allowUserKeys: false,
      }),
    );
    expect(nav).toEqual(['model-services', 'course-models', 'general']);
    click(document.body.querySelector<HTMLElement>('[data-testid="settings-nav-model-services"]')!);
    await flush();
    const tabs = [...document.body.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['settings.ttsSettings']);
    // The service in use is the server's, read-only, with no "add your own" to it.
    const notice = document.body.querySelector('[data-server-configured-notice]');
    expect(notice?.textContent).toContain('settings.serverConfiguredNotice');
    expect(notice?.textContent).not.toContain('settings.serverConfiguredAddOwn');
    expect(document.body.textContent).not.toContain('settings.modelServices.notConfiguredHint');
    expect(document.body.textContent).not.toContain('settings.modelServices.pending');
  });

  it('suggests adding a provider of your own only where that can change something', async () => {
    await openDialog(
      viewFor({
        providers: {
          ...providers,
          qwen: { preset: 'qwen-tts', apiKey: 'sk-operator-secret-0003' },
        },
        slots: { llm: 'operator:deepseek-v4-pro', tts: 'qwen:qwen3-tts-flash' },
      }),
    );
    click(document.body.querySelector<HTMLElement>('[data-testid="settings-nav-model-services"]')!);
    await flush();
    click(byText('settings.ttsSettings', '[role="tab"]'));
    await flush();
    expect(document.body.querySelector('[data-server-configured-notice]')?.textContent).toContain(
      'settings.serverConfiguredAddOwn',
    );
  });

  it('hides Token Plan when no plan can fill a slot that is not locked', async () => {
    const nav = await openDialog(
      viewFor({
        providers,
        slots: {
          llm: 'operator:deepseek-v4-pro',
          tts: 'voice:speech-2.8-turbo',
          image: null,
          video: null,
          webSearch: null,
        },
        lock: ['llm', 'tts', 'image', 'video', 'webSearch'],
      }),
    );
    expect(nav).not.toContain('token-plan');
    expect(nav).toContain('model-services');
  });

  it('shows Model Services tabs only for capabilities that still have a slot to set', async () => {
    await openDialog(
      viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: ['llm'] }),
    );
    click(document.body.querySelector<HTMLElement>('[data-testid="settings-nav-model-services"]')!);
    await flush();
    const tabs = [...document.body.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).not.toContain('settings.providers');
    expect(tabs).toContain('settings.imageSettings');
    expect(document.body.textContent).not.toContain('settings.addProviderButton');
  });

  it('shows the diagram with every card read-only when the administrator fixed everything', async () => {
    const nav = await openDialog(
      viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: 'all' }),
    );
    expect(nav).toEqual(['course-models', 'general']);
    expect(document.body.querySelector('[data-admin-notice]')?.textContent).toContain(
      'settings.modelSettings.adminNotice',
    );
    expect(document.body.querySelector('[data-locked-slot="llm"]')?.textContent).toMatch(
      /DeepSeek V4 Pro/,
    );
    expect(document.body.querySelector('[data-locked-slot="image"]')?.textContent).toContain(
      'settings.modelSettings.card.unassigned',
    );
    expect(document.body.querySelector('[data-slot-id]')).toBeNull();
    expect(document.body.querySelector('[role="switch"]')).toBeNull();
  });
});

describe('labels without user keys or with everything locked', () => {
  // The preset catalogue is not served then; provider names must still show.
  const labelled = {
    providers: {
      deepseek: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' },
      mineru: { preset: 'mineru', baseUrl: 'https://mineru.example' },
      bocha: { preset: 'bocha', apiKey: 'sk-operator-secret-0003' },
    },
    slots: { llm: 'deepseek:deepseek-v4-flash', document: 'mineru', webSearch: 'bocha' },
  } satisfies ModelConfigLayer['config'];

  it('names deployment providers on the map and in the pickers under allowUserKeys: false', () => {
    const view = viewFor({ ...labelled, allowUserKeys: false, lock: ['document'] });
    expect(view.presets).toEqual([]);
    const { apply } = recordingApply(view);
    mount(createElement(ModelMap, { view, apply, t: T }));
    expect(document.body.querySelector('[data-locked-slot="document"]')?.textContent).toContain(
      'MinerU',
    );
    expect(document.body.querySelector('[data-slot-id="webSearch"]')?.textContent).toContain(
      'Bocha',
    );
    expect(document.body.querySelector('[data-slot-id="llm"]')?.textContent).toContain('DeepSeek');
    const slot = view.slots.find((entry) => entry.slot === 'llm')!;
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));
    expect(
      document.body
        .querySelector('[data-slot-picker="llm"] [role="group"]')
        ?.getAttribute('aria-label'),
    ).toBe('DeepSeek');
  });

  it('names them on the read-only diagram', async () => {
    await openDialog(viewFor({ ...labelled, lock: 'all' }));
    const line = (slot: string) =>
      document.body.querySelector(`[data-locked-slot="${slot}"]`)?.textContent;
    expect(line('document')).toContain('MinerU');
    expect(line('webSearch')).toContain('Bocha');
    expect(line('llm')).toContain('DeepSeek');
  });
});

describe('the course model map', () => {
  it('draws a locked card as one read-only line, its children fixed with it', () => {
    const view = viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: ['llm'] });
    const { apply } = recordingApply(view);
    mount(createElement(ModelMap, { view, apply, t: T }));
    const llm = document.body.querySelector('[data-locked-slot="llm"]');
    expect(llm?.textContent).toContain('settings.modelSettings.source.locked');
    expect(llm?.textContent).toContain('DeepSeek V4 Pro');
    // The outline follows the locked root: nothing to open on it either.
    expect(document.body.querySelector('[data-locked-slot="course.outline"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot-id="course.outline"]')).toBeNull();
    // Image is not locked: its line is a picker.
    expect(document.body.querySelector('[data-slot-id="image"]')).not.toBeNull();
  });

  it('says a value is the server default', () => {
    const view = viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' } });
    const { apply } = recordingApply(view);
    mount(createElement(ModelMap, { view, apply, t: T }));
    expect(document.body.querySelector('[data-slot-id="llm"]')?.textContent).toContain(
      'settings.modelSettings.source.default',
    );
  });

  it('offers "Reset to server default" once the user changed it, and resets by clearing', async () => {
    const view = viewFor(
      { providers, slots: { 'course.outline': 'operator:deepseek-v4-pro' } },
      {
        config: { slots: { 'course.outline': 'operator:deepseek-v4-flash' } },
        revision: 1,
        unreadableSecrets: [],
      },
    );
    const slot = view.slots.find((entry) => entry.slot === 'course.outline')!;
    const { apply, changes } = recordingApply(view);
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));
    // The server default replaces following the parent.
    expect(document.body.textContent).not.toContain('settings.modelSettings.picker.follow');
    click(byText('settings.modelSettings.picker.resetDefault'));
    await flush();
    expect(changes).toEqual([{ kind: 'slots', clear: ['course.outline'] }]);
  });

  it("follows the user's parent over a server default on the slot, and still offers that default", async () => {
    const view = viewFor(
      { providers, slots: { 'course.outline': 'operator:deepseek-v4-pro' } },
      {
        config: { slots: { llm: 'operator:deepseek-v4-flash' } },
        revision: 1,
        unreadableSecrets: [],
      },
    );
    const slot = view.slots.find((entry) => entry.slot === 'course.outline')!;
    expect(slot.source).toEqual({ kind: 'inherited', from: 'llm' });
    const { apply, changes } = recordingApply(view);
    mount(createElement(ModelMap, { view, apply, t: T }));
    expect(document.body.querySelector('[data-slot-id="course.outline"]')?.textContent).toContain(
      'settings.modelSettings.source.inherited',
    );
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));
    const follow = byText('settings.modelSettings.picker.follow');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    // The default is written as the slot's own: clearing would follow the parent.
    click(byText('settings.modelSettings.picker.serverDefault'));
    await flush();
    expect(changes).toEqual([
      { kind: 'slots', set: { 'course.outline': 'operator:deepseek-v4-pro' } },
    ]);
  });

  it('marks the server default as the current choice while the user has not changed it', () => {
    const view = viewFor({ providers, slots: { 'course.outline': 'operator:deepseek-v4-pro' } });
    const slot = view.slots.find((entry) => entry.slot === 'course.outline')!;
    const { apply } = recordingApply(view);
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));
    const row = byText('settings.modelSettings.picker.serverDefault');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).not.toContain('settings.modelSettings.picker.resetDefault');
  });

  it('renders the map in Course Model Config whenever something can change', () => {
    const view = viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: ['llm'] });
    const { apply } = recordingApply(view);
    mount(createElement(CourseModelMap, { view, apply, onManageProviders: () => {} }));
    expect(document.body.querySelector('[data-admin-notice]')).toBeNull();
    expect(document.body.querySelector('[data-slot-id="image"]')).not.toBeNull();
  });
});

describe('the home toolbar model picker', () => {
  const toolbar = () =>
    createElement(GenerationToolbar, {
      courseMaterials: [],
      onCourseMaterialsAdd: () => {},
      onCourseMaterialRemove: () => {},
      onPdfError: () => {},
      onSettingsOpen: () => {},
    });

  it('offers the choice while llm can be set', () => {
    modelSettingsClient.adopt(viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' } }));
    mount(toolbar());
    expect(document.body.querySelector('[aria-label="toolbar.pickModel"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label*="deepseek-v4-pro"]')).not.toBeNull();
  });

  it('keeps the picker for unlocked server defaults on the stages, which choosing a default replaces', async () => {
    const config = {
      providers,
      slots: {
        llm: 'operator:deepseek-v4-pro',
        'course.outline': 'operator:deepseek-v4-flash',
        'course.content': 'operator:deepseek-v4-flash',
        'course.actions': 'operator:deepseek-v4-flash',
      },
    } satisfies ModelConfigLayer['config'];
    const view = viewFor(config);
    modelSettingsClient.adopt(view);
    mount(toolbar());
    expect(document.body.querySelector('button[aria-label*="deepseek-v4-pro"]')).not.toBeNull();

    // Choosing a default model moves every stage onto it.
    const chosen = await applyModelSettingsChange(null, {
      kind: 'slots',
      set: { llm: 'operator:deepseek-v4-flash' },
    });
    const after = viewFor(config, { config: chosen, revision: 1, unreadableSecrets: [] });
    for (const stage of ['course.outline', 'course.content.slide', 'course.actions']) {
      expect(after.slots.find((slot) => slot.slot === stage)).toMatchObject({
        source: { kind: 'inherited', from: 'llm' },
        effective: { source: 'workspace', modelId: 'deepseek-v4-flash' },
      });
    }
  });

  it('keeps the picker when the workspace or a lock holds every stage', () => {
    modelSettingsClient.adopt(
      viewFor(
        {
          providers,
          slots: {
            llm: 'operator:deepseek-v4-pro',
            'course.content': 'operator:deepseek-v4-flash',
          },
          lock: ['course.content'],
        },
        {
          config: {
            slots: {
              'course.outline': 'operator:deepseek-v4-flash',
              'course.actions': 'operator:deepseek-v4-flash',
            },
          },
          revision: 1,
          unreadableSecrets: [],
        },
      ),
    );
    mount(toolbar());
    // Changing the default still changes every slot that follows it.
    expect(document.body.querySelector('button[aria-label*="deepseek-v4-pro"]')).not.toBeNull();
  });

  it('renders no model control at all when the administrator fixed llm', () => {
    modelSettingsClient.adopt(
      viewFor({ providers, slots: { llm: 'operator:deepseek-v4-pro' }, lock: ['llm'] }),
    );
    mount(toolbar());
    expect(document.body.textContent).not.toMatch(/deepseek-v4-pro|DeepSeek V4 Pro/);
    expect(document.body.querySelector('[aria-label="toolbar.pickModel"]')).toBeNull();
    expect(document.body.textContent).not.toContain('toolbar.configureProvider');
  });

  it('offers no setup shortcut where nothing can set up a language model', () => {
    modelSettingsClient.adopt(viewFor({ lock: 'all' }));
    mount(toolbar());
    expect(document.body.textContent).not.toContain('toolbar.configureProvider');
  });
});
