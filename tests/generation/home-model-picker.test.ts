// @vitest-environment jsdom

/**
 * The home toolbar's model picker sets the default model: its pill shows the
 * model alone (no prefix, no count of the stages set separately: those are
 * shown in Course Model Config), its dropdown says that picking here leaves
 * the stages set separately alone, and it stays a picker whenever the default
 * model can be changed, even when every course stage has a model of its own
 * (the classroom and the agents follow the default).
 *
 * The i18n hook returns keys (with interpolated values appended).
 */
import { act, createElement } from 'react';
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

import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import type { SettingsSection } from '@/lib/types/settings';
import {
  modelSettingsClient,
  type ModelSettingsView,
  type SlotView,
} from '@/lib/model-settings/client';

import { makeView, withLlm, withSlots, workspaceProvider } from '../model-settings/fixtures';

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
  vi.restoreAllMocks();
  modelSettingsClient.adopt(null);
});

function own(slot: string, ref: string): Partial<SlotView> {
  const [providerId, modelId] = ref.split(':');
  return {
    assignment: ref,
    effective: {
      status: 'assigned',
      resolvedAt: slot as SlotView['slot'],
      source: 'workspace',
      requirements: [],
      providerId,
      providerSource: 'workspace',
      presetId: providerId,
      registryId: 'x',
      modelId,
    },
  };
}

/** A workspace with the Acme plan and another provider, `llm` on Acme Large. */
function workspace(patch: Record<string, Partial<SlotView>> = {}): ModelSettingsView {
  const other = {
    ...workspaceProvider('other'),
    preset: 'openai-compatible',
    capabilities: { chat: { models: [{ id: 'gpt-5', name: 'GPT-5' }] } },
  };
  return withSlots(
    withLlm(makeView({ providers: [workspaceProvider('acme'), other] }), 'acme:acme-large'),
    patch,
  );
}

function mount(view: ModelSettingsView) {
  modelSettingsClient.adopt(view);
  const opened: SettingsSection[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(GenerationToolbar, {
        courseMaterials: [],
        onCourseMaterialsAdd: () => {},
        onCourseMaterialRemove: () => {},
        onPdfError: () => {},
        onSettingsOpen: (section: SettingsSection) => opened.push(section),
      }),
    ),
  );
  return { host, opened };
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

/** The stages every course is generated with. */
const COURSE_STAGES = [
  'course.outline',
  'course.content.slide',
  'course.content.quiz',
  'course.content.interactive',
  'course.content.pbl',
  'course.actions',
];

describe('the home model picker', () => {
  function allowSelection() {
    return vi.spyOn(modelSettingsClient, 'apply').mockImplementation(async (change) => {
      if (change.kind !== 'slots' || typeof change.set?.llm !== 'string') {
        throw new Error('Expected a model assignment for llm');
      }
      const view = withLlm(modelSettingsClient.getState().view!, change.set.llm);
      modelSettingsClient.adopt(view);
      return { ok: true, view };
    });
  }

  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const pill = () => document.querySelector<HTMLButtonElement>('button[aria-label*=" / "]')!;
  const openPicker = () => {
    click(pill());
    expect(dialog()).not.toBeNull();
  };
  async function key(element: HTMLElement, value: string) {
    await act(async () => {
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    });
  }

  it.each(['click', 'Enter', ' '])('selects and closes repeatedly with %s', async (method) => {
    const apply = allowSelection();
    mount(workspace());
    for (let i = 0; i < 10; i++) {
      openPicker();
      const id = i % 2 === 0 ? 'acme-small' : 'acme-large';
      const row = [...dialog()!.querySelectorAll<HTMLElement>('[role="button"]')].find((row) =>
        row.textContent?.includes(id === 'acme-small' ? 'Acme Small' : 'Acme Large'),
      )!;
      if (method === 'click') await act(async () => row.click());
      else await key(row, method);
      expect(dialog()).toBeNull();
      expect(pill().getAttribute('aria-label')).toBe(`Acme / ${id}`);
      expect(apply).toHaveBeenLastCalledWith({ kind: 'slots', set: { llm: `acme:${id}` } });
    }
    expect(apply).toHaveBeenCalledTimes(10);
  });

  it('switches provider and remains usable after repeated keyboard dismissal', async () => {
    const apply = allowSelection();
    mount(workspace());
    openPicker();
    const row = [...dialog()!.querySelectorAll<HTMLElement>('[role="button"]')].find((row) =>
      row.textContent?.includes('GPT-5'),
    )!;
    await act(async () => row.click());
    expect(dialog()).toBeNull();
    expect(pill().getAttribute('aria-label')).toBe('other / gpt-5');
    for (let i = 0; i < 10; i++) {
      openPicker();
      await key(dialog()!, 'Escape');
      expect(dialog()).toBeNull();
    }
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('dismisses on an outside pointer and restores trigger focus after Escape', async () => {
    mount(workspace());
    openPicker();
    // Radix installs its outside-pointer listener on the next task.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(dialog()).toBeNull();
    openPicker();
    await key(dialog()!, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it('shows the selected model alone, keeping its logo and accessible name', () => {
    const { host } = mount(workspace());
    const pill = host.querySelector<HTMLButtonElement>('[aria-label="acme / acme-large"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe('Acme Large');
  });

  it('shows the first-run "Pick a model" state', () => {
    modelSettingsClient.adopt(null);
    const { host } = mount(makeView({ providers: [workspaceProvider('acme')] }));
    const pill = host.querySelector('[aria-label="toolbar.pickModel"]');
    expect(pill?.textContent).toContain('toolbar.pickModel');
  });

  it('says nothing next to the picker about stages set separately', () => {
    const { host } = mount(
      workspace({
        'course.outline': own('course.outline', 'other:gpt-5'),
        classroom: own('classroom', 'acme:acme-small'),
      }),
    );
    expect(host.textContent).not.toMatch(/separately|perStage/i);
    expect(buttonWith('toolbar.stagesSetSeparately')).toBeUndefined();
  });

  it('notes in the dropdown that picking here changes the default only', () => {
    const { host } = mount(workspace());
    click(host.querySelector<HTMLButtonElement>('[aria-label="acme / acme-large"]')!);
    expect(document.body.textContent).toContain('toolbar.defaultModelNote');
  });

  it('stays a picker when every course stage has its own model', () => {
    const { host } = mount(
      workspace(
        Object.fromEntries(COURSE_STAGES.map((slot) => [slot, own(slot, 'acme:acme-small')])),
      ),
    );
    const pill = host.querySelector<HTMLButtonElement>('[aria-label="acme / acme-large"]');
    expect(pill?.textContent).toBe('Acme Large');
    expect(buttonWith('toolbar.perStageSetup')).toBeUndefined();
  });

  it('renders nothing for a locked default model', () => {
    const view = workspace({ 'course.outline': own('course.outline', 'other:gpt-5') });
    view.slots.find((slot) => slot.slot === 'llm')!.locked = true;
    const { host } = mount(view);
    expect(host.querySelector('[aria-label="acme / acme-large"]')).toBeNull();
  });
});
