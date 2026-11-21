// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchOnboarding } from '@/components/scene-renderers/pbl/v3/workbench-onboarding';
import type { LearningView } from '@/lib/pbl/v3/types';
import en from '@/lib/i18n/locales/en-US.json';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string) =>
      key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], en),
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const finish = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  finish.mockClear();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.unstubAllGlobals();
});
it.each([false, true])(
  'renders only available tour regions (application=%s)',
  async (application) => {
    const view = {
      state: { status: 'completed' },
      ...(application ? { application: { title: 'Preview', description: 'Try it' } } : {}),
    } as LearningView;
    await act(async () =>
      root.render(
        createElement(WorkbenchOnboarding, {
          view,
          root: { current: host },
          returnFocus: { current: host },
          onFinish: finish,
        }),
      ),
    );
    const steps = application
      ? ['progress', 'discussion', 'code', 'application', 'replay']
      : ['progress', 'discussion', 'code', 'replay'];
    for (const step of steps) {
      const card = host.querySelector('[data-pbl-onboarding="card"]')!;
      expect(card.getAttribute('data-step')).toBe(step);
      expect(card.textContent).not.toContain('current step');
      expect(finish).not.toHaveBeenCalled();
      const buttons = card.querySelectorAll<HTMLButtonElement>('footer button');
      await act(async () => buttons[buttons.length - 1]!.click());
    }
    expect(finish).toHaveBeenCalledOnce();
  },
);
