// @vitest-environment jsdom
/**
 * The preview never confirms an outline on a timer. A `countdown` run shows
 * the outline-ready card while the run counts down to its own confirmation;
 * opening the review (mid-stream or on that card) holds the run first, and
 * the learner's edit is confirmed with `confirm-outline`. A `wait` run shows
 * the review and waits for the learner.
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

import enUS from '@/lib/i18n/locales/en-US.json';
import type { RunView } from '@/lib/generation-run-client/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let i18n: I18n;
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options ?? {}),
    locale: 'en-US',
  }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams('run=run-AAAAAAAAAAAAAAAA'),
}));
const followed = vi.hoisted(() => ({ view: null as RunView | null }));
vi.mock('@/lib/generation-run-client/use-generation-run', () => ({
  useGenerationRun: () => ({
    view: followed.view,
    status: 'live',
    caughtUp: true,
    refresh: async () => {},
  }),
}));
vi.mock('@/lib/model-settings/use-model-settings', () => ({
  useModelCapabilities: () => ({ webSearch: false }),
}));
const commands = vi.hoisted(() => ({
  confirmOutline: vi.fn(async (..._args: unknown[]) => ({
    state: 'generating',
    outlineRevision: 2,
  })),
  holdOutline: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/lib/generation-run-client/commands', () => ({
  confirmOutline: commands.confirmOutline,
  holdOutline: commands.holdOutline,
  retryPausedRun: vi.fn(),
}));

import GenerationPreviewPage from '@/app/generation-preview/page';
import { RunApiError } from '@/lib/generation-run-client/api';
import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import { event, outline, snapshot } from '../generation-run-client/fixtures';

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  commands.confirmOutline.mockClear();
  commands.holdOutline.mockClear();
  sessionStorage.clear();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function render(view: RunView) {
  followed.view = view;
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(createElement(GenerationPreviewPage)));
}

const outlines = [outline(0, 'Light'), outline(1, 'Sugar')];
const ready = { outlines, languageDirective: 'English', taskEngineMode: false };

function streaming(outlineReview: 'wait' | 'countdown'): RunView {
  const base = snapshot({ state: 'outlining', step: 'outline' });
  let view = viewFromSnapshot({
    ...base,
    input: { ...base.input, agents: { mode: 'preset', agentIds: [] }, outlineReview },
  });
  view = applyRunEvent(view, event(2, 'outline_item', { index: 0, outline: outlines[0] }));
  return view;
}

const reviewEntry = () =>
  host.querySelector(`[aria-label="${enUS.generation.outlineExpandHint}"]`) as HTMLElement | null;
const editor = () => host.textContent?.includes(enUS.generation.outlineEditorTitle) ?? false;
const confirmButton = () =>
  [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(enUS.generation.confirmAndGenerateCourse),
  ) ?? null;

/** The outline is ready; a countdown run counts down to its own confirmation. */
function outlineReady(view: RunView, countdown: boolean): RunView {
  let next = applyRunEvent(view, event(3, 'outline_ready', { revision: 1, outline: ready }));
  next = applyRunEvent(next, event(4, 'state', { state: 'awaiting_outline_confirmation' }));
  if (countdown) {
    next = applyRunEvent(
      next,
      event(5, 'outline_review', {
        outlineReview: 'countdown',
        autoConfirmAt: new Date(Date.now() + 2500).toISOString(),
      }),
    );
  }
  return next;
}

/** Type into a field the way React sees it. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = Object.getPrototypeOf(field) as object;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('the preview of a run that confirms its outline after a countdown', () => {
  it('shows the outline-ready card from the run, and never confirms on a timer', () => {
    render(outlineReady(streaming('countdown'), true));
    expect(host.textContent).toContain(enUS.generation.reviewOutlineAutoContinue);
    expect(editor()).toBe(false);
    expect(reviewEntry()).not.toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(commands.confirmOutline).not.toHaveBeenCalled();
    expect(commands.holdOutline).not.toHaveBeenCalled();
  });

  it('shows the countdown of a snapshot read while the run waits', () => {
    const base = snapshot({
      state: 'awaiting_outline_confirmation',
      outline: { ...ready, revision: 1 },
      outlineAutoConfirmAt: new Date(Date.now() + 2000).toISOString(),
    });
    const view = viewFromSnapshot({
      ...base,
      input: {
        ...base.input,
        agents: { mode: 'preset', agentIds: [] },
        outlineReview: 'countdown',
      },
    });
    expect(view.outlineAutoConfirmAt).toBe(base.outlineAutoConfirmAt);
    render(view);
    expect(host.textContent).toContain(enUS.generation.reviewOutlineAutoContinue);
  });

  it('holds the run when the review opens on the outline-ready card, and confirms the edit', async () => {
    let view = outlineReady(streaming('countdown'), true);
    render(view);
    act(() => reviewEntry()!.click());
    await settle();
    expect(commands.holdOutline).toHaveBeenCalledTimes(1);
    expect(editor()).toBe(true);
    // The hold made the run a waiting one.
    view = applyRunEvent(
      view,
      event(6, 'outline_review', { outlineReview: 'wait', autoConfirmAt: null }),
    );
    render(view);
    act(() => vi.advanceTimersByTime(10_000));
    expect(editor()).toBe(true);
    expect(commands.confirmOutline).not.toHaveBeenCalled();

    const title = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => typeInto(title, 'Edited here'));
    act(() => confirmButton()!.click());
    await settle();
    expect(commands.confirmOutline).toHaveBeenCalledTimes(1);
    const edits = commands.confirmOutline.mock.calls[0]![1] as Array<{ title: string }>;
    expect(edits[0]!.title).toBe('Edited here');
  });

  it('holds the run when the review opens while the outline streams', async () => {
    render(streaming('countdown'));
    act(() => reviewEntry()!.click());
    await settle();
    expect(commands.holdOutline).toHaveBeenCalledTimes(1);
    expect(editor()).toBe(true);
  });

  it('says so when the run already went on before the hold', async () => {
    commands.holdOutline.mockImplementationOnce(async () => {
      throw new RunApiError(409, 'RUN_STATE_CONFLICT', 'confirmed', 'x');
    });
    render(outlineReady(streaming('countdown'), true));
    act(() => reviewEntry()!.click());
    await settle();
    await settle();
    expect(host.textContent).toContain(enUS.generation.outlineAlreadyContinued);
    expect(commands.confirmOutline).not.toHaveBeenCalled();
  });
});

describe('the preview of a run that waits for its outline', () => {
  it('offers the review while the outline streams, without holding', () => {
    render(streaming('wait'));
    act(() => reviewEntry()!.click());
    expect(editor()).toBe(true);
    expect(commands.holdOutline).not.toHaveBeenCalled();
  });

  it('shows the review once the outline is ready, and waits for the learner', () => {
    render(outlineReady(streaming('wait'), false));
    expect(editor()).toBe(true);
    expect(confirmButton()).not.toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(editor()).toBe(true);
    expect(commands.confirmOutline).not.toHaveBeenCalled();
  });
});
