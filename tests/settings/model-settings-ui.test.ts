// @vitest-environment jsdom

/**
 * The Models settings section, driven through its components: what the
 * provider form sends, the map's switches and keyboard, the picker of a root
 * slot, and a first-run setup whose slot assignment meets a stale revision.
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

vi.mock('@/components/ui/select', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = { children?: React.ReactNode };
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: Props & { value?: string; onValueChange?: (value: string) => void }) =>
      h(
        'select',
        {
          value: value ?? '',
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

import { ModelMap, revealBox } from '@/components/settings/models/model-map';
import { SlotPicker } from '@/components/settings/models/slot-picker';
import {
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type PresetView,
  type ProviderView,
  type SlotView,
} from '@/lib/model-settings/client';

import { makeView, withSlots, workspaceProvider } from '../model-settings/fixtures';

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
});

function mount(element: ReactElement): { host: HTMLElement; render: (next: ReactElement) => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return { host, render: (next) => act(() => root.render(next)) };
}

async function flush() {
  for (let i = 0; i < 3; i++) {
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

function recordingApply(view: ModelSettingsView) {
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    return { ok: true, view };
  });
  return { apply, changes };
}

const T = (key: string, options?: Record<string, unknown>) =>
  options ? [key, ...Object.values(options)].join('|') : key;

const assignedTts: SlotView['effective'] = {
  status: 'assigned',
  resolvedAt: 'tts',
  source: 'workspace',
  requirements: [],
  providerId: 'acme',
  providerSource: 'workspace',
  presetId: 'acme',
  registryId: 'x',
  modelId: 'acme-voice',
};
const offEffective = (slot: SlotView['slot']): SlotView['effective'] => ({
  status: 'disabled',
  resolvedAt: slot,
  source: 'workspace',
});

function map(
  view: ModelSettingsView,
  apply: ReturnType<typeof recordingApply>['apply'],
  memory = new Map(),
) {
  return createElement(ModelMap, {
    view,
    apply,
    t: T,
    onManageProviders: () => {},
    offMemory: memory,
  });
}

describe('the map', () => {
  it('turns a media slot off and back on to the assignment it had', async () => {
    const on = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: 'acme:acme-voice', effective: assignedTts },
    });
    const off = withSlots(on, { tts: { assignment: null, effective: offEffective('tts') } });
    const { apply, changes } = recordingApply(on);
    const memory = new Map();
    const { render } = mount(map(on, apply, memory));

    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();
    render(map(off, apply, memory));
    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();

    expect(changes).toEqual([
      { kind: 'slots', set: { tts: null } },
      { kind: 'slots', set: { tts: 'acme:acme-voice' } },
    ]);
  });

  it('turns on a slot switched off elsewhere with the first service that serves it', async () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: null, effective: offEffective('tts') },
    });
    const { apply, changes } = recordingApply(view);
    mount(map(view, apply));

    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();

    expect(changes).toEqual([{ kind: 'slots', set: { tts: 'acme:acme-voice' } }]);
  });

  it('opens the picker when nothing can serve a slot switched off elsewhere', async () => {
    const view = withSlots(makeView(), {
      image: { assignment: null, effective: offEffective('image') },
    });
    const { apply } = recordingApply(view);
    mount(map(view, apply));

    click(byLabel('settings.modelSettings.card.toggle|image'));
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-slot-picker="image"]')).not.toBeNull();
  });

  it('keeps what it would restore when turning back on is refused', async () => {
    const on = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: 'acme:acme-voice', effective: assignedTts },
    });
    const off = withSlots(on, { tts: { assignment: null, effective: offEffective('tts') } });
    const memory = new Map();
    const answers: ApplyResult[] = [
      { ok: true, view: off },
      { ok: false, reason: 'conflict', message: 'stale', view: off },
      { ok: true, view: on },
    ];
    const changes: ModelSettingsChange[] = [];
    const apply = vi.fn(async (change: ModelSettingsChange) => {
      changes.push(change);
      return answers.shift()!;
    });
    const { render } = mount(map(on, apply, memory));
    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();
    render(map(off, apply, memory));
    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();
    // The refused restore did not forget what to restore: the next try sends it again.
    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();

    expect(changes).toEqual([
      { kind: 'slots', set: { tts: null } },
      { kind: 'slots', set: { tts: 'acme:acme-voice' } },
      { kind: 'slots', set: { tts: 'acme:acme-voice' } },
    ]);
    expect(memory.has('tts')).toBe(false);
  });

  it('switches speech input off while it runs in the browser, and lets a service be picked', async () => {
    const view = makeView({ providers: [workspaceProvider('acme')] });
    const { apply, changes } = recordingApply(view);
    mount(map(view, apply));

    const toggle = byLabel('settings.modelSettings.card.toggle|asr');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    click(toggle);
    await flush();
    expect(changes).toEqual([{ kind: 'slots', set: { asr: null } }]);
  });

  it('pans with the arrow keys while the canvas has focus', () => {
    const view = makeView();
    const { apply } = recordingApply(view);
    mount(map(view, apply));
    const canvas = byLabel('settings.modelSettings.map.label');
    const world = canvas.firstElementChild as HTMLElement;
    const x = () => Number(/translate\((-?[\d.]+)px/.exec(world.style.transform)?.[1]);
    const before = x();

    act(() => {
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(x()).toBe(before + 60);
    act(() => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(x()).toBe(before);
  });
});

describe('revealing a focused card', () => {
  const v = { x: 0, y: 0, k: 0.5 };
  it('leaves a card that shows alone', () => {
    expect(revealBox(v, { x: 100, y: 100, w: 196, h: 96 }, 400, 400)).toBe(v);
  });
  it('pans just enough to show a card off to the right or above', () => {
    expect(revealBox(v, { x: 900, y: 100, w: 196, h: 96 }, 400, 400)).toEqual({
      ...v,
      x: 400 - 16 - (450 + 98),
    });
    expect(revealBox({ ...v, y: -200 }, { x: 100, y: 100, w: 196, h: 96 }, 400, 400)).toEqual({
      ...v,
      y: -200 + (16 - (-200 + 50)),
    });
  });
});

describe('the picker of a root slot', () => {
  it('offers to clear an own setting and leave the server its say', async () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      document: { assignment: 'acme' },
    });
    const { apply, changes } = recordingApply(view);
    const slot = view.slots.find((entry) => entry.slot === 'document')!;
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));

    click(byText('settings.modelSettings.picker.clear'));
    await flush();

    expect(changes).toEqual([{ kind: 'slots', clear: ['document'] }]);
  });

  it('has nothing to clear when the root has no setting of its own', () => {
    const view = makeView({ providers: [workspaceProvider('acme')] });
    const { apply } = recordingApply(view);
    const slot = view.slots.find((entry) => entry.slot === 'llm')!;
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));
    expect(document.body.textContent).not.toContain('settings.modelSettings.picker.clear');
  });
});

describe('picker keyboard', () => {
  function key(element: Element, name: string) {
    act(() => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  }

  it('is one Tab stop, moved through with the arrows, Home and End, chosen with Enter', async () => {
    const view = makeView({ providers: [workspaceProvider('acme')] });
    const { apply, changes } = recordingApply(view);
    const slot = view.slots.find((entry) => entry.slot === 'classroom')!;
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));

    const rows = [...document.body.querySelectorAll<HTMLElement>('[data-picker-row]')];
    const labels = rows.map((row) => row.textContent);
    // Follow, the provider's two chat models, off: the current choice is the one Tab stop.
    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([rows[0]]);
    expect(rows[0].getAttribute('aria-pressed')).toBe('true');

    act(() => rows[0].focus());
    key(rows[0], 'ArrowDown');
    expect(document.activeElement?.textContent).toBe(labels[1]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(rows[0]);
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'Enter');
    await flush();

    expect(changes).toEqual([{ kind: 'slots', set: { classroom: 'acme:acme-large' } }]);
  });

  it('makes the current model the Tab stop, and chooses with Space', async () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      classroom: { assignment: 'acme:acme-small' },
    });
    const { apply, changes } = recordingApply(view);
    const slot = view.slots.find((entry) => entry.slot === 'classroom')!;
    mount(createElement(SlotPicker, { view, slot, apply, onDone: () => {}, t: T }));

    const stop = document.body.querySelector<HTMLElement>('[data-picker-row][tabindex="0"]')!;
    expect(stop.textContent).toBe('Acme Small');
    act(() => stop.focus());
    key(stop, 'ArrowUp');
    key(document.activeElement!, ' ');
    await flush();

    expect(changes).toEqual([{ kind: 'slots', set: { classroom: 'acme:acme-large' } }]);
  });
});

describe('the card picker', () => {
  const thinkingProvider = (): ProviderView => ({
    ...workspaceProvider('acme'),
    capabilities: {
      chat: {
        models: [
          {
            id: 'acme-large',
            name: 'Acme Large',
            capabilities: {
              thinking: { control: 'toggle', requestAdapter: 'openai', defaultMode: 'enabled' },
            },
          },
        ],
      },
    },
  });

  it("sets a stage's thinking on its own assignment, against the view it shows", async () => {
    const view = withSlots(makeView({ revision: 4, providers: [thinkingProvider()] }), {
      'course.outline': {
        assignment: 'acme:acme-large',
        effective: { ...assignedTts, resolvedAt: 'course.outline', modelId: 'acme-large' },
      },
    });
    const bases: (number | null)[] = [];
    const changes: ModelSettingsChange[] = [];
    const apply = vi.fn(async (change: ModelSettingsChange, basis?: ModelSettingsView) => {
      changes.push(change);
      bases.push(basis?.revision ?? null);
      return { ok: true as const, view };
    });
    mount(map(view, apply));
    click(document.body.querySelector<HTMLElement>('[data-slot-id="course.outline"]')!);
    const group = byLabel('settings.modelSettings.picker.thinking');
    const select = group.querySelector('select')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        select,
        'disabled',
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'slots',
      set: { 'course.outline': { model: 'acme:acme-large', thinking: { mode: 'disabled' } } },
    });
    expect(bases).toEqual([4]);
  });

  describe('thinking on the agent card', () => {
    const effortProvider = (): ProviderView => ({
      ...workspaceProvider('acme'),
      capabilities: {
        chat: {
          models: [
            {
              id: 'acme-large',
              name: 'Acme Large',
              capabilities: {
                thinking: {
                  control: 'effort',
                  requestAdapter: 'deepseek',
                  effortValues: ['none', 'high', 'max'],
                  defaultEffort: 'high',
                  defaultMode: 'enabled',
                  toggleable: true,
                },
              },
            },
            {
              id: 'acme-always',
              name: 'Acme Always',
              capabilities: {
                thinking: {
                  control: 'effort',
                  requestAdapter: 'openai',
                  effortValues: ['low', 'medium', 'high'],
                  defaultEffort: 'medium',
                },
              },
            },
          ],
        },
      },
    });
    const pickerFor = (slotId: string, assignment: SlotView['assignment']) => {
      const view = withSlots(makeView({ providers: [effortProvider()] }), {
        [slotId]: { assignment },
      });
      const recorded = recordingApply(view);
      const slot = view.slots.find((entry) => entry.slot === slotId)!;
      mount(
        createElement(SlotPicker, { view, slot, apply: recorded.apply, onDone: () => {}, t: T }),
      );
      return recorded;
    };
    const thinkingOptions = () =>
      [
        ...byLabel('settings.modelSettings.picker.thinking').querySelectorAll<HTMLOptionElement>(
          'option',
        ),
      ]
        .map((option) => option.value)
        .filter(Boolean);

    it('offers effort levels on another stage', () => {
      pickerFor('classroom', 'acme:acme-large');
      expect(thinkingOptions()).toEqual(['none', 'high', 'max']);
    });

    it('offers the agent on/off only, and saves no effort', async () => {
      const { changes } = pickerFor('agent', {
        model: 'acme:acme-large',
        // Saved before the agent refused one: the control shows it as on.
        thinking: { mode: 'enabled', effort: 'max' },
      });
      expect(thinkingOptions()).toEqual(['disabled', 'enabled']);
      const select = byLabel('settings.modelSettings.picker.thinking').querySelector('select')!;
      expect(select.value).toBe('enabled');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
          select,
          'disabled',
        );
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
      expect(changes).toEqual([
        {
          kind: 'slots',
          set: { agent: { model: 'acme:acme-large', thinking: { mode: 'disabled' } } },
        },
      ]);
    });

    it('offers the agent nothing for a model whose only control is an effort', () => {
      pickerFor('agent', 'acme:acme-always');
      expect(
        document.body.querySelector('[aria-label="settings.modelSettings.picker.thinking"]'),
      ).toBeNull();
    });
  });

  it('adds and assigns a service that needs no key, from an empty workspace', async () => {
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
    mount(map(empty, apply));
    click(document.body.querySelector<HTMLElement>('[data-slot-id="tts"]')!);
    const group = byLabel('settings.providerBrowserNativeTTS');
    click(
      byText(
        'settings.modelSettings.picker.providerDefault',
        '[aria-label="settings.providerBrowserNativeTTS"] button',
      ),
    );
    await flush();
    expect(group).toBeTruthy();
    expect(changes).toEqual([
      { kind: 'provider', id: 'browser-native-tts', preset: 'browser-native-tts' },
      { kind: 'slots', set: { tts: 'browser-native-tts' } },
    ]);
    // The assignment is written against the view the add answered.
    expect(bases).toEqual([1, 2]);
  });

  it("shows each provider's logo, the generic one for a custom endpoint", () => {
    const view = makeView({
      providers: [
        {
          ...workspaceProvider('deepseek'),
          preset: 'deepseek',
          presetName: 'DeepSeek',
          presetKind: 'single',
          capabilities: { chat: { registryId: 'deepseek', models: [{ id: 'd', name: 'D' }] } },
        },
        {
          ...workspaceProvider('gateway'),
          preset: 'openai-compatible',
          presetName: 'OpenAI-compatible endpoint',
          presetKind: 'single',
          capabilities: { chat: { registryId: 'openai', models: [{ id: 'g', name: 'G' }] } },
        },
      ],
    });
    const { apply } = recordingApply(view);
    mount(map(view, apply));
    click(document.body.querySelector<HTMLElement>('[data-slot-id="llm"]')!);
    const deepseek = byLabel('DeepSeek').querySelector('img');
    expect(deepseek?.getAttribute('src')).toContain('deepseek');
    const gateway = byLabel('gateway');
    expect(gateway.querySelector('img')).toBeNull();
    expect(gateway.querySelector('svg.lucide-box')).not.toBeNull();
  });
});
