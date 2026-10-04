// @vitest-environment jsdom
/**
 * The preview of a run that confirms its own outline shows the outline
 * read-only and never confirms it; the preview of a run that waits for its
 * outline shows the review and waits for the learner, with no countdown.
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
const commands = vi.hoisted(() => ({ confirmOutline: vi.fn(async () => 2) }));
vi.mock('@/lib/generation-run-client/commands', () => ({
  confirmOutline: commands.confirmOutline,
  retryPausedRun: vi.fn(),
}));

import GenerationPreviewPage from '@/app/generation-preview/page';
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

function streaming(outlineReview: 'wait' | 'auto'): RunView {
  const base = snapshot({ state: 'outlining', step: 'outline' });
  let view = viewFromSnapshot({
    ...base,
    input: { ...base.input, agents: { mode: 'preset', agentIds: [] }, outlineReview },
  });
  view = applyRunEvent(view, event(2, 'outline_item', { index: 0, outline: outlines[0] }));
  return view;
}

const reviewEntry = () => host.querySelector(`[aria-label="${enUS.generation.outlineExpandHint}"]`);
const editor = () => host.textContent?.includes(enUS.generation.outlineEditorTitle) ?? false;

describe('the preview of a run that confirms its own outline', () => {
  it('shows the outline with no review entry, and never confirms it', () => {
    let view = streaming('auto');
    render(view);
    expect(host.textContent).toContain(enUS.generation.generatingOutlines);
    expect(reviewEntry()).toBeNull();
    // The setting for the next runs is offered instead.
    expect(host.textContent).toContain(enUS.generation.alwaysReviewOutlines);

    view = applyRunEvent(view, event(3, 'outline_ready', { revision: 1, outline: ready }));
    view = applyRunEvent(view, event(4, 'outline_confirmed', { revision: 1, automatic: true }));
    view = applyRunEvent(view, event(5, 'state', { state: 'generating', step: null }));
    render(view);
    act(() => vi.advanceTimersByTime(10_000));
    expect(editor()).toBe(false);
    expect(commands.confirmOutline).not.toHaveBeenCalled();
    // A page opened on it now (the step's text animates in on a fresh mount).
    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    render(view);
    expect(host.textContent).toContain(enUS.generation.outlineReadyContinuing);
    expect(reviewEntry()).toBeNull();
    expect(editor()).toBe(false);
    expect(commands.confirmOutline).not.toHaveBeenCalled();
  });
});

describe('the preview of a run that waits for its outline', () => {
  it('offers the review while the outline streams', () => {
    render(streaming('wait'));
    expect(reviewEntry()).not.toBeNull();
  });

  it('shows the review once the outline is ready, and waits for the learner', () => {
    let view = streaming('wait');
    view = applyRunEvent(view, event(3, 'outline_ready', { revision: 1, outline: ready }));
    view = applyRunEvent(view, event(4, 'state', { state: 'awaiting_outline_confirmation' }));
    render(view);
    expect(editor()).toBe(true);
    act(() => vi.advanceTimersByTime(10_000));
    expect(editor()).toBe(true);
    expect(commands.confirmOutline).not.toHaveBeenCalled();
  });
});
