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
  vi.restoreAllMocks();
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
it('shows only submitted choice labels as read-only context, without claiming implementation success', async () => {
  const f = await fixture();
  try {
    expect(f.host.querySelector('[data-testid="pbl-application-choices"]')).toBeNull();
    await act(async () =>
      f.root.render(
        createElement(Harness, {
          current: {
            ...view,
            application: {
              ...view.application!,
              choices: [{ id: 'position', label: 'New item position', choice: 'New items first' }],
            },
          },
        }),
      ),
    );
    const badge = f.host.querySelector('[data-testid="pbl-application-choices"]')!;
    expect(badge.textContent).toContain('New items first');
    expect(badge.textContent).toContain('pblV3.application.yourChoice');
    expect(badge.querySelector('button, input, select')).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
const running = {
  observedAt: '',
  state: 'running',
  preview: { url: 'https://isolated.example/preview', expiresAt: Date.now() + 60_000 },
} satisfies ApplicationObservation;
function Harness({
  current = view,
  epoch = 0,
  dirty = false,
  workbenchEnvironmentId = workbench.environmentId,
}: {
  current?: LearningView;
  epoch?: number;
  dirty?: boolean;
  workbenchEnvironmentId?: string;
}) {
  const preview = useApplicationPreview(
    current,
    { ...workbench, environmentId: workbenchEnvironmentId, epoch },
    dirty,
  );
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
it.each(['agent', 'dirty', 'assessment'])(
  'keeps the document visible during %s work and automatically resumes an unchanged app',
  async (kind) => {
    mocks.request.mockResolvedValue(running);
    const f = await fixture();
    try {
      await f.click();
      const frame = f.host.querySelector('iframe')!;
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            dirty: kind === 'dirty',
            current: {
              ...view,
              busy: kind === 'agent',
              evaluation: kind === 'assessment' ? ({} as LearningView['evaluation']) : null,
            },
          }),
        ),
      );
      expect(f.host.querySelector('iframe')).toBe(frame);
      expect(frame.hidden).toBe(false);
      expect(frame.hasAttribute('inert')).toBe(true);
      expect(mocks.request).toHaveBeenCalledTimes(1);
      await act(async () => f.root.render(createElement(Harness)));
      expect(f.host.querySelector('iframe')).toBe(frame);
      expect(frame.hasAttribute('inert')).toBe(false);
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request.mock.calls[1][1].action).toBe('status');
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['stopped', 'source-changed'])(
  'refreshes a %s backend automatically, keeping the old document until the new one loads',
  async (kind) => {
    mocks.request
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({
        ...running,
        preview: undefined,
        state: kind === 'stopped' ? 'stopped' : 'running',
        sourceChanged: kind === 'source-changed',
      })
      .mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, url: 'https://isolated.example/preview#new' },
      });
    const f = await fixture();
    try {
      await f.click();
      const oldFrame = f.host.querySelector('iframe')!;
      await act(async () => oldFrame.dispatchEvent(new Event('load')));
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
      );
      expect(f.host.querySelector('iframe')).toBe(oldFrame);
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
        'open',
        'status',
        kind === 'stopped' ? 'open' : 'restart',
      ]);
      expect(mocks.request.mock.calls[2][1].revision).toBe(1);
      const frames = f.host.querySelectorAll('iframe');
      expect(frames).toHaveLength(2);
      expect(frames[0]).toBe(oldFrame);
      expect(oldFrame.hasAttribute('inert')).toBe(true);
      const next = frames[1]!;
      expect(next.getAttribute('aria-hidden')).toBe('true');
      await act(async () => next.dispatchEvent(new Event('load')));
      expect(f.host.querySelectorAll('iframe')).toHaveLength(1);
      expect(f.host.querySelector('iframe')).toBe(next);
      expect(next.hasAttribute('inert')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

it.each([
  ['restart', 'collapse', 'running'],
  ['source-change', 'collapse', 'running'],
  ['stopped', 'collapse', 'running'],
  ['restart', 'collapse', 'stopped'],
  ['restart', 'collapse', 'failed'],
  ['restart', 'expiry', 'running'],
  ['restart', 'dirty', 'running'],
  ['restart', 'revision', 'running'],
  ['restart', 'error-toggle', 'running'],
  ['restart', 'error-reopen', 'running'],
  ['restart', 'failed-result', 'running'],
])(
  'replaces the retained document after %s dispatch interrupted by %s, with backend %s',
  async (launch, interruption, backend) => {
    if (interruption === 'expiry') vi.useFakeTimers();
    let finish!: (value: ApplicationObservation) => void;
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    mocks.request.mockResolvedValueOnce(running);
    if (launch !== 'restart')
      mocks.request.mockResolvedValueOnce({
        state: launch === 'stopped' ? 'stopped' : 'running',
        observedAt: '',
        sourceChanged: launch === 'source-change',
      });
    mocks.request.mockImplementationOnce((_url, _body, abort) => {
      signal = abort;
      return new Promise((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
    });
    if (!interruption.startsWith('error') && interruption !== 'failed-result')
      mocks.request.mockResolvedValueOnce({ state: backend, observedAt: '', sourceChanged: false });
    const replacement = {
      ...running,
      preview: { ...running.preview, url: 'https://isolated.example/replacement' },
    };
    mocks.request.mockImplementationOnce(async () => ({
      ...replacement,
      preview: { ...replacement.preview, expiresAt: Date.now() + 60_000 },
    }));
    const f = await fixture();
    try {
      await f.click();
      const old = f.host.querySelector('iframe')!;
      await act(async () => old.dispatchEvent(new Event('load')));
      const current = launch === 'restart' ? view : { ...view, revision: 1 };
      if (launch === 'restart')
        await act(async () =>
          (
            f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
          ).click(),
        );
      else await act(async () => f.root.render(createElement(Harness, { current })));
      if (interruption === 'collapse' || interruption === 'expiry') {
        await f.click();
        expect(signal.aborted).toBe(true);
        if (interruption === 'expiry') {
          const calls = mocks.request.mock.calls.length;
          await act(async () => vi.advanceTimersByTimeAsync(60_001));
          expect(mocks.request).toHaveBeenCalledTimes(calls);
          expect(old.hidden).toBe(true);
        }
        await f.click();
      } else if (interruption === 'dirty') {
        await act(async () => f.root.render(createElement(Harness, { current, dirty: true })));
        expect(signal.aborted).toBe(true);
        await act(async () => f.root.render(createElement(Harness, { current })));
      } else if (interruption === 'revision') {
        await act(async () =>
          f.root.render(createElement(Harness, { current: { ...current, revision: 2 } })),
        );
        expect(signal.aborted).toBe(true);
      } else {
        if (interruption === 'failed-result')
          await act(async () => finish({ state: 'failed', observedAt: '' }));
        else await act(async () => reject(new Error('Response lost after server dispatch')));
        expect(f.host.querySelector('iframe')).toBe(old);
        expect(old.hasAttribute('inert')).toBe(true);
        if (interruption === 'error-toggle') {
          await f.click();
          await f.click();
        } else
          await act(async () =>
            [...f.host.querySelectorAll('button')]
              .find((button) => button.textContent === 'pblV3.application.reopen')!
              .click(),
          );
      }
      const actions = mocks.request.mock.calls.map((call) => call[1].action);
      expect(actions).toEqual([
        'open',
        ...(launch === 'restart' ? [] : ['status']),
        launch === 'stopped' ? 'open' : 'restart',
        ...(!interruption.startsWith('error') && interruption !== 'failed-result'
          ? ['status']
          : []),
        'open',
      ]);
      const frames = f.host.querySelectorAll('iframe');
      expect(frames).toHaveLength(2);
      expect(frames[0]).toBe(old);
      expect(old.hasAttribute('inert')).toBe(true);
      // The backend can complete the cancelled request; its late result must not
      // consume the pending replacement or install a second document.
      await act(async () =>
        finish({
          ...running,
          preview: { ...running.preview, url: 'https://isolated.example/cancelled' },
        }),
      );
      expect(f.host.querySelectorAll('iframe')).toHaveLength(2);
      await act(async () => frames[1].dispatchEvent(new Event('load')));
      expect(f.host.querySelectorAll('iframe')).toHaveLength(1);
      expect(f.host.querySelector('iframe')).toBe(frames[1]);
      expect(frames[1].hasAttribute('inert')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

it('does not launch an unopened or collapsed application when background work finishes', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(mocks.request).not.toHaveBeenCalled();
    await f.click();
    await f.click();
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await f.click();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1][1].action).toBe('status');
  } finally {
    await f.cleanup();
  }
});

it('aborts an automatic status check on collapse and never dispatches its late restart', async () => {
  let resolve!: (value: ApplicationObservation) => void;
  mocks.request.mockResolvedValueOnce(running).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = await fixture();
  try {
    await f.click();
    const old = f.host.querySelector('iframe');
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    await f.click();
    await act(async () => resolve({ observedAt: '', state: 'stopped' }));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('iframe')).toBe(old);
    expect(
      f.host.querySelector('[data-testid="pbl-application-panel"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
  } finally {
    await f.cleanup();
  }
});

it('keeps the previous page after failed recovery and retries only on explicit input', async () => {
  mocks.request.mockResolvedValueOnce(running).mockRejectedValueOnce(new Error('Offline'));
  const f = await fixture();
  try {
    await f.click();
    const old = f.host.querySelector('iframe')!;
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(f.host.querySelector('iframe')).toBe(old);
    expect(old.hidden).toBe(false);
    expect(old.hasAttribute('inert')).toBe(true);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('Offline');
    await act(async () => f.root.render(createElement(Harness)));
    expect(mocks.request).toHaveBeenCalledTimes(2);
  } finally {
    await f.cleanup();
  }
});

it.each(['epoch', 'environment', 'unavailable'])(
  'discards retained documents and ignores in-flight refreshes when %s changes',
  async (kind) => {
    let resolve!: (value: ApplicationObservation) => void;
    mocks.request.mockResolvedValueOnce(running).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const f = await fixture();
    try {
      await f.click();
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
      );
      await act(async () => f.root.render(createElement(Harness)));
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            epoch: kind === 'epoch' ? 1 : 0,
            current: {
              ...view,
              environmentId: kind === 'environment' ? 'new' : view.environmentId,
              environment:
                kind === 'unavailable' ? { state: 'destroyed', ready: false } : view.environment,
            },
          }),
        ),
      );
      await act(async () => resolve(running));
      expect(f.host.querySelector('iframe')).toBeNull();
      expect(mocks.request).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['study', 'environment', 'epoch'])(
  'does not transfer queued recovery to a replacement %s that is already ready',
  async (kind) => {
    mocks.request.mockResolvedValue(running);
    const f = await fixture();
    try {
      await f.click();
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
      );
      const replacement = {
        ...view,
        id: kind === 'study' ? 'replacement-study' : view.id,
        environmentId: kind === 'environment' ? 'replacement-environment' : view.environmentId,
        revision: 1,
      };
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: replacement,
            epoch: kind === 'epoch' ? 1 : 0,
            workbenchEnvironmentId: replacement.environmentId!,
          }),
        ),
      );
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(f.host.querySelector('iframe')).toBeNull();
      expect(f.host.querySelector('[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
      await f.click();
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request.mock.calls[1][1]).toMatchObject({
        action: 'open',
        studyId: replacement.id,
        environmentId: replacement.environmentId,
        epoch: kind === 'epoch' ? 1 : 0,
      });
      expect(f.host.querySelector('iframe')).not.toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['running', 'stopped', 'source-changed'])(
  'ignores a pending %s status response after moving to a ready replacement epoch',
  async (state) => {
    let finish!: (observation: ApplicationObservation) => void;
    let signal!: AbortSignal;
    mocks.request.mockResolvedValueOnce(running).mockImplementationOnce((_url, _body, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const f = await fixture();
    try {
      await f.click();
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 2 }, epoch: 1 })),
      );
      expect(signal.aborted).toBe(true);
      await act(async () =>
        finish({
          state: state === 'stopped' ? 'stopped' : 'running',
          observedAt: '',
          sourceChanged: state === 'source-changed',
        }),
      );
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(f.host.querySelector('iframe')).toBeNull();
      expect(f.host.querySelector('[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await f.cleanup();
    }
  },
);

it('closes an old pending new-tab ticket after the epoch changes without navigating it', async () => {
  const replace = vi.fn(),
    close = vi.fn();
  const popup = {
    location: { replace },
    close,
    opener: window,
    document: document.implementation.createHTMLDocument(),
  };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  let finish!: (observation: ApplicationObservation) => void;
  mocks.request.mockResolvedValueOnce(running).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.newTab"]') as HTMLButtonElement
      ).click(),
    );
    await act(async () => f.root.render(createElement(Harness, { epoch: 1 })));
    await act(async () => finish(running));
    expect(close).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('iframe')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('checks the latest saved revision even when a short write finishes between busy snapshots', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    const old = f.host.querySelector('iframe');
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    expect(f.host.querySelector('iframe')).toBe(old);
    expect(mocks.request.mock.calls[1][1]).toMatchObject({ action: 'status', revision: 1 });
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    expect(mocks.request).toHaveBeenCalledTimes(2);
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
    expect(f.host.querySelector('iframe')?.hidden).toBe(true);
    mocks.request.mockResolvedValue(running);
    await f.click();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('iframe')).not.toBeNull();
  } finally {
    await f.cleanup();
  }
});

it.each(['before-work', 'during-work'])(
  'requires explicit reopen when an open preview expires %s',
  async (timing) => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValueOnce({
      ...running,
      preview: { ...running.preview, expiresAt: Date.now() + 1000 },
    });
    const f = await fixture();
    try {
      await f.click();
      if (timing === 'before-work') await act(async () => vi.advanceTimersByTimeAsync(1001));
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, busy: true } })),
      );
      if (timing === 'during-work') await act(async () => vi.advanceTimersByTimeAsync(1001));
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(f.host.querySelector('iframe')?.hidden).toBe(true);
      expect(f.host.textContent).toContain('pblV3.application.expired');
      if (timing === 'before-work') {
        await f.click();
        mocks.request.mockResolvedValueOnce({ state: 'running', observedAt: '' });
      }
      mocks.request.mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, expiresAt: Date.now() + 60_000 },
      });
      const reopen = [...f.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'pblV3.application.reopen',
      )!;
      if (timing === 'before-work') await f.click();
      else await act(async () => reopen.click());
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(
        timing === 'before-work' ? ['open', 'status', 'open'] : ['open', 'open'],
      );
      expect(f.host.querySelector('iframe')?.hidden).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['running', 'stopped', 'source-changed'])(
  'does not mint a ticket if the grant expires while checking a %s application',
  async (state) => {
    vi.useFakeTimers();
    let finish!: (observation: ApplicationObservation) => void;
    mocks.request
      .mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, expiresAt: Date.now() + 1000 },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const f = await fixture();
    try {
      await f.click();
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      await act(async () => vi.advanceTimersByTimeAsync(1001));
      await act(async () =>
        finish({
          observedAt: '',
          state: state === 'stopped' ? 'stopped' : 'running',
          sourceChanged: state === 'source-changed',
        }),
      );
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(['open', 'status']);
      expect(f.host.querySelector('iframe')?.hidden).toBe(true);
      expect(f.host.textContent).toContain('pblV3.application.expired');
    } finally {
      await f.cleanup();
    }
  },
);

it('retains a late accepted renewal while automatic status inspection is pending', async () => {
  vi.useFakeTimers();
  let finish!: (observation: ApplicationObservation) => void;
  mocks.request
    .mockResolvedValueOnce({
      ...running,
      preview: { ...running.preview, expiresAt: Date.now() + 1000 },
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300_000 },
        }),
      ),
    );
    await act(async () => finish({ state: 'running', observedAt: '', sourceChanged: false }));
    expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(['open', 'status']);
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hidden).toBe(false);
    expect(frame.hasAttribute('inert')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(frame.hidden).toBe(false);
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
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hidden).toBe(true);
    expect(frame.hasAttribute('inert')).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it('obtains a fresh new-tab ticket without replacing the live iframe or its input', async () => {
  const replace = vi.fn(),
    close = vi.fn();
  const popup = {
    location: { replace },
    close,
    opener: window,
    document: document.implementation.createHTMLDocument(),
  };
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
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

it('retains the unchanged embedded document after collapsing a pending new-tab open', async () => {
  const replace = vi.fn(),
    close = vi.fn();
  const popup = {
    location: { replace },
    close,
    opener: window,
    document: document.implementation.createHTMLDocument(),
  };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  let finish!: (observation: ApplicationObservation) => void;
  mocks.request
    .mockResolvedValueOnce(running)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ state: 'running', observedAt: '', sourceChanged: false });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.newTab"]') as HTMLButtonElement
      ).click(),
    );
    await f.click();
    await act(async () => finish(running));
    await f.click();
    expect(close).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual([
      'open',
      'open',
      'status',
    ]);
    expect(f.host.querySelectorAll('iframe')).toHaveLength(1);
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
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
      expect(frame.hidden).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);

it('accepts a confirmed renewal arriving after local expiry without remounting the iframe', async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue({
    ...running,
    preview: { ...running.preview, expiresAt: Date.now() + 1000 },
  });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    const source = frame.contentWindow;
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hidden).toBe(true);
    expect(frame.hasAttribute('inert')).toBe(true);
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300_000 },
        }),
      ),
    );
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.contentWindow).toBe(source);
    expect(frame.hidden).toBe(false);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

it('does not let an already queued old timeout expire a newly renewed grant', async () => {
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  mocks.request.mockResolvedValue({
    ...running,
    preview: { ...running.preview, expiresAt: Date.now() + 1000 },
  });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    const oldTimeout = timers.mock.calls.find((c) => c[1] === 1000)![0] as () => void;
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300_000 },
        }),
      ),
    );
    await act(async () => oldTimeout());
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hidden).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it.each(['ready', 'still-starting', 'rotated', 'failed'])(
  'reuses a new-tab launch receipt while startup is %s',
  async (status) => {
    vi.useFakeTimers();
    const replace = vi.fn(),
      close = vi.fn();
    const popup = {
      location: { replace },
      close,
      opener: window,
      document: document.implementation.createHTMLDocument(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    mocks.request
      .mockResolvedValueOnce(running)
      .mockResolvedValue({ ...running, state: 'starting', preview: undefined });
    const f = await fixture();
    try {
      await f.click();
      const frame = f.host.querySelector('iframe');
      if (status === 'ready')
        mocks.request
          .mockResolvedValueOnce({ ...running, state: 'starting', preview: undefined })
          .mockResolvedValueOnce({
            ...running,
            preview: { ...running.preview, url: 'https://isolated.example/preview#ready' },
          });
      if (status === 'failed')
        mocks.request
          .mockResolvedValueOnce({ ...running, state: 'starting', preview: undefined })
          .mockRejectedValueOnce(new Error('Startup failed'));
      await act(async () =>
        (
          f.host.querySelector('[aria-label="pblV3.application.newTab"]') as HTMLButtonElement
        ).click(),
      );
      expect(close).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      if (status === 'rotated')
        await act(async () => f.root.render(createElement(Harness, { epoch: 1 })));
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      const calls = mocks.request.mock.calls.slice(1);
      expect(calls.every((c) => c[1] === calls[0][1])).toBe(true);
      if (status === 'ready') {
        expect(replace).toHaveBeenCalledWith('https://isolated.example/preview#ready');
        expect(close).not.toHaveBeenCalled();
      } else {
        expect(replace).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
      }
      if (status === 'rotated') expect(calls).toHaveLength(1);
      else {
        expect(f.host.querySelector('iframe')).toBe(frame);
        if (status === 'still-starting' || status === 'failed')
          expect(f.host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
      }
    } finally {
      await f.cleanup();
    }
  },
);
