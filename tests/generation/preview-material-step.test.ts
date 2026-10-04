// @vitest-environment jsdom
/**
 * The generation preview lists no material-analysis step: materials are
 * extracted since their upload, so the run's material step (reusing or
 * waiting for that extraction) shows as the step after it. A failure of the
 * material step still pauses the run, and the preview shows it with Retry.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

import enUS from '@/lib/i18n/locales/en-US.json';
import type { RunView } from '@/lib/generation-run-client/types';

let i18n: I18n;
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options ?? {}),
    locale: 'en-US',
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams('run=run-1'),
}));

const followed = vi.hoisted(() => ({ view: null as RunView | null, webSearch: false }));
vi.mock('@/lib/generation-run-client/use-generation-run', () => ({
  useGenerationRun: () => ({
    view: followed.view,
    status: 'live',
    caughtUp: true,
    refresh: async () => {},
  }),
}));
vi.mock('@/lib/model-settings/use-model-settings', () => ({
  useModelCapabilities: () => ({ webSearch: followed.webSearch }),
}));

import GenerationPreviewPage from '@/app/generation-preview/page';
import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import type { RunSnapshot } from '@/lib/generation-run-client/types';

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  });
});

const snapshot = {
  id: 'run-1',
  state: 'preparing',
  step: 'material-analysis',
  seq: 1,
  input: { materialIds: ['mat_1'], agents: { mode: 'preset', agentIds: [] } },
  outline: null,
  agents: null,
  stageId: null,
  progress: { scenesTotal: 0, scenesCompleted: 0 },
  error: null,
  createdAt: '',
  updatedAt: '',
  materialKinds: ['document'],
} as unknown as RunSnapshot;

function render(view: RunView, webSearch = false): string {
  followed.view = view;
  followed.webSearch = webSearch;
  return renderToStaticMarkup(createElement(GenerationPreviewPage));
}

/** The progress dots: one per step the preview lists. */
function stepDots(markup: string): number {
  return (markup.match(/h-1\.5 rounded-full transition-all/g) ?? []).length;
}

describe('the generation preview of a run with materials', () => {
  it('shows the step after the material analysis while the run waits for an extraction', () => {
    let view = viewFromSnapshot(snapshot);
    view = applyRunEvent(view, {
      seq: 2,
      type: 'material_kinds',
      data: { kinds: ['document'] },
    } as never);
    const markup = render(view);
    expect(markup).toContain(enUS.generation.generatingOutlines);
    // Outline, page content, teaching actions.
    expect(stepDots(markup)).toBe(3);
    expect(markup).not.toMatch(/Analyzing|document structure/i);

    const searching = render(view, true);
    expect(searching).toContain(enUS.generation.webSearching);
    expect(stepDots(searching)).toBe(4);
  });

  it('lists no material step for audio or video either', () => {
    const view = viewFromSnapshot({ ...snapshot, materialKinds: ['media'] } as RunSnapshot);
    const markup = render(view);
    expect(markup).toContain(enUS.generation.generatingOutlines);
    expect(markup).not.toMatch(/Analyzing|audio\/video/i);
  });

  it('shows a failed material step as a paused run with Retry', () => {
    let view = viewFromSnapshot(snapshot);
    view = applyRunEvent(view, {
      seq: 2,
      type: 'step_failed',
      data: { step: 'material-analysis', message: 'extraction failed' },
    } as never);
    view = applyRunEvent(view, {
      seq: 3,
      type: 'state',
      data: { state: 'paused', step: 'material-analysis' },
    } as never);
    expect(view.error?.step).toBe('material-analysis');
    const markup = render(view);
    expect(markup).toContain(enUS.generation.generationFailed);
    expect(markup).toContain(enUS.generation.courseMaterialParseFailed);
    expect(markup).toContain('data-testid="generation-retry"');
    expect(stepDots(markup)).toBe(3);
  });
});
