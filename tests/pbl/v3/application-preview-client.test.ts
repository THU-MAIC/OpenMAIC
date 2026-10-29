// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/components/scene-renderers/pbl/v3/request', () => ({ pblRequest: mocks.request }));
import { ApplicationPreview } from '@/components/scene-renderers/pbl/v3/application-preview';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.unstubAllGlobals();
  mocks.request.mockReset();
});

it('opens immediately inside the moving fullscreen host, and drops late results on binding changes', async () => {
  let resolve!: (value: ApplicationObservation) => void;
  let signal!: AbortSignal;
  mocks.request.mockImplementation((_url, _body, abort: AbortSignal) => {
    signal = abort;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const host = document.createElement('div');
  host.dataset.pblV3Portal = '';
  const content = document.createElement('div');
  host.append(content);
  document.body.append(host);
  const root = createRoot(content);
  const view = {
    id: 'study',
    busy: false,
    revision: 0,
    environment: { ready: true },
    application: { title: 'Preview', description: 'Try this project.' },
  } as LearningView;
  const workbench = { environmentId: 'environment', epoch: 0 } as LearningWorkbench;
  const render = (epoch: number) =>
    root.render(
      createElement(ApplicationPreview, { view, workbench: { ...workbench, epoch }, dirty: false }),
    );
  try {
    await act(async () => render(0));
    await act(async () => {
      (content.querySelector('[data-testid="pbl-application-open"]') as HTMLButtonElement).click();
    });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.className).toContain('z-[150]');
    expect(host.querySelector('[data-slot="dialog-overlay"]')?.className).toContain('z-[140]');
    expect(dialog.textContent).toContain('pblV3.application.starting');
    // Native fullscreen moves the same portal host, rather than recreating its children.
    const fullscreen = document.createElement('section');
    document.body.append(fullscreen);
    fullscreen.append(host);
    expect(fullscreen.querySelector('[role="dialog"]')).toBe(dialog);
    await act(async () => render(1));
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      resolve({
        observedAt: '',
        state: 'running',
        preview: { url: 'https://isolated.example/preview', expiresAt: Date.now() + 60_000 },
      }),
    );
    expect(host.querySelector('iframe')).toBeNull();
    fullscreen.remove();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
