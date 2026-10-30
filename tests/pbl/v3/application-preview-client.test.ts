// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/components/scene-renderers/pbl/v3/request', () => ({ pblRequest: mocks.request }));
import {
  ApplicationPreview,
  ApplicationPreviewToggle,
} from '@/components/scene-renderers/pbl/v3/application-preview';
import { useApplicationPreview } from '@/components/scene-renderers/pbl/v3/use-application-preview';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.request.mockReset();
});
const view = {
  id: 'study',
  environmentId: 'environment',
  busy: false,
  revision: 0,
  environment: { ready: true },
  application: { title: 'Preview', description: 'Course-specific help.' },
} as LearningView;
const workbench = { environmentId: 'environment', epoch: 0 } as LearningWorkbench;
const running = {
  observedAt: '',
  state: 'running',
  preview: { url: 'https://isolated.example/preview', expiresAt: Date.now() + 60_000 },
} satisfies ApplicationObservation;
function Harness({
  current = view,
  epoch = 0,
  dirty = false,
}: {
  current?: LearningView;
  epoch?: number;
  dirty?: boolean;
}) {
  const preview = useApplicationPreview(current, { ...workbench, epoch }, dirty);
  return createElement(
    Fragment,
    null,
    createElement(ApplicationPreviewToggle, { preview }),
    createElement(ApplicationPreview, { application: current.application!, preview }),
  );
}
async function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  return {
    host,
    root,
    click: async () =>
      act(async () =>
        (host.querySelector('[data-testid="pbl-application-open"]') as HTMLButtonElement).click(),
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
it('opens a dock immediately and rejects stale results after environment rotation', async () => {
  let resolve!: (value: ApplicationObservation) => void, signal!: AbortSignal;
  mocks.request.mockImplementation((_url, _body, abort: AbortSignal) => {
    signal = abort;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const f = await fixture();
  try {
    await f.click();
    expect(
      f.host.querySelector('[data-testid="pbl-application-panel"]')?.getAttribute('aria-hidden'),
    ).toBe('false');
    expect(f.host.textContent).toContain('pblV3.application.starting');
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => f.root.render(createElement(Harness, { epoch: 1 })));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(running));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(f.host.querySelector('[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
  } finally {
    await f.cleanup();
  }
});
it('collapse preserves the iframe without stopping, relaunching or exposing it to keyboard navigation', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe');
    expect(frame).not.toBeNull();
    await f.click();
    const panel = f.host.querySelector('[data-testid="pbl-application-panel"]')!;
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    await f.click();
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('details')?.open).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it('invalidates interactive preview during writes or agent work and requires an explicit reopen', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
    );
    expect(f.host.querySelector('iframe')).toBeNull();
    await act(async () => f.root.render(createElement(Harness)));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () =>
      Array.from(f.host.querySelectorAll('button'))
        .find((b) => b.textContent === 'pblV3.application.reopen')!
        .click(),
    );
    expect(f.host.querySelector('iframe')).not.toBeNull();
    await act(async () => f.root.render(createElement(Harness, { dirty: true })));
    expect(f.host.querySelector('iframe')).toBeNull();
  } finally {
    await f.cleanup();
  }
});
it('expires access even while collapsed and renews only through an explicit open', async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue({
    ...running,
    preview: { ...running.preview, expiresAt: Date.now() + 1000 },
  });
  const f = await fixture();
  try {
    await f.click();
    await f.click();
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(f.host.querySelector('iframe')).toBeNull();
    mocks.request.mockResolvedValue(running);
    await f.click();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('iframe')).not.toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('hides the old application as soon as the study changes environment, before workbench refresh arrives', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    expect(f.host.querySelector('iframe')).not.toBeNull();
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, environmentId: 'replacement' } })),
    );
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(
      (f.host.querySelector('[data-testid="pbl-application-open"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

it('keeps the same iframe through a verified activity renewal and expires after subsequent idle', async () => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 60_000;
  mocks.request.mockResolvedValue({ ...running, preview: { ...running.preview, expiresAt } });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    const message = { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300_000 };
    // Neither another window nor an unrelated origin may alter the local timer.
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', { origin: 'https://isolated.example', data: message }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://foreign.example',
          data: message,
        }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://isolated.example',
          data: message,
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_001));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(240_000));
    expect(f.host.querySelector('iframe')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('obtains a fresh new-tab ticket without replacing the live iframe or its input', async () => {
  const replace = vi.fn(),
    close = vi.fn();
  const open = vi
    .spyOn(window, 'open')
    .mockReturnValue({ location: { replace }, close, opener: window } as unknown as Window);
  mocks.request.mockResolvedValueOnce(running).mockResolvedValueOnce({
    ...running,
    preview: { ...running.preview, url: 'https://isolated.example/preview#fresh-ticket' },
  });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe');
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.newTab"]') as HTMLButtonElement
      ).click(),
    );
    expect(replace).toHaveBeenCalledWith('https://isolated.example/preview#fresh-ticket');
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(close).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls[1][1].action).toBe('open');
  } finally {
    await f.cleanup();
    open.mockRestore();
  }
});

it.each(['foreign-origin', 'other-window'])(
  'does not renew the display deadline from %s',
  async (kind) => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValue({
      ...running,
      preview: { ...running.preview, expiresAt: Date.now() + 60_000 },
    });
    const f = await fixture();
    try {
      await f.click();
      const frame = f.host.querySelector('iframe')!;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: kind === 'other-window' ? null : frame.contentWindow,
            origin:
              kind === 'foreign-origin' ? 'https://foreign.example' : 'https://isolated.example',
            data: { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300_000 },
          }),
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(30_001));
      expect(f.host.querySelector('iframe')).toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
