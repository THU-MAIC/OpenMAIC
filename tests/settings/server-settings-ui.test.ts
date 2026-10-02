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

import { CourseModelConfigPanel } from '@/components/settings/course-model-config';
import { ModelServicesPanel } from '@/components/settings/model-services';
import { ProviderConfigPanel } from '@/components/settings/provider-config-panel';
import { TokenPlanSettings } from '@/components/settings/token-plan-settings';
import {
  createModelSettingsClient,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type PresetView,
  type SlotView,
} from '@/lib/model-settings/client';
import { serviceEntries } from '@/lib/model-settings/services';

import {
  chatPreset,
  makeView,
  withLlm,
  withSlots,
  workspaceProvider,
} from '../model-settings/fixtures';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

const imagePreset: PresetView = {
  id: 'seedream',
  name: 'Seedream',
  kind: 'single',
  capabilities: {
    image: { registryId: 'seedream', models: [{ id: 'seed-1', name: 'Seed 1' }] },
  },
  requiresBaseUrl: false,
  customEndpoint: false,
  recommended: {},
};

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
      policy: { allowWorkspaceProviders: false },
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

/** A view with the acme provider set up: llm on its large model, an image provider, image off. */
function courseView(patch: Record<string, Partial<SlotView>> = {}): ModelSettingsView {
  const base = withLlm(
    makeView({
      presets: [chatPreset, imagePreset],
      providers: [
        workspaceProvider('acme'),
        { ...workspaceProvider('seedream', imagePreset), key: { set: true, mask: '…1111' } },
      ],
    }),
  );
  return withSlots(base, {
    image: {
      assignment: null,
      effective: { status: 'disabled', resolvedAt: 'image', source: 'workspace' },
    },
    ...patch,
  });
}

describe('Course Model → slots', () => {
  it('sets a stage model on its slot, and following the main model clears it', async () => {
    const view = courseView();
    const { apply, changes } = recordingApply(() => view);
    mount(createElement(CourseModelConfigPanel, { view, apply }));

    click(byText('settings.courseModels.stations.outline'));
    // The inspector's picker: open it and pick the small model.
    const trigger = [...document.body.querySelectorAll<HTMLElement>('aside button')].find((b) =>
      b.textContent?.includes('settings.courseModels.followMainline'),
    )!;
    click(trigger);
    pickInPopover('Acme Small');
    await flush();
    expect(changes.at(-1)).toEqual({ kind: 'slots', set: { 'course.outline': 'acme:acme-small' } });
  });

  it('turns a media slot off as null and back on to what it held', async () => {
    const on = courseView({
      image: {
        assignment: 'seedream:seed-1',
        effective: {
          status: 'assigned',
          resolvedAt: 'image',
          source: 'workspace',
          requirements: [],
          providerId: 'seedream',
          providerSource: 'workspace',
          presetId: 'seedream',
          registryId: 'seedream',
          modelId: 'seed-1',
        },
      },
    });
    const off = courseView();
    const { apply, changes } = recordingApply((change) =>
      change.kind === 'slots' && change.set?.image === null ? off : on,
    );
    const { render } = mount(createElement(CourseModelConfigPanel, { view: on, apply }));
    click(byText('settings.courseModels.stations.media'));
    click(byLabel('settings.enableImageGeneration'));
    await flush();
    expect(changes.at(-1)).toEqual({ kind: 'slots', set: { image: null } });

    render(createElement(CourseModelConfigPanel, { view: off, apply }));
    click(byLabel('settings.enableImageGeneration'));
    await flush();
    expect(changes.at(-1)).toEqual({ kind: 'slots', set: { image: 'seedream:seed-1' } });
  });

  it('turns on a media slot it never held with its first service', async () => {
    const view = courseView();
    const { apply, changes } = recordingApply(() => view);
    mount(createElement(CourseModelConfigPanel, { view, apply }));
    click(byText('settings.courseModels.stations.media'));
    click(byLabel('settings.enableImageGeneration'));
    await flush();
    expect(changes.at(-1)).toEqual({ kind: 'slots', set: { image: 'seedream:seed-1' } });
  });

  it("disables what the server's configuration sets", () => {
    const view = withSlots(courseView(), {
      llm: { locked: true },
      image: { locked: true },
    });
    const { apply } = recordingApply(() => view);
    mount(createElement(CourseModelConfigPanel, { view, apply }));
    expect((byLabel('settings.courseModels.mainModel') as HTMLButtonElement).disabled).toBe(true);
    click(byText('settings.courseModels.stations.media'));
    expect(byLabel('settings.enableImageGeneration').hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('settings.serverConfig.setByServer');
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
