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

import { ModelSettingsPanel } from '@/components/settings/models';
import { ModelMap, revealBox } from '@/components/settings/models/model-map';
import { ProvidersPanel } from '@/components/settings/models/providers-panel';
import { SetupNotice } from '@/components/settings/models/setup-notice';
import { SlotPicker } from '@/components/settings/models/slot-picker';
import {
  createModelSettingsClient,
  type ApplyResult,
  type ModelSettingsChange,
  type ModelSettingsView,
  type SlotView,
} from '@/lib/model-settings/client';

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

/** Type into a React-controlled field. */
function type(element: HTMLElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
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

/** The same keys-with-values the mocked i18n hook returns. */
const T = (key: string, options?: Record<string, unknown>) =>
  options ? [key, ...Object.values(options)].join('|') : key;

describe('provider form → change', () => {
  it('retries an add it could not confirm under the same id', async () => {
    const view = makeView();
    const changes: ModelSettingsChange[] = [];
    const answers: ApplyResult[] = [
      { ok: false, reason: 'unconfirmed', message: 'lost' },
      { ok: true, view },
    ];
    const apply = vi.fn(async (change: ModelSettingsChange) => {
      changes.push(change);
      return answers.shift()!;
    });
    const { render } = mount(createElement(ProvidersPanel, { view, apply, t: T }));

    click(byText('settings.modelSettings.providers.add'));
    type(document.body.querySelector('select')!, chatPreset.id);
    type(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-1');
    click(byText('settings.modelSettings.providers.add'));
    await flush();
    expect(document.body.textContent).toContain('settings.modelSettings.picker.unconfirmed');

    // Later the settings read again and show the provider: the retry updates it.
    render(
      createElement(ProvidersPanel, {
        view: makeView({ providers: [workspaceProvider('acme')] }),
        apply,
        t: T,
      }),
    );
    click(byText('settings.modelSettings.providers.add'));
    await flush();

    expect(changes.map((change) => change.kind === 'provider' && change.id)).toEqual([
      'acme',
      'acme',
    ]);
  });

  it('closes the form when the reload after a lost answer shows the provider', async () => {
    const view = makeView();
    const saved = makeView({ providers: [workspaceProvider('acme')] });
    const apply = vi.fn(
      async (): Promise<ApplyResult> => ({
        ok: false,
        reason: 'unconfirmed',
        message: 'lost',
        view: saved,
      }),
    );
    mount(createElement(ProvidersPanel, { view, apply, t: T }));

    click(byText('settings.modelSettings.providers.add'));
    type(document.body.querySelector('select')!, chatPreset.id);
    click(byText('settings.modelSettings.providers.add'));
    await flush();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('settings.modelSettings.picker.unconfirmed');
  });

  it('asks for a new key when the stored one is unreadable, and sends the one typed', async () => {
    const broken = { ...workspaceProvider('acme'), key: { set: true, unreadable: true } };
    const view = makeView({ providers: [broken] });
    const { apply, changes } = recordingApply(view);
    mount(createElement(ProvidersPanel, { view, apply, t: T }));

    click(byLabel('settings.modelSettings.providers.edit|Acme'));
    // No "keep" for a key the server cannot read.
    expect(document.body.textContent).not.toContain('settings.modelSettings.providers.keepKey');
    type(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-new');
    click(byText('settings.modelSettings.actions.save'));
    await flush();

    expect(changes).toEqual([
      { kind: 'provider', id: 'acme', preset: 'acme', apiKey: 'sk-new', baseUrl: null },
    ]);
  });

  it('removes an unreadable key only when asked to', async () => {
    const broken = { ...workspaceProvider('acme'), key: { set: true, unreadable: true } };
    const view = makeView({ providers: [broken] });
    const { apply, changes } = recordingApply(view);
    mount(createElement(ProvidersPanel, { view, apply, t: T }));

    click(byLabel('settings.modelSettings.providers.edit|Acme'));
    click(byText('settings.modelSettings.providers.removeKey'));
    click(byText('settings.modelSettings.actions.save'));
    await flush();

    expect(changes[0]).toMatchObject({ apiKey: '' });
  });

  it('keeps a pinned model list on a key-only edit', async () => {
    const pinned = { ...workspaceProvider('acme'), models: ['acme-large'] };
    const view = makeView({ providers: [pinned] });
    const { apply, changes } = recordingApply(view);
    mount(createElement(ProvidersPanel, { view, apply, t: T }));

    click(byLabel('settings.modelSettings.providers.edit|Acme'));
    click(byText('settings.modelSettings.providers.replaceKey'));
    type(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-2');
    click(byText('settings.modelSettings.actions.save'));
    await flush();

    expect(changes).toEqual([
      {
        kind: 'provider',
        id: 'acme',
        preset: 'acme',
        apiKey: 'sk-2',
        baseUrl: null,
        models: ['acme-large'],
      },
    ]);
  });
});

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
    onSetupOutcome: () => {},
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

  it('opens the picker instead of guessing for a slot switched off elsewhere', async () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: null, effective: offEffective('tts') },
    });
    const { apply } = recordingApply(view);
    mount(map(view, apply));

    click(byLabel('settings.modelSettings.card.toggle|tts'));
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-slot-picker="tts"]')).not.toBeNull();
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

describe('first-run setup', () => {
  it('says the default model is still missing, with nothing to retry, when only media got filled', () => {
    mount(
      createElement(SetupNotice, {
        outcome: {
          preset: chatPreset,
          result: { status: 'partial', providerId: 'acme', reason: 'llm-missing' },
        },
        onRetry: async () => {},
        onProviders: () => {},
        onDismiss: () => {},
        t: T,
      }),
    );
    expect(document.body.textContent).toContain('settings.modelSettings.setup.llmMissing|Acme');
    expect(document.body.textContent).not.toContain('settings.modelSettings.setup.retry');
  });

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function connect() {
    click(byText('settings.modelSettings.setup.open'));
    await flush();
    type(document.body.querySelector('select')!, chatPreset.id);
    type(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-test');
    click(byText('settings.modelSettings.setup.connect'));
    await flush();
  }

  it('goes on when the answer to adding the provider is lost but the provider was saved', async () => {
    const withProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const methods: string[] = [];
    const answers = [
      json(makeView({ revision: null })),
      new Response('{"revision":1,"prov', { status: 200 }),
      json(withProvider),
      json(withLlm(withProvider)),
    ];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return answers.shift()!;
    });
    mount(createElement(ModelSettingsPanel, { client: createModelSettingsClient(fetchImpl) }));
    await flush();

    await connect();

    // Added (answer lost), reloaded, then the slots filled against the reloaded view.
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(document.body.textContent).not.toContain('settings.modelSettings.setup.connecting');
    expect(document.body.textContent).not.toContain('settings.modelSettings.setup.partial');
  });

  it('reconciles a provider add whose request failed after the server saved it', async () => {
    const withProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const methods: string[] = [];
    const answers: (() => Response)[] = [
      () => json(makeView({ revision: null })),
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(withProvider),
      () => json(withLlm(withProvider)),
    ];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return answers.shift()!();
    });
    mount(createElement(ModelSettingsPanel, { client: createModelSettingsClient(fetchImpl) }));
    await flush();

    await connect();

    expect(methods).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps an add it cannot confirm as a notice, and checks again', async () => {
    const withProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const methods: string[] = [];
    const answers: (() => Response)[] = [
      () => json(makeView({ revision: null })),
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(withProvider),
      () => json(withLlm(withProvider)),
    ];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return answers.shift()!();
    });
    mount(createElement(ModelSettingsPanel, { client: createModelSettingsClient(fetchImpl) }));
    await flush();

    await connect();
    const notice = byText('settings.modelSettings.setup.unconfirmedAdd', '[role="alert"]');
    expect(notice.textContent).toContain('Acme');

    click(byText('settings.modelSettings.setup.checkAgain'));
    await flush();

    expect(methods).toEqual(['GET', 'PUT', 'GET', 'GET', 'PUT']);
    expect(document.body.textContent).not.toContain('settings.modelSettings.setup.unconfirmedAdd');
  });

  it('says so, and frees the form, when the answer is lost and nothing was saved', async () => {
    const answers = [
      json(makeView({ revision: null })),
      new Response('', { status: 200 }),
      json(makeView({ revision: null })),
    ];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    mount(createElement(ModelSettingsPanel, { client: createModelSettingsClient(fetchImpl) }));
    await flush();

    await connect();

    const connectButton = byText('settings.modelSettings.setup.connect');
    expect(connectButton.hasAttribute('disabled')).toBe(false);
    expect(document.body.textContent).toContain('settings.modelSettings.picker.unconfirmed');
  });

  it('keeps a partial setup on screen through the reload a conflict causes, and recovers', async () => {
    const empty = makeView({ revision: null });
    const withProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const reloaded = makeView({ revision: 2, providers: [workspaceProvider('acme')] });
    const done = withLlm(reloaded);
    const requests: { method: string; body?: unknown }[] = [];
    const answers = [
      json(empty),
      json(withProvider),
      json({ error: { code: 'CONFLICT', message: 'The settings changed; reload them' } }, 409),
      json(reloaded),
      json({ ...done, revision: 3 }),
    ];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return answers.shift()!;
    });
    const client = createModelSettingsClient(fetchImpl);
    mount(createElement(ModelSettingsPanel, { client }));
    await flush();

    click(byText('settings.modelSettings.setup.open'));
    await flush();
    type(document.body.querySelector('select')!, chatPreset.id);
    type(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-test');
    click(byText('settings.modelSettings.setup.connect'));
    await flush();

    // The provider exists; the slots met a stale revision and the view reloaded.
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'PUT', 'GET']);
    const notice = byText('settings.modelSettings.setup.partial', '[role="alert"]');
    expect(notice.textContent).toContain('Acme');
    expect(notice.textContent).toContain('settings.modelSettings.setup.changedMeanwhile');

    click(byText('settings.modelSettings.setup.retry'));
    await flush();

    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      body: {
        revision: 2,
        change: {
          kind: 'slots',
          set: {
            llm: 'acme:acme-large',
            'course.content.slide': 'acme:acme-small',
            tts: 'acme:acme-voice',
          },
        },
      },
    });
    expect(document.body.textContent).not.toContain('settings.modelSettings.setup.partial');
  });
});
