// @vitest-environment jsdom

/**
 * The settings panels (Token Plan, Model Services, Course Model) on the
 * server's model configuration, driven through their components: what each
 * action sends to `/api/model-config`, what the server's locks disable, and
 * that no other request carries a key.
 *
 * The i18n hook returns keys (with interpolated values appended) and the
 * select primitive renders as a native <select>, so the flows can be driven
 * without a layout engine. Popovers and switches render for real.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/components/ui/select', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = { children?: React.ReactNode };
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: Props & {
      value?: string;
      disabled?: boolean;
      onValueChange?: (value: string) => void;
    }) =>
      h(
        'select',
        {
          value: value ?? '',
          disabled,
          onChange: (event: { target: { value: string } }) => onValueChange?.(event.target.value),
        },
        h('option', { value: '' }),
        children,
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: Props) => h(Fragment, null, children),
    SelectGroup: ({ children }: Props) => h(Fragment, null, children),
    SelectLabel: () => null,
    SelectItem: ({ value, children }: Props & { value: string }) =>
      h('option', { value }, children),
  };
});

import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { ModelServicesPanel } from '@/components/settings/model-services';
import { ModelMap } from '@/components/settings/models/model-map';
import { llmPickerGroups } from '@/components/settings/use-llm-picker-groups';
import { ProviderConfigPanel } from '@/components/settings/provider-config-panel';
import { TokenPlanSettings } from '@/components/settings/token-plan-settings';
import { TTSSettings } from '@/components/settings/tts-settings';
import {
  createModelSettingsClient,
  modelSettingsClient,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type PresetView,
} from '@/lib/model-settings/client';
import { serviceEntries } from '@/lib/model-settings/services';

import { chatPreset, makeView, withLlm, workspaceProvider } from '../model-settings/fixtures';

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
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return { render: (next: ReactElement) => act(() => root.render(next)) };
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
  }
}

function byLabel(label: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No element labelled ${label}`);
  return found;
}

function byText(text: string, selector = 'button'): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No ${selector} with ${text}`);
  return found;
}

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

/** Type into a React-controlled field. */
function type(element: HTMLElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

function blur(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** An apply that records each change and answers with the view it is given per call. */
function recordingApply(answer: (change: ModelSettingsChange) => ModelSettingsView) {
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    return { ok: true, view: answer(change) };
  });
  return { apply, changes };
}

/** Pick a model in an open picker (or the follow row) by its visible text. */
function pickInPopover(text: string) {
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="button"], button')].find(
    (element) => element.textContent?.trim().startsWith(text),
  );
  if (!option) throw new Error(`No option ${text}`);
  click(option);
}

describe('Model Services → provider changes', () => {
  it("saves a service's key as a workspace provider and fills the empty default model", async () => {
    const view = makeView();
    const added = { ...view, providers: [workspaceProvider('acme')] };
    const { apply, changes } = recordingApply((change) =>
      change.kind === 'provider' ? added : added,
    );
    const entry = serviceEntries(view, 'chat', ['acme'])[0];
    expect(entry).toMatchObject({ id: 'acme', state: 'available' });
    mount(createElement(ProviderConfigPanel, { view, apply, entry }));

    const key = byLabel('llm-api-key-acme');
    type(key, 'sk-new-key-1234');
    blur(key);
    await flush();

    expect(changes).toEqual([
      { kind: 'provider', id: 'acme', preset: 'acme', apiKey: 'sk-new-key-1234' },
      // The new provider fills the root slots of what it serves that have nothing set.
      { kind: 'slots', set: { llm: 'acme:acme-large', tts: 'acme:acme-voice', webSearch: 'acme' } },
    ]);
  });

  it('keeps a typed key in the field when the server refuses it, and clears it once saved', async () => {
    const view = makeView();
    const answers: ApplyResult[] = [
      { ok: false, reason: 'invalid', message: 'bad key' },
      { ok: true, view: { ...view, providers: [workspaceProvider('acme')] } },
      { ok: true, view: { ...view, providers: [workspaceProvider('acme')] } },
    ];
    const apply = vi.fn(async () => answers.shift()!);
    const entry = serviceEntries(view, 'chat', ['acme'])[0];
    mount(createElement(ProviderConfigPanel, { view, apply, entry }));

    const key = byLabel('llm-api-key-acme') as HTMLInputElement;
    type(key, 'sk-typed-0001');
    blur(key);
    await flush();
    expect(key.value).toBe('sk-typed-0001');
    blur(key);
    await flush();
    expect(key.value).toBe('');
  });

  it('keeps a stored key write-only: replace sends the new one, remove sends an empty one', async () => {
    const view = makeView({ providers: [workspaceProvider('acme')] });
    const { apply, changes } = recordingApply(() => view);
    const entry = serviceEntries(view, 'chat', ['acme'])[0];
    mount(createElement(ProviderConfigPanel, { view, apply, entry }));

    // The mask is shown, never the key.
    expect(document.body.textContent).toContain('settings.serverConfig.keyStored|…abcd');
    click(byText('settings.serverConfig.removeKey'));
    await flush();
    expect(changes).toEqual([{ kind: 'provider', id: 'acme', preset: 'acme', apiKey: '' }]);
  });

  it("shows the server's providers read-only and says what only the server can set up", () => {
    const view = makeView({
      providers: [{ ...workspaceProvider('operator'), source: 'deployment', key: undefined }],
      presets: [],
      allowUserKeys: false,
    });
    const { apply } = recordingApply(() => view);
    mount(
      createElement(ModelServicesPanel, { view, apply, tab: 'providers', onTabChange: () => {} }),
    );
    expect(document.body.textContent).toContain('settings.serverConfiguredNotice');
    expect(document.body.querySelector('[name="llm-api-key-operator"]')).toBeNull();

    // Another service: the server does not let the workspace add it.
    click(byText('OpenAI'));
    expect(document.body.textContent).toContain('settings.serverConfig.serverOnlyPolicy');
  });

  it('brings the selected service into view, so the highlighted row is the one the panel shows', () => {
    // A connected token plan whose provider is named after a built-in service
    // far down the list, and in use: the panel opens on it.
    const plan: PresetView = { ...chatPreset, id: 'minimax', name: 'MiniMax' };
    const view = withLlm(
      makeView({ presets: [plan], providers: [workspaceProvider('minimax', plan)] }),
      'minimax:acme-large',
    );
    const { apply } = recordingApply(() => view);
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    const selectedRow = () => {
      const rows = [...document.body.querySelectorAll<HTMLElement>('button[aria-pressed="true"]')];
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    const panelTitle = () =>
      document.body.querySelector('.overflow-y-auto.p-4 p.truncate')?.textContent ?? '';
    try {
      mount(
        createElement(ModelServicesPanel, { view, apply, tab: 'providers', onTabChange: () => {} }),
      );
      // The list does not open on its first row: the plan's row is selected
      // further down, and the panel beside it shows that same service.
      const rows = [...document.body.querySelectorAll<HTMLElement>('button[aria-pressed]')];
      expect(rows.indexOf(selectedRow())).toBeGreaterThan(0);
      expect(selectedRow().textContent).toContain('MiniMax');
      expect(panelTitle()).toBe('MiniMax');
      expect(scrolled).toEqual([selectedRow()]);

      // Picking another row moves the highlight and the panel together.
      click(byText('OpenAI'));
      expect(selectedRow().textContent).toContain('OpenAI');
      expect(panelTitle()).toBe('OpenAI');
      expect(scrolled.at(-1)).toBe(selectedRow());
    } finally {
      vi.mocked(Element.prototype.scrollIntoView).mockRestore();
    }
  });

  it('sends no key with anything but the settings write', async () => {
    const view = makeView({
      presets: [chatPreset],
      providers: [],
    });
    const added = { ...view, revision: 1, providers: [workspaceProvider('acme')] };
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/model-config') {
        return new Response(JSON.stringify(init?.method === 'PUT' ? added : view), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createModelSettingsClient(fetchMock);
    await client.load();
    const entry = serviceEntries(view, 'chat', ['acme'])[0];
    const { render } = mount(
      createElement(ProviderConfigPanel, { view, apply: client.apply, entry }),
    );
    const key = byLabel('llm-api-key-acme');
    type(key, 'sk-secret-9876');
    blur(key);
    await flush();
    // The panel now shows the saved provider: test it.
    const saved = serviceEntries(added, 'chat', ['acme'])[0];
    render(createElement(ProviderConfigPanel, { view: added, apply: client.apply, entry: saved }));
    click(byText('settings.testConnection'));
    await flush();

    const verify = calls.find((call) => call.url === '/api/verify-model');
    expect(JSON.parse(String(verify?.init?.body))).toEqual({
      provider: 'acme',
      model: 'acme-large',
    });
    for (const call of calls) {
      const isWrite = call.url === '/api/model-config' && call.init?.method === 'PUT';
      const text = `${call.url} ${String(call.init?.body ?? '')} ${JSON.stringify(call.init?.headers ?? {})}`;
      if (!isWrite) {
        expect(text).not.toContain('sk-secret-9876');
        expect(text).not.toMatch(/apiKey|x-api-key/i);
      }
    }
    expect(calls.some((call) => String(call.init?.body ?? '').includes('sk-secret-9876'))).toBe(
      true,
    );
  });
});

describe('Token Plan → provider and recommended slots', () => {
  it('connecting adds the plan provider and fills the empty slots it recommends', async () => {
    const plan: PresetView = {
      ...chatPreset,
      id: 'tokendance',
      name: 'TokenDance',
      recommended: { llm: 'acme-large', 'course.content.slide': 'acme-small' },
    };
    const view = makeView({ presets: [plan] });
    const added = {
      ...view,
      providers: [{ ...workspaceProvider('tokendance', plan) }],
    };
    const { apply, changes } = recordingApply(() => added);
    mount(createElement(TokenPlanSettings, { view, apply }));
    click(byText('TokenDance'));
    type(byLabel('settings.tokenPlan.apiKey'), 'td-key-123456');
    act(() => {
      (document.body.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(changes).toEqual([
      { kind: 'provider', id: 'tokendance', preset: 'tokendance', apiKey: 'td-key-123456' },
      {
        kind: 'slots',
        set: { llm: 'tokendance:acme-large', 'course.content.slide': 'tokendance:acme-small' },
      },
    ]);
  });

  it('disconnecting removes the plan provider', async () => {
    const plan: PresetView = { ...chatPreset, id: 'tokendance', name: 'TokenDance' };
    const view = makeView({ presets: [plan], providers: [workspaceProvider('tokendance', plan)] });
    const { apply, changes } = recordingApply(() => view);
    mount(createElement(TokenPlanSettings, { view, apply }));
    click(byText('TokenDance'));
    expect(document.body.textContent).toContain('settings.tokenPlan.statusConnected');
    act(() => {
      byLabel('settings.tokenPlan.disconnect').dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flush();
    click(byText('settings.tokenPlan.disconnect', '[role="menuitem"]'));
    await flush();
    click(byText('settings.tokenPlan.disconnect', '[role="alertdialog"] button'));
    await flush();
    expect(changes).toEqual([{ kind: 'remove-provider', id: 'tokendance' }]);
  });
});

/** The server's providers as a deployment declares them: an OpenAI-compatible gateway and DeepSeek. */
function deploymentView(): ModelSettingsView {
  return makeView({
    presets: [],
    allowUserKeys: false,
    providers: [
      {
        id: 'gateway',
        preset: 'openai-compatible',
        presetName: 'OpenAI-compatible endpoint',
        presetKind: 'single',
        source: 'deployment',
        models: ['gpt-5.1', 'gpt-5.4-mini', 'deepseek-v4-flash-0731'],
        capabilities: {
          chat: {
            registryId: 'openai',
            models: ['gpt-5.1', 'gpt-5.4-mini', 'deepseek-v4-flash-0731'].map((id) => ({
              id,
              name: id,
            })),
          },
        },
      },
      {
        id: 'deepseek',
        preset: 'deepseek',
        presetName: 'DeepSeek',
        presetKind: 'single',
        source: 'deployment',
        capabilities: {
          chat: {
            registryId: 'deepseek',
            models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
          },
        },
      },
    ],
  });
}

describe("the server's providers wherever chat models are offered", () => {
  it('offers their models in the shared picker groups', () => {
    const groups = llmPickerGroups(deploymentView());
    expect(groups.map((group) => [group.id, group.models.map((model) => model.id)])).toEqual([
      ['gateway', ['gpt-5.1', 'gpt-5.4-mini', 'deepseek-v4-flash-0731']],
      ['deepseek', ['deepseek-v4-pro']],
    ]);
  });

  it('offers them on the map instead of saying no model is available', () => {
    const view = deploymentView();
    const { apply, changes } = recordingApply(() => view);
    mount(
      createElement(ModelMap, {
        view,
        apply,
        t: (key: string, options?: Record<string, unknown>) =>
          options ? [key, ...Object.values(options)].join('|') : key,
        onManageProviders: () => {},
        offMemory: new Map(),
      }),
    );
    expect(document.body.textContent).not.toContain('settings.modelSettings.empty.prompt');
    click(document.body.querySelector<HTMLElement>('[data-slot-id="llm"]')!);
    pickInPopover('gpt-5.4-mini');
    return flush().then(() => {
      expect(changes.at(-1)).toEqual({ kind: 'slots', set: { llm: 'gateway:gpt-5.4-mini' } });
    });
  });

  it('offers them in the home toolbar', () => {
    modelSettingsClient.adopt(deploymentView());
    try {
      mount(
        createElement(GenerationToolbar, {
          courseMaterials: [],
          onCourseMaterialsAdd: () => {},
          onCourseMaterialRemove: () => {},
          onPdfError: () => {},
          onSettingsOpen: () => {},
        }),
      );
      expect(document.body.querySelector('[aria-label="toolbar.pickModel"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain('toolbar.configureProvider');
    } finally {
      modelSettingsClient.adopt(null);
    }
  });

  it('names a custom endpoint by its preset and id, and merges one named after a service', () => {
    const view = deploymentView();
    const { apply } = recordingApply(() => view);
    mount(
      createElement(ModelServicesPanel, { view, apply, tab: 'providers', onTabChange: () => {} }),
    );
    const rows = [...document.body.querySelectorAll<HTMLElement>('button[aria-pressed]')];
    const gateway = rows.find((row) =>
      row.textContent?.includes('settings.serverConfig.openaiCompatible · gateway'),
    );
    expect(gateway).toBeDefined();
    // A generic logo, not OpenAI's.
    expect(gateway!.querySelector('img')).toBeNull();
    // The server's `deepseek` is the DeepSeek entry, configured, listed once.
    const deepseek = rows.filter((row) => row.textContent?.includes('DeepSeek'));
    expect(deepseek).toHaveLength(1);
    expect(deepseek[0].textContent).toContain('settings.modelServices.configured');
    expect(deepseek[0].textContent).not.toContain('·');
  });
});

describe('TTS panel → Gemini TTS', () => {
  const geminiTts: PresetView = {
    id: 'google-tts',
    name: 'Google Gemini TTS',
    kind: 'single',
    capabilities: {
      tts: {
        registryId: 'google-tts',
        models: [{ id: 'gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS Preview' }],
      },
    },
    requiresBaseUrl: false,
    customEndpoint: false,
    recommended: {},
  };

  it('saves its key as a workspace provider and locks the speed it ignores', async () => {
    const view = makeView({ presets: [geminiTts] });
    const added = {
      ...view,
      providers: [workspaceProvider('google-tts', geminiTts)],
    };
    const { apply, changes } = recordingApply(() => added);
    const entry = serviceEntries(view, 'tts', ['google-tts'])[0];
    expect(entry).toMatchObject({ id: 'google-tts', state: 'available' });
    mount(createElement(TTSSettings, { view, apply, entry }));

    const speed = byLabel('settings.ttsSpeed') as HTMLInputElement;
    expect(speed.disabled).toBe(true);
    expect(speed.value).toBe('1');
    expect(document.body.textContent).toContain('settings.ttsSpeedUnsupported');
    expect(document.body.textContent).toContain(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );

    const key = byLabel('tts-api-key-google-tts');
    type(key, 'gemini-key-1234');
    blur(key);
    await flush();
    expect(changes[0]).toEqual({
      kind: 'provider',
      id: 'google-tts',
      preset: 'google-tts',
      apiKey: 'gemini-key-1234',
    });
  });
});

describe('review fixes', () => {
  it('makes the browser speech the narration from an empty workspace', async () => {
    const browserTts: PresetView = {
      id: 'browser-native-tts',
      name: 'Browser TTS',
      kind: 'single',
      capabilities: { tts: { registryId: 'browser-native-tts', models: [] } },
      requiresBaseUrl: false,
      customEndpoint: false,
      recommended: {},
    };
    const empty = makeView({ revision: 1, presets: [browserTts] });
    const added = {
      ...empty,
      revision: 2,
      providers: [
        {
          id: 'browser-native-tts',
          preset: 'browser-native-tts',
          presetName: 'Browser TTS',
          presetKind: 'single' as const,
          source: 'workspace' as const,
          capabilities: browserTts.capabilities,
          key: { set: false },
        },
      ],
    };
    const changes: ModelSettingsChange[] = [];
    const bases: (number | null)[] = [];
    const apply = vi.fn(async (change: ModelSettingsChange, basis?: ModelSettingsView) => {
      changes.push(change);
      bases.push(basis?.revision ?? null);
      return { ok: true as const, view: added };
    });
    const entry = serviceEntries(empty, 'tts', ['browser-native-tts'])[0];
    expect(entry.state).toBe('available');
    mount(createElement(TTSSettings, { view: empty, apply, entry }));
    click(byText('settings.serverConfig.useForNarration'));
    await flush();
    expect(changes).toEqual([
      { kind: 'provider', id: 'browser-native-tts', preset: 'browser-native-tts' },
      { kind: 'slots', set: { tts: 'browser-native-tts' } },
    ]);
    expect(bases).toEqual([1, 2]);
  });

  it('does not report fetched models as added when saving them is refused', async () => {
    const view = makeView({ providers: [workspaceProvider('acme')] });
    const apply = vi.fn(
      async (): Promise<ApplyResult> => ({ ok: false, reason: 'conflict', message: 'stale' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, models: [{ id: 'acme-new' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const entry = serviceEntries(view, 'chat', ['acme'])[0];
    mount(createElement(ProviderConfigPanel, { view, apply, entry }));
    click(byText('settings.fetchModels'));
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('settings.serverConfig.fetchNotSaved');
    expect(document.body.textContent).not.toContain('settings.fetchModelsResult');
    // The button stays usable for another try.
    expect((byText('settings.fetchModels') as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the provider's logo on the home picker and on every group and model", () => {
    const view = deploymentView();
    view.slots = view.slots.map((slot) =>
      slot.slot === 'llm'
        ? {
            ...slot,
            assignment: 'deepseek:deepseek-v4-pro',
            effective: {
              status: 'assigned',
              resolvedAt: 'llm',
              source: 'workspace',
              requirements: [],
              providerId: 'deepseek',
              providerSource: 'deployment',
              presetId: 'deepseek',
              registryId: 'deepseek',
              modelId: 'deepseek-v4-pro',
            },
          }
        : slot,
    );
    const groups = llmPickerGroups(view);
    expect(groups.find((group) => group.id === 'deepseek')?.icon).toContain('deepseek');
    // A custom endpoint gets the generic icon (null), as in Model Services.
    expect(groups.find((group) => group.id === 'gateway')?.icon).toBeNull();
    modelSettingsClient.adopt(view);
    try {
      mount(
        createElement(GenerationToolbar, {
          courseMaterials: [],
          onCourseMaterialsAdd: () => {},
          onCourseMaterialRemove: () => {},
          onPdfError: () => {},
          onSettingsOpen: () => {},
        }),
      );
      const trigger = document.body.querySelector<HTMLElement>(
        '[aria-label="deepseek / deepseek-v4-pro"]',
      )!;
      expect(trigger.querySelector('img')?.getAttribute('src')).toContain('deepseek');
      click(trigger);
      const options = [...document.body.querySelectorAll<HTMLElement>('[role="button"]')];
      expect(options.length).toBe(4);
      for (const option of options) {
        const gateway =
          option.textContent?.includes('gpt-') || option.textContent?.includes('flash');
        if (gateway) expect(option.querySelector('svg.lucide-box')).not.toBeNull();
        else expect(option.querySelector('img')?.getAttribute('src')).toContain('deepseek');
      }
    } finally {
      modelSettingsClient.adopt(null);
    }
  });
});
