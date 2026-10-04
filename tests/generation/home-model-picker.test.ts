// @vitest-environment jsdom

/**
 * The home toolbar's model picker sets the default model: its pill says so,
 * it says how many stages have a model of their own (opening Course Model
 * Config on a click), its dropdown says that picking here leaves those stages
 * alone, and when every course stage has its own model the pill summarises
 * the per-stage setup instead of offering to switch.
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
import { overrideLines } from '@/components/settings/home-model-picker';
import type { SettingsSection } from '@/lib/types/settings';
import {
  modelSettingsClient,
  type ModelSettingsView,
  type SlotView,
} from '@/lib/model-settings/client';
import { COURSE_GENERATION_STAGES, defaultModelOverrides } from '@/lib/model-settings/overrides';

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

describe('the home model picker', () => {
  it('labels the selected model as the default, keeping its logo and accessible name', () => {
    const { host } = mount(workspace());
    const pill = host.querySelector<HTMLButtonElement>('[aria-label="acme / acme-large"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain('toolbar.defaultModel');
    expect(pill!.textContent).toContain('Acme Large');
  });

  it('does not label the first-run "Pick a model" state as a default', () => {
    modelSettingsClient.adopt(null);
    const { host } = mount(makeView({ providers: [workspaceProvider('acme')] }));
    const pill = host.querySelector('[aria-label="toolbar.pickModel"]');
    expect(pill?.textContent).toContain('toolbar.pickModel');
    expect(pill?.textContent).not.toContain('toolbar.defaultModel');
  });

  it('shows no hint while every stage uses the default', () => {
    mount(workspace({ 'course.outline': own('course.outline', 'acme:acme-large') }));
    expect(buttonWith('toolbar.stagesSetSeparately')).toBeUndefined();
  });

  it('counts the stages set separately and opens Course Model Config on a click', () => {
    const { opened } = mount(
      workspace({
        'course.outline': own('course.outline', 'other:gpt-5'),
        classroom: own('classroom', 'acme:acme-small'),
      }),
    );
    const hint = buttonWith('toolbar.stagesSetSeparately');
    expect(hint?.textContent).toBe('toolbar.stagesSetSeparately|2');
    click(hint!);
    expect(opened).toEqual(['course-models']);
  });

  it('notes in the dropdown that picking here changes the default only', () => {
    const { host } = mount(workspace());
    click(host.querySelector<HTMLButtonElement>('[aria-label="acme / acme-large"]')!);
    expect(document.body.textContent).toContain('toolbar.defaultModelNote');
  });

  it('summarises a per-stage setup when every course stage has its own model', () => {
    const { host, opened } = mount(
      workspace(
        Object.fromEntries(
          COURSE_GENERATION_STAGES.map((slot) => [slot, own(slot, 'acme:acme-small')]),
        ),
      ),
    );
    expect(host.querySelector('[aria-label="acme / acme-large"]')).toBeNull();
    const pill = host.querySelector<HTMLButtonElement>('[aria-label="toolbar.perStageSetup"]');
    expect(pill).not.toBeNull();
    // Every course stage is on the Acme plan: the pill names it.
    expect(pill!.textContent).toContain(chatPreset.name);
    expect(buttonWith('toolbar.stagesSetSeparately')).toBeUndefined();
    click(pill!);
    expect(opened).toEqual(['course-models']);
  });

  it('leaves the read-only pill of a locked default alone', () => {
    const view = workspace({ 'course.outline': own('course.outline', 'other:gpt-5') });
    view.slots.find((slot) => slot.slot === 'llm')!.locked = true;
    const { host } = mount(view);
    expect(host.querySelector('[title="toolbar.modelLockedHint"]')).not.toBeNull();
    expect(host.textContent).not.toContain('toolbar.defaultModel');
  });
});

describe('the list of stages set separately', () => {
  it('names each stage as the map does, page types with their station, and its model', () => {
    const view = workspace({
      'course.outline': own('course.outline', 'other:gpt-5'),
      'course.content.quiz': own('course.content.quiz', 'acme:acme-small'),
      'course.research': {
        assignment: null,
        effective: { status: 'disabled', resolvedAt: 'course.research', source: 'workspace' },
      },
    });
    // A translator that knows the stage names.
    const t = (key: string) => key.replace('settings.modelSettings.slots.', 'name:');
    expect(overrideLines(view, defaultModelOverrides(view), t)).toEqual([
      {
        slot: 'course.research',
        stage: 'name:courseResearch.name',
        model: 'toolbar.off',
      },
      {
        slot: 'course.outline',
        stage: 'name:courseOutline.name',
        model: 'GPT-5',
      },
      {
        slot: 'course.content.quiz',
        stage: 'name:courseContent.name · name:courseContentQuiz.name',
        model: 'Acme Small',
      },
    ]);
  });
});
