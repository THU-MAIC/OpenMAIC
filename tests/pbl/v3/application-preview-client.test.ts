// @vitest-environment jsdom
import { act, createElement, Fragment, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { SandboxRequestError } from '@/components/sandbox/client';
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
const sourceWrite = [
  {
    id: 'source-write-turn',
    speaker: 'coder',
    status: 'running',
    parts: [
      { id: 'write', kind: 'tool', action: 'write', status: 'running', args: { path: 'app.py' } },
    ],
  },
] as LearningView['conversation'];
const workbench = { environmentId: 'environment', epoch: 0 } as LearningWorkbench;
it('renews the standalone preview before expiry without replacing its iframe', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  let grants = 0;
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend'
      ? {
          ...running,
          preview: {
            url: 'https://isolated.example/preview#grant-' + ++grants,
            expiresAt: Date.now() + 300_000,
          },
        }
      : { state: 'running', observedAt: '' },
  );
  const exchange = vi.fn(async () => Response.json({ expiresAt: Date.now() + 300_000 }));
  vi.stubGlobal('fetch', exchange);
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    const src = frame.src;
    expect(frame.hasAttribute('inert')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(240_000));
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange.mock.calls[0]).toEqual([
      new URL('https://isolated.example/__openmaic_renew'),
      expect.objectContaining({ body: 'grant-2', credentials: 'include' }),
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.src).toBe(src);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
      'open',
      'frontend',
      'frontend',
    ]);
  } finally {
    await f.cleanup();
  }
});

it('waits for the first running observation before mounting, and preserves the document across restarts', async () => {
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  let launch!: (result: ApplicationObservation) => void;
  let start = new Promise<ApplicationObservation>((resolve) => {
    launch = resolve;
  });
  mocks.request.mockImplementation((_url, request) =>
    request.action === 'frontend' ? Promise.resolve(running) : start,
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('pblV3.application.starting');
    await act(async () => launch({ state: 'running', observedAt: '' }));
    const frame = f.host.querySelector('iframe')!;
    expect(frame.classList.contains('invisible')).toBe(true);
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.classList.contains('invisible')).toBe(false);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    start = new Promise((resolve) => {
      launch = resolve;
    });
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
      ).click(),
    );
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.classList.contains('invisible')).toBe(false);
    await act(async () => launch({ state: 'running', observedAt: '' }));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(
      mocks.request.mock.calls.filter(([, input]) => input.action === 'frontend'),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
it('reopens a visible standalone document from application help without another Java operation', async () => {
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  let grants = 0;
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend'
      ? {
          ...running,
          preview: {
            url: 'https://isolated.example/preview#grant-' + ++grants,
            expiresAt: Date.now() + 300_000,
          },
        }
      : { state: 'running', observedAt: '' },
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.hasAttribute('inert')).toBe(false);

    const header = f.host.querySelector('header')!;
    expect(header.querySelector('[aria-label="pblV3.application.reopen"]')).toBeNull();
    const help = header.querySelector('details')!;
    await act(async () => help.querySelector('summary')!.click());
    expect(help.open).toBe(true);
    const reopen = help.querySelector('button')!;
    expect(reopen.textContent).toBe('pblV3.application.reopen');
    expect(reopen.disabled).toBe(false);
    await act(async () => reopen.click());
    const replacement = f.host.querySelector('iframe')!;
    expect(replacement.src).toContain('#grant-2');
    expect(replacement.hasAttribute('inert')).toBe(true);
    await act(async () => replacement.dispatchEvent(new Event('load')));
    expect(replacement.hasAttribute('inert')).toBe(false);
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
      'open',
      'frontend',
      'frontend',
    ]);
  } finally {
    await f.cleanup();
  }
});
it.each(['ENVIRONMENT_BUSY', 'STUDY_BUSY', 'unknown outcome'])(
  'keeps the standalone page clear of runtime errors during entry (%s)',
  async (reason) => {
    vi.useFakeTimers();
    const current: LearningView = {
      ...view,
      application: { ...view.application!, standaloneFrontend: true },
    };
    const launch = vi.fn().mockResolvedValue({ state: 'running', observedAt: '' });
    if (reason !== 'unknown outcome') {
      for (let i = 0; i < 4; i++)
        launch.mockRejectedValueOnce(
          new SandboxRequestError('Environment busy', 409, 'SANDBOX_CONFLICT', reason),
        );
    } else {
      launch.mockRejectedValueOnce(new Error('Unknown network outcome'));
    }
    mocks.request.mockImplementation((_url, input) =>
      input.action === 'frontend' ? Promise.resolve(running) : launch(input),
    );
    const f = await fixture();
    try {
      await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
      const panel = f.host.querySelector('[data-testid="pbl-application-panel"]')!;
      expect(panel.querySelector('iframe')).toBeNull();
      if (reason !== 'unknown outcome') {
        expect(panel.querySelector('[role="alert"]')).toBeNull();
        expect(panel.querySelector('[role="status"]')?.textContent).toBe(
          'pblV3.application.starting',
        );
        await act(async () => vi.advanceTimersByTimeAsync(2500));
        expect(launch).toHaveBeenCalledTimes(5);
        expect(launch.mock.calls.every(([input]) => input === launch.mock.calls[0][0])).toBe(true);
      } else {
        expect(launch).toHaveBeenCalledTimes(1);
        expect(panel.querySelector('[role="alert"]')?.textContent).toBe('Unknown network outcome');
        const reopen = [...panel.querySelectorAll('button')].find(
          (button) => button.textContent === 'pblV3.application.reopen',
        )!;
        await act(async () => reopen.click());
        expect(launch).toHaveBeenCalledTimes(2);
        expect(launch.mock.calls[1][0]).toEqual(launch.mock.calls[0][0]);
      }
      const frame = panel.querySelector('iframe')!;
      await act(async () => frame.dispatchEvent(new Event('load')));
      expect(panel.querySelector('[role="alert"], [role="status"]')).toBeNull();
      expect(frame.hasAttribute('inert')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);
it('retries temporary standalone launch failures with the same receipt before mounting', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  const launch = vi
    .fn()
    .mockRejectedValueOnce(new SandboxRequestError('Temporary failure', 503))
    .mockRejectedValueOnce(new SandboxRequestError('Temporary failure', 502))
    .mockResolvedValue({ state: 'running', observedAt: '' });
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend' ? running : launch(input),
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    await act(async () => vi.advanceTimersByTimeAsync(2_249));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(launch).toHaveBeenCalledTimes(3);
    expect(launch.mock.calls.every(([input]) => input === launch.mock.calls[0][0])).toBe(true);
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it('keeps a running standalone preview usable during a revision status check that hits the study lock', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  const status = vi
    .fn()
    .mockRejectedValueOnce(
      new SandboxRequestError('Study busy', 409, 'SANDBOX_CONFLICT', 'STUDY_BUSY'),
    )
    .mockResolvedValue({ state: 'running', observedAt: '' });
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend'
      ? running
      : input.action === 'status'
        ? status(input)
        : { state: 'running', observedAt: '' },
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    await act(async () =>
      f.root.render(
        createElement(Harness, { current: { ...current, revision: 1 }, automatic: true }),
      ),
    );
    expect(status).toHaveBeenCalledTimes(1);
    expect(frame.hasAttribute('inert')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(status).toHaveBeenCalledTimes(2);
    expect(status.mock.calls[1][0]).toBe(status.mock.calls[0][0]);
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).not.toContain('restart');
  } finally {
    await f.cleanup();
  }
});
it('defers the first preview grant while stage entry delays the application launch', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend' ? running : { state: 'running', observedAt: '' },
  );
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(
        createElement(Harness, { current, automatic: true, learningActionPending: true }),
      ),
    );
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('pblV3.application.starting');
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(mocks.request).not.toHaveBeenCalled();
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual(['open', 'frontend']);
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it('recovers a stopped preview after an observation conflict without racing a learning command', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  const status = vi
    .fn()
    .mockRejectedValueOnce(
      new SandboxRequestError('Application changed', 409, 'SANDBOX_CONFLICT', 'PROGRESS_CHANGED'),
    )
    .mockResolvedValue({ state: 'stopped', observedAt: '' });
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend'
      ? running
      : input.action === 'status'
        ? status(input)
        : { state: 'running', observedAt: '' },
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    const updated = { ...current, revision: 1 };
    await act(async () =>
      f.root.render(createElement(Harness, { current: updated, automatic: true })),
    );
    await act(async () =>
      f.root.render(
        createElement(Harness, { current: updated, automatic: true, learningActionPending: true }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
      'open',
      'frontend',
      'status',
      'status',
    ]);
    await act(async () =>
      f.root.render(createElement(Harness, { current: updated, automatic: true })),
    );
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
      'open',
      'frontend',
      'status',
      'status',
      'status',
      'open',
    ]);
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it.each([false, true])(
  'keeps the document visible through tests and quiz (isolated: %s)',
  async (isolated) => {
    const current: LearningView = {
      ...view,
      application: { ...view.application!, standaloneFrontend: true },
    };
    mocks.request.mockImplementation((_url, input) =>
      input.action === 'frontend'
        ? running
        : { state: input.action === 'status' && !isolated ? 'stopped' : 'running', observedAt: '' },
    );
    const f = await fixture();
    try {
      await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
      const frame = f.host.querySelector('iframe')!;
      await act(async () => frame.dispatchEvent(new Event('load')));
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: {
              ...current,
              revision: 1,
              evaluation: {
                id: 'test',
                state: 'running',
                stdout: '',
                stderr: '',
                ...(isolated ? { isolatedSources: true as const } : {}),
              },
            },
            automatic: true,
          }),
        ),
      );
      expect(frame.classList.contains('invisible')).toBe(false);
      expect(frame.hasAttribute('inert')).toBe(!isolated);
      expect(f.host.querySelector('[role="status"]')?.textContent).toBe(
        isolated ? undefined : 'pblV3.application.wait',
      );
      expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
        'open',
        'frontend',
      ]);
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: {
              ...current,
              revision: 2,
              busy: true,
              role: 'mentor',
              stage: { kind: 'check', checker: 'quiz' } as LearningView['stage'],
              evaluation: null,
            },
            automatic: true,
          }),
        ),
      );
      expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
        'open',
        'frontend',
        'status',
        ...(isolated ? [] : ['open']),
      ]);
      expect(f.host.querySelector('iframe')).toBe(frame);
      expect(frame.hasAttribute('inert')).toBe(false);
      expect(f.host.querySelector('[role="status"]')).toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);

it('checks readiness without replaying an acknowledged standalone launch', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend'
      ? running
      : {
          state: input.action === 'open' ? 'starting' : 'running',
          observedAt: '',
        },
  );
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    expect(f.host.querySelector('iframe')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
      'open',
      'status',
      'frontend',
    ]);
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it('keeps the first standalone preview recoverable after repeated startup timeouts', async () => {
  vi.useFakeTimers();
  const current: LearningView = {
    ...view,
    application: { ...view.application!, standaloneFrontend: true },
  };
  let state: ApplicationObservation['state'] = 'starting';
  mocks.request.mockImplementation((_url, input) =>
    input.action === 'frontend' ? running : { state, observedAt: '', sourceChanged: false },
  );
  const f = await fixture();
  const reopen = () =>
    [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === 'pblV3.application.reopen',
    )!;
  try {
    await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(reopen().disabled).toBe(false);
    await act(async () => reopen().click());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(f.host.querySelector('iframe')).toBeNull();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe(
      'pblV3.application.unavailable',
    );
    expect(reopen().disabled).toBe(false);

    state = 'running';
    await act(async () => reopen().click());
    const frame = f.host.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(
      mocks.request.mock.calls.filter(([, input]) => ['open', 'restart'].includes(input.action)),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it('restores the preview at the write review checkpoint while the reply is still streaming', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    const render = (parts: NonNullable<LearningView['conversation']>[number]['parts']) =>
      f.root.render(
        createElement(Harness, {
          current: {
            ...view,
            busy: true,
            conversation: [{ ...sourceWrite![0], parts }],
          },
        }),
      );
    await act(async () => render(sourceWrite![0].parts));
    expect(frame.hasAttribute('inert')).toBe(true);
    // Finishing the file write alone does not mean the build/review is safe.
    const written = [{ ...sourceWrite![0].parts[0], status: 'succeeded' as const }];
    await act(async () => render(written));
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () =>
      render([
        ...written,
        {
          id: 'review',
          kind: 'tool',
          action: 'review',
          status: 'succeeded',
        },
        { id: 'tail', kind: 'text', text: 'Review this version.', streaming: true },
      ]),
    );
    expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(['open', 'status']);
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it('waits for slow startup with one receipt instead of abandoning the initial automatic preview', async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue({ state: 'starting', observedAt: '' });
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { automatic: true })));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    mocks.request.mockResolvedValue(running);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(f.host.querySelector('iframe')).not.toBeNull();
    const ids = mocks.request.mock.calls.map((call) => call[1].id);
    expect(new Set(ids).size).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it.each(['failed-review', 'new-write', 'assessment'])(
  'keeps unsafe work paused despite an earlier review checkpoint (%s)',
  async (kind) => {
    mocks.request.mockResolvedValue(running);
    const f = await fixture();
    try {
      await f.click();
      const frame = f.host.querySelector('iframe')!;
      const parts: NonNullable<LearningView['conversation']>[number]['parts'] = [
        {
          id: 'write',
          kind: 'tool',
          action: 'write',
          args: { path: 'app.py' },
          status: 'succeeded',
        },
        {
          id: 'review',
          kind: 'tool',
          action: 'review',
          status: kind === 'failed-review' ? 'failed' : 'succeeded',
        },
      ];
      if (kind === 'new-write') parts.push({ ...sourceWrite![0].parts[0], id: 'second-write' });
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: {
              ...view,
              busy: true,
              conversation: [{ ...sourceWrite![0], parts }],
              evaluation: kind === 'assessment' ? ({} as LearningView['evaluation']) : null,
            },
          }),
        ),
      );
      expect(frame.hasAttribute('inert')).toBe(true);
      expect(mocks.request).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['ENVIRONMENT_BUSY', 'network'])(
  'reconciles only explicit environment-lock refusals with the same launch receipt (%s)',
  async (reason) => {
    vi.useFakeTimers();
    mocks.request
      .mockRejectedValueOnce(
        reason === 'ENVIRONMENT_BUSY'
          ? new SandboxRequestError('Environment busy', 409, 'SANDBOX_CONFLICT', reason)
          : new Error('Unknown network outcome'),
      )
      .mockResolvedValue(running);
    const f = await fixture();
    try {
      await act(async () => f.root.render(createElement(Harness, { automatic: true })));
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(mocks.request).toHaveBeenCalledTimes(reason === 'ENVIRONMENT_BUSY' ? 2 : 1);
      if (reason === 'ENVIRONMENT_BUSY') {
        expect(mocks.request.mock.calls[1][1]).toBe(mocks.request.mock.calls[0][1]);
        expect(f.host.querySelector('iframe')).not.toBeNull();
      } else expect(f.host.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
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
  inputPaused = false,
  workbenchEnvironmentId = workbench.environmentId,
  automatic = false,
  learningActionPending = false,
}: {
  current?: LearningView;
  epoch?: number;
  dirty?: boolean;
  inputPaused?: boolean;
  workbenchEnvironmentId?: string;
  automatic?: boolean;
  learningActionPending?: boolean;
}) {
  const preview = useApplicationPreview(
    current,
    { ...workbench, environmentId: workbenchEnvironmentId, epoch },
    dirty,
    automatic,
    learningActionPending,
  );
  return createElement(
    Fragment,
    null,
    createElement(ApplicationPreviewToggle, { preview }),
    createElement(ApplicationPreview, { application: current.application!, preview, inputPaused }),
  );
}
async function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let initialDocumentLoaded = false;
  await act(async () => root.render(createElement(Harness)));
  return {
    host,
    root,
    click: async () => {
      await act(async () =>
        (host.querySelector('[data-testid="pbl-application-open"]') as HTMLButtonElement).click(),
      );
      const frame = host.querySelector('iframe');
      if (
        !initialDocumentLoaded &&
        frame &&
        new URL(frame.src).pathname !== '/__openmaic_preview'
      ) {
        initialDocumentLoaded = true;
        await act(async () => frame.dispatchEvent(new Event('load')));
      }
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
it('finishes one automatic launch under StrictMode without consuming an aborted attempt', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(createElement(StrictMode, null, createElement(Harness, { automatic: true }))),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('iframe')).not.toBeNull();
  } finally {
    await f.cleanup();
  }
});
it('reopens an automatic preview after transient unavailability within the same binding', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  const render = (ready: boolean) =>
    f.root.render(
      createElement(Harness, {
        automatic: true,
        current: { ...view, environment: { ...view.environment!, ready } },
      }),
    );
  try {
    await act(async () => render(true));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => render(false));
    expect(f.host.querySelector('iframe')).toBeNull();
    await act(async () => render(true));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('iframe')).not.toBeNull();
    // A deliberate collapse still wins over automatic recovery.
    await f.click();
    await act(async () => render(false));
    await act(async () => render(true));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  } finally {
    await f.cleanup();
  }
});
it('reconciles the same automatic receipt after readiness interrupts a dispatched launch', async () => {
  let finish!: (value: ApplicationObservation) => void;
  let signal!: AbortSignal;
  mocks.request
    .mockImplementationOnce((_url, _body, abort: AbortSignal) => {
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { automatic: true })));
    const request = mocks.request.mock.calls[0][1];
    await act(async () =>
      f.root.render(
        createElement(Harness, {
          automatic: true,
          current: { ...view, environment: { ...view.environment!, ready: false } },
        }),
      ),
    );
    expect(signal.aborted).toBe(true);
    await act(async () => f.root.render(createElement(Harness, { automatic: true })));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1][1]).toEqual(request);
    const frame = f.host.querySelector('iframe');
    expect(frame).not.toBeNull();
    await act(async () =>
      finish({
        ...running,
        preview: { ...running.preview, url: 'https://isolated.example/stale' },
      }),
    );
    expect(f.host.querySelector('iframe')).toBe(frame);
  } finally {
    await f.cleanup();
  }
});
it('accepts genuine preview readiness while a modal pauses input without relaunching', async () => {
  mocks.request.mockResolvedValue({
    ...running,
    preview: { ...running.preview, url: 'https://isolated.example/__openmaic_preview' },
  });
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    const input = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => f.root.render(createElement(Harness, { inputPaused: true })));
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-ready' },
        }),
      ),
    );
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.className).not.toContain('invisible');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-input-request' },
        }),
      ),
    );
    expect(input).toHaveBeenLastCalledWith(
      { type: 'openmaic-preview-input', enabled: false },
      'https://isolated.example',
    );
    await act(async () => f.root.render(createElement(Harness, { inputPaused: false })));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(input).toHaveBeenLastCalledWith(
      { type: 'openmaic-preview-input', enabled: true },
      'https://isolated.example',
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () =>
      f.root.render(createElement(Harness, { inputPaused: true, dirty: true })),
    );
    await act(async () =>
      f.root.render(createElement(Harness, { inputPaused: false, dirty: true })),
    );
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(input).toHaveBeenLastCalledWith(
      { type: 'openmaic-preview-input', enabled: false },
      'https://isolated.example',
    );
  } finally {
    await f.cleanup();
  }
});
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
it.each(['source', 'dirty', 'assessment'])(
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
              busy: kind === 'source',
              conversation: kind === 'source' ? sourceWrite : undefined,
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
        f.root.render(
          createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
        ),
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
    if (interruption === 'revision' || interruption === 'failed-result')
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
      if (interruption !== 'revision' && interruption !== 'failed-result') {
        const dispatched = launch === 'restart' ? 1 : 2;
        expect(mocks.request.mock.calls.at(-1)![1]).toEqual(
          mocks.request.mock.calls[dispatched][1],
        );
      }
      const actions = mocks.request.mock.calls.map((call) => call[1].action);
      expect(actions).toEqual([
        'open',
        ...(launch === 'restart' ? [] : ['status']),
        launch === 'stopped' ? 'open' : 'restart',
        ...(interruption === 'revision' || interruption === 'failed-result'
          ? ['status', 'open']
          : [launch === 'stopped' ? 'open' : 'restart']),
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

it.each(['running', 'starting', 'changed'])(
  'checks a starting process without losing continuity (%s)',
  async (outcome) => {
    vi.useFakeTimers();
    const starting = { state: 'starting', observedAt: '', sourceChanged: outcome === 'changed' };
    mocks.request.mockResolvedValueOnce(running).mockResolvedValueOnce(starting);
    if (outcome === 'starting') mocks.request.mockResolvedValue(starting);
    else mocks.request.mockResolvedValue(running);
    const f = await fixture();
    try {
      await f.click();
      const old = f.host.querySelector('iframe');
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      await act(async () => vi.advanceTimersByTimeAsync(20_001));
      const actions = mocks.request.mock.calls.map((call) => call[1].action);
      if (outcome === 'changed') expect(actions).toEqual(['open', 'status', 'restart']);
      else {
        expect(actions).toEqual(
          outcome === 'starting'
            ? ['open', ...Array(21).fill('status')]
            : ['open', 'status', 'status'],
        );
        expect(f.host.querySelector('iframe')).toBe(old);
        expect(f.host.querySelectorAll('iframe')).toHaveLength(1);
        expect(f.host.querySelector('[role="alert"]')).toBeNull();
        if (outcome === 'starting') {
          expect(f.host.textContent).toContain('pblV3.application.starting');
          expect(
            [...f.host.querySelectorAll('button')].find(
              (b) => b.textContent === 'pblV3.application.reopen',
            )?.disabled,
          ).toBe(false);
        } else expect(old?.hasAttribute('inert')).toBe(false);
      }
    } finally {
      await f.cleanup();
    }
  },
);

it('stops automatic launch readiness retries at the retained grant deadline', async () => {
  vi.useFakeTimers();
  mocks.request
    .mockResolvedValueOnce({
      ...running,
      preview: { ...running.preview, expiresAt: Date.now() + 750 },
    })
    .mockResolvedValueOnce({ state: 'stopped', observedAt: '' })
    .mockResolvedValue({ state: 'starting', observedAt: '' });
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
      'open',
      'status',
      'open',
      'open',
    ]);
    expect(f.host.querySelector('iframe')?.hidden).toBe(true);
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it.each([false, true])(
  'checks the latest accepted deadline before accepting a launch result (renewed: %s)',
  async (renewed) => {
    vi.useFakeTimers();
    let finish!: (v: ApplicationObservation) => void;
    mocks.request
      .mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, expiresAt: Date.now() + 1000 },
      })
      .mockResolvedValueOnce({ state: 'stopped', observedAt: '' })
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      );
    const f = await fixture();
    try {
      await f.click();
      const old = f.host.querySelector('iframe')!;
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      await act(async () => vi.advanceTimersByTimeAsync(1001));
      if (renewed)
        await act(async () =>
          window.dispatchEvent(
            new MessageEvent('message', {
              source: old.contentWindow,
              origin: 'https://isolated.example',
              data: { type: 'openmaic-preview-activity', expiresAt: Date.now() + 300000 },
            }),
          ),
        );
      await act(async () =>
        finish({
          ...running,
          preview: {
            ...running.preview,
            url: 'https://isolated.example/replacement',
            expiresAt: Date.now() + 300000,
          },
        }),
      );
      expect(old.hidden).toBe(!renewed);
      expect(f.host.querySelectorAll('iframe')).toHaveLength(renewed ? 2 : 1);
      expect(mocks.request).toHaveBeenCalledTimes(3);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['ready', 'error', 'timeout'])(
  'retains the old document until authenticated shell readiness (%s)',
  async (outcome) => {
    vi.useFakeTimers();
    const gateway = (suffix: string) => ({
      ...running,
      preview: {
        ...running.preview,
        url: 'https://isolated.example/__openmaic_preview#' + suffix,
        expiresAt: Date.now() + 300000,
      },
    });
    mocks.request
      .mockResolvedValueOnce(gateway('old'))
      .mockResolvedValueOnce({ state: 'stopped', observedAt: '' })
      .mockResolvedValueOnce(gateway('new'));
    const f = await fixture();
    try {
      await f.click();
      const old = f.host.querySelector('iframe')!;
      const post = async (source: Window | null, origin: string, type: string) =>
        act(async () =>
          window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type } })),
        );
      await act(async () => old.dispatchEvent(new Event('load')));
      expect(f.host.querySelector('[aria-label="pblV3.application.newTab"]')).toBeNull();
      await post(old.contentWindow, 'https://isolated.example', 'openmaic-preview-ready');
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      const next = f.host.querySelectorAll('iframe')[1];
      await act(async () => next.dispatchEvent(new Event('load')));
      await post(old.contentWindow, 'https://isolated.example', 'openmaic-preview-ready');
      await post(next.contentWindow, 'https://foreign.example', 'openmaic-preview-ready');
      await post(null, 'https://isolated.example', 'openmaic-preview-ready');
      expect(f.host.querySelectorAll('iframe')).toHaveLength(2);
      if (outcome === 'timeout') await act(async () => vi.advanceTimersByTimeAsync(60001));
      else
        await post(
          next.contentWindow,
          'https://isolated.example',
          outcome === 'ready' ? 'openmaic-preview-ready' : 'openmaic-preview-error',
        );
      expect(f.host.querySelectorAll('iframe')).toHaveLength(outcome === 'ready' ? 1 : 2);
      if (outcome !== 'ready') {
        expect(f.host.querySelector('iframe')).toBe(old);
        expect(f.host.querySelector('[role="alert"]')).not.toBeNull();
        expect(
          [...f.host.querySelectorAll('button')].find(
            (b) => b.textContent === 'pblV3.application.reopen',
          )?.disabled,
        ).toBe(false);
      }
    } finally {
      await f.cleanup();
    }
  },
);

it('moves paused preview focus out without stealing editor focus or restoring stale focus', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    const frame = f.host.querySelector('iframe')!;
    frame.focus();
    await act(async () =>
      f.root.render(
        createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
      ),
    );
    expect(document.activeElement).toBe(
      f.host.querySelector('[data-testid="pbl-application-panel"]'),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(document.activeElement).not.toBe(frame);
    const editor = document.createElement('textarea');
    f.host.append(editor);
    editor.focus();
    await act(async () => f.root.render(createElement(Harness, { dirty: true })));
    expect(document.activeElement).toBe(editor);
  } finally {
    await f.cleanup();
  }
});

it.each(['gateway-error', 'direct-error', 'gateway-collapse', 'direct-collapse'])(
  'does not let older candidate readiness erase a newer dispatch intent: %s',
  async (kind) => {
    let reject!: (e: Error) => void;
    const vResult = {
      ...running,
      preview: {
        ...running.preview,
        url: kind.startsWith('gateway')
          ? 'https://isolated.example/__openmaic_preview#V'
          : 'https://isolated.example/V',
      },
    };
    mocks.request
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(vResult)
      .mockImplementationOnce(
        () =>
          new Promise((_r, fail) => {
            reject = fail;
          }),
      );
    mocks.request.mockResolvedValueOnce(running);
    const f = await fixture();
    try {
      await f.click();
      const restart = () =>
        act(async () =>
          (
            f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
          ).click(),
        );
      await restart();
      const v = f.host.querySelectorAll('iframe')[1];
      await restart();
      if (kind.startsWith('gateway'))
        await act(async () =>
          window.dispatchEvent(
            new MessageEvent('message', {
              source: v.contentWindow,
              origin: 'https://isolated.example',
              data: { type: 'openmaic-preview-ready' },
            }),
          ),
        );
      else await act(async () => v.dispatchEvent(new Event('load')));
      if (kind.endsWith('error'))
        await act(async () => reject(new Error('new dispatch response lost')));
      await f.click();
      await f.click();
      expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
        'open',
        'restart',
        'restart',
        'restart',
      ]);
    } finally {
      await f.cleanup();
    }
  },
);

it.each([false, true])(
  'retries one exact restart receipt once (already durable: %s)',
  async (durable) => {
    let finish!: (result: ApplicationObservation) => void;
    let launched = 0;
    const receipts = new Set<string>();
    let firstRestart = true;
    mocks.request.mockImplementation((_url, body) => {
      if (body.action === 'restart') {
        if (firstRestart) {
          firstRestart = false;
          if (durable) {
            receipts.add(body.id);
            launched++;
          }
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        if (!receipts.has(body.id)) {
          receipts.add(body.id);
          launched++;
        }
      }
      return Promise.resolve(running);
    });
    const f = await fixture();
    try {
      await f.click();
      const old = f.host.querySelector('iframe')!;
      await act(async () =>
        (
          f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
        ).click(),
      );
      const original = mocks.request.mock.calls[1][1];
      await f.click();
      await f.click();
      expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
        'open',
        'restart',
        'restart',
      ]);
      expect(mocks.request.mock.calls[2][1]).toEqual(original);
      expect(launched).toBe(1);
      expect(f.host.querySelectorAll('iframe')).toHaveLength(2);
      await act(async () => finish(running));
      expect(f.host.querySelectorAll('iframe')).toHaveLength(2);
      expect(f.host.querySelector('iframe')).toBe(old);
      await act(async () => f.host.querySelectorAll('iframe')[1].dispatchEvent(new Event('load')));
      expect(f.host.querySelectorAll('iframe')).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['revision', 'stage', 'epoch', 'environment'])(
  'drops an obsolete unresolved restart when %s changes instead of replaying stale input',
  async (change) => {
    mocks.request
      .mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(running);
    const f = await fixture();
    try {
      await f.click();
      await act(async () =>
        (
          f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
        ).click(),
      );
      const original = mocks.request.mock.calls[1][1];
      await f.click();
      const replacement = {
        ...view,
        revision: change === 'revision' ? 1 : 0,
        environmentId: change === 'environment' ? 'new-environment' : view.environmentId,
        ...(change === 'stage'
          ? {
              state: {
                position: { milestoneId: 'greeting', stageIndex: 1 },
              } as LearningView['state'],
            }
          : {}),
      };
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: replacement,
            epoch: change === 'epoch' ? 1 : 0,
            workbenchEnvironmentId: replacement.environmentId!,
          }),
        ),
      );
      await f.click();
      const later = mocks.request.mock.calls.slice(2).map((c) => c[1]);
      expect(later.every((r) => r.id !== original.id)).toBe(true);
      expect(later.at(-1)).toMatchObject({
        action: 'open',
        revision: replacement.revision,
        epoch: change === 'epoch' ? 1 : 0,
        environmentId: replacement.environmentId,
      });
      expect(later.some((r) => r.action === 'restart')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

it('a late ACK for an old request cannot acknowledge a newer unresolved launch', async () => {
  let finishOld!: (r: ApplicationObservation) => void,
    finishNew!: (r: ApplicationObservation) => void;
  mocks.request
    .mockResolvedValueOnce(running)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finishOld = r;
        }),
    )
    .mockResolvedValueOnce({ state: 'running', observedAt: '', sourceChanged: false })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finishNew = r;
        }),
    )
    .mockResolvedValue(running);
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    const newer = mocks.request.mock.calls[3][1];
    await act(async () => finishOld(running));
    await f.click();
    await f.click();
    expect(mocks.request.mock.calls.at(-1)![1]).toEqual(newer);
    await act(async () => finishNew(running));
    expect(f.host.querySelectorAll('iframe')).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

it('does not repeat a restart already acknowledged before a cancelled readiness retry', async () => {
  vi.useFakeTimers();
  mocks.request
    .mockResolvedValueOnce(running)
    .mockResolvedValueOnce({ state: 'starting', observedAt: '' })
    .mockResolvedValueOnce({ state: 'running', observedAt: '', sourceChanged: false })
    .mockResolvedValueOnce(running);
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      (
        f.host.querySelector('[aria-label="pblV3.application.restart"]') as HTMLButtonElement
      ).click(),
    );
    await f.click();
    await f.click();
    expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
      'open',
      'restart',
      'status',
      'open',
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(mocks.request).toHaveBeenCalledTimes(4);
  } finally {
    await f.cleanup();
  }
});

it('the visible reopen control reinspects changed source after an expired status response', async () => {
  vi.useFakeTimers();
  let finish!: (r: ApplicationObservation) => void;
  mocks.request
    .mockResolvedValueOnce({
      ...running,
      preview: { ...running.preview, expiresAt: Date.now() + 1000 },
    })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
  const f = await fixture();
  try {
    await f.click();
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    await act(async () => finish({ state: 'running', observedAt: '', sourceChanged: true }));
    mocks.request
      .mockResolvedValueOnce({ state: 'running', observedAt: '', sourceChanged: true })
      .mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, expiresAt: Date.now() + 300000 },
      });
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((b) => b.textContent === 'pblV3.application.reopen')!
        .click(),
    );
    expect(mocks.request.mock.calls.map((c) => c[1].action)).toEqual([
      'open',
      'status',
      'status',
      'restart',
    ]);
  } finally {
    await f.cleanup();
  }
});

it('does not launch an unopened or collapsed application when background work finishes', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(
        createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
      ),
    );
    await act(async () => f.root.render(createElement(Harness)));
    expect(mocks.request).not.toHaveBeenCalled();
    await f.click();
    await f.click();
    await act(async () =>
      f.root.render(
        createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
      ),
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
      f.root.render(
        createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
      ),
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
      f.root.render(
        createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
      ),
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
        f.root.render(
          createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
        ),
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
        f.root.render(
          createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
        ),
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
        f.root.render(
          createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
        ),
      );
      if (timing === 'during-work') await act(async () => vi.advanceTimersByTimeAsync(1001));
      await act(async () =>
        f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
      );
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(f.host.querySelector('iframe')?.hidden).toBe(true);
      expect(f.host.textContent).toContain('pblV3.application.expired');
      if (timing === 'before-work') await f.click();
      mocks.request.mockResolvedValueOnce({ state: 'running', observedAt: '' });
      mocks.request.mockResolvedValueOnce({
        ...running,
        preview: { ...running.preview, expiresAt: Date.now() + 60_000 },
      });
      const reopen = [...f.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'pblV3.application.reopen',
      )!;
      if (timing === 'before-work') await f.click();
      else await act(async () => reopen.click());
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual([
        'open',
        'status',
        'open',
      ]);
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
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
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

it.each(['auth', 'timeout'])(
  'automatically replaces the first standalone grant after %s, then allows manual recovery',
  async (mode) => {
    vi.useFakeTimers();
    const current: LearningView = {
      ...view,
      application: { ...view.application!, standaloneFrontend: true },
    };
    let grants = 0;
    mocks.request.mockImplementation((_url, input) =>
      input.action === 'frontend'
        ? {
            ...running,
            preview: {
              url: 'https://isolated.example/__openmaic_preview#grant-' + ++grants,
              expiresAt: Date.now() + 300_000,
            },
          }
        : { state: 'running', observedAt: '' },
    );
    const f = await fixture();
    const fail = async (frame: HTMLIFrameElement) => {
      if (mode === 'timeout') await act(async () => vi.advanceTimersByTimeAsync(15_000));
      else
        await act(async () =>
          window.dispatchEvent(
            new MessageEvent('message', {
              source: frame.contentWindow,
              origin: 'https://isolated.example',
              data: { type: 'openmaic-preview-error' },
            }),
          ),
        );
    };
    try {
      await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
      const first = f.host.querySelector('iframe')!;
      await fail(first);
      const second = f.host.querySelector('iframe')!;
      expect(second.src).toContain('#grant-2');
      expect(f.host.querySelector('[role="alert"]')).toBeNull();
      await fail(second);
      expect(f.host.querySelector('[role="alert"]')?.textContent).toBe(
        'pblV3.application.unavailable',
      );
      const retry = [...f.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'pblV3.application.reopen',
      )!;
      expect(retry.disabled).toBe(false);
      await act(async () => retry.click());
      expect(f.host.querySelector('iframe')?.src).toContain('#grant-3');
      expect(mocks.request.mock.calls.map(([, input]) => input.action)).toEqual([
        'open',
        'frontend',
        'frontend',
        'frontend',
      ]);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['auth', 'timeout'])(
  'reopens an initial document after %s readiness failure, then retains the ready document',
  async (mode) => {
    vi.useFakeTimers();
    const first = {
      ...running,
      preview: {
        ...running.preview,
        url: 'https://isolated.example/__openmaic_preview#first',
        expiresAt: Date.now() + 300_000,
      },
    };
    const second = {
      ...first,
      preview: { ...first.preview, url: 'https://isolated.example/__openmaic_preview#second' },
    };
    const status = { state: 'running', observedAt: '', sourceChanged: false };
    mocks.request
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(second);
    const f = await fixture();
    const signal = async (frame: HTMLIFrameElement, type: string) =>
      act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            origin: 'https://isolated.example',
            data: { type },
          }),
        ),
      );
    try {
      await f.click();
      const old = f.host.querySelector('iframe')!;
      if (mode === 'auth') await signal(old, 'openmaic-preview-error');
      else await act(async () => vi.advanceTimersByTimeAsync(60_001));
      await act(async () =>
        [...f.host.querySelectorAll('button')]
          .find((button) => button.textContent === 'pblV3.application.reopen')!
          .click(),
      );
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual([
        'open',
        'status',
        'open',
      ]);
      const fresh = f.host.querySelector('iframe')!;
      expect(fresh.src).toContain('#second');
      await signal(old, 'openmaic-preview-ready');
      expect(fresh.classList.contains('invisible')).toBe(true);
      await signal(fresh, 'openmaic-preview-ready');
      expect(fresh.classList.contains('invisible')).toBe(false);
      // Bounded startup observation can expose explicit Reopen for a document
      // that already succeeded. Returning to running must retain that document.
      mocks.request.mockResolvedValue({ ...status, state: 'starting' });
      await act(async () =>
        f.root.render(
          createElement(Harness, { current: { ...view, busy: true, conversation: sourceWrite } }),
        ),
      );
      await act(async () => f.root.render(createElement(Harness)));
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      mocks.request.mockResolvedValueOnce(status);
      await act(async () =>
        [...f.host.querySelectorAll('button')]
          .find((button) => button.textContent === 'pblV3.application.reopen')!
          .click(),
      );
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual([
        'open',
        'status',
        'open',
        ...Array(22).fill('status'),
      ]);
      expect(f.host.querySelector('iframe')).toBe(fresh);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['dirty', 'source', 'assessment'])(
  'retains an initial candidate that becomes ready during %s pause',
  async (pause) => {
    const first = {
      ...running,
      preview: { ...running.preview, url: 'https://isolated.example/__openmaic_preview#first' },
    };
    mocks.request
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ state: 'running', observedAt: '', sourceChanged: false })
      .mockResolvedValue({
        ...first,
        preview: { ...first.preview, url: 'https://isolated.example/__openmaic_preview#duplicate' },
      });
    const f = await fixture();
    try {
      await f.click();
      const frame = f.host.querySelector('iframe')!;
      frame.contentDocument!.write('<!doctype html><body></body>');
      frame.contentDocument!.close();
      const draft = frame.contentDocument!.createElement('input');
      draft.value = 'unsaved draft';
      frame.contentDocument!.body.append(draft);
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            dirty: pause === 'dirty',
            current: {
              ...view,
              busy: pause === 'source',
              conversation: pause === 'source' ? sourceWrite : undefined,
              evaluation: pause === 'assessment' ? ({} as LearningView['evaluation']) : null,
            },
          }),
        ),
      );
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            origin: 'https://isolated.example',
            data: { type: 'openmaic-preview-ready' },
          }),
        ),
      );
      expect(frame.hasAttribute('inert')).toBe(true);
      await act(async () => f.root.render(createElement(Harness)));
      expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(['open', 'status']);
      expect(f.host.querySelector('iframe')).toBe(frame);
      expect(frame.contentDocument!.querySelector('input')).toBe(draft);
      expect(draft.value).toBe('unsaved draft');
      expect(frame.hasAttribute('inert')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

it('opens the application once on entry, including a read-only Agent opening, and respects collapse', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(createElement(Harness, { automatic: true, current: { ...view, busy: true } })),
    );
    expect(mocks.request.mock.calls.map((call) => call[1].action)).toEqual(['open']);
    expect(
      f.host.querySelector('[data-testid="pbl-application-open"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    await f.click();
    await act(async () =>
      f.root.render(createElement(Harness, { automatic: true, current: { ...view, revision: 1 } })),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(
      f.host.querySelector('[data-testid="pbl-application-open"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  } finally {
    await f.cleanup();
  }
});

it.each([
  { change: 'epoch', reopened: false },
  { change: 'epoch', reopened: true },
  { change: 'environment', reopened: false },
  { change: 'environment', reopened: true },
])(
  'respects the last preview toggle after a $change change (reopened: $reopened)',
  async ({ change, reopened }) => {
    const current: LearningView = {
      ...view,
      application: { ...view.application!, standaloneFrontend: true },
    };
    mocks.request.mockImplementation((_url, input) =>
      input.action === 'frontend'
        ? {
            ...running,
            preview: {
              ...running.preview,
              url: `https://isolated.example/${input.environmentId}/${input.epoch}`,
            },
          }
        : { observedAt: '', state: 'running' },
    );
    const f = await fixture();
    try {
      await act(async () => f.root.render(createElement(Harness, { current, automatic: true })));
      const originalFrame = f.host.querySelector('iframe')!;
      expect(originalFrame).not.toBeNull();
      await f.click();
      if (reopened) await f.click();
      expect(f.host.querySelector('iframe')).toBe(originalFrame);

      const environmentId = change === 'environment' ? 'replacement' : current.environmentId!;
      const epoch = change === 'epoch' ? 1 : 0;
      await act(async () =>
        f.root.render(
          createElement(Harness, {
            current: { ...current, environmentId },
            workbenchEnvironmentId: environmentId,
            epoch,
            automatic: true,
          }),
        ),
      );
      expect(
        f.host.querySelector('[data-testid="pbl-application-open"]')?.getAttribute('aria-expanded'),
      ).toBe(String(reopened));
      const replacementFrame = f.host.querySelector('iframe');
      if (reopened) {
        expect(replacementFrame).not.toBe(originalFrame);
        expect(replacementFrame?.src).toBe(`https://isolated.example/${environmentId}/${epoch}`);
        expect(mocks.request.mock.calls.map(([, request]) => request.action)).toEqual([
          'open',
          'frontend',
          'open',
          'frontend',
        ]);
      } else {
        expect(replacementFrame).toBeNull();
        expect(mocks.request.mock.calls.map(([, request]) => request.action)).toEqual([
          'open',
          'frontend',
        ]);
      }
    } finally {
      await f.cleanup();
    }
  },
);

it('keeps preview input active through a read-only reply and its background unchanged-source check', async () => {
  let finish!: (value: ApplicationObservation) => void;
  mocks.request.mockResolvedValueOnce(running).mockImplementationOnce(
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
      f.root.render(createElement(Harness, { current: { ...view, busy: true, revision: 1 } })),
    );
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () =>
      f.root.render(createElement(Harness, { current: { ...view, revision: 1 } })),
    );
    expect(mocks.request.mock.calls[1][1].action).toBe('status');
    expect(frame.hasAttribute('inert')).toBe(false);
    await act(async () => finish({ observedAt: '', state: 'running', sourceChanged: false }));
    expect(f.host.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  } finally {
    await f.cleanup();
  }
});

it('does not automatically replay a failed default launch', async () => {
  mocks.request.mockRejectedValue(new Error('Unknown remote outcome'));
  const f = await fixture();
  try {
    await act(async () => f.root.render(createElement(Harness, { automatic: true })));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () =>
      f.root.render(createElement(Harness, { automatic: true, current: { ...view, revision: 1 } })),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(f.host.textContent).toContain('Unknown remote outcome');
  } finally {
    await f.cleanup();
  }
});

it('opens the preview independently when opening teaching has not started or fails', async () => {
  mocks.request.mockResolvedValue(running);
  const f = await fixture();
  try {
    await act(async () =>
      f.root.render(
        createElement(Harness, {
          automatic: true,
          current: { ...view, needsOpening: true },
        }),
      ),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('iframe')).not.toBeNull();
    await act(async () =>
      f.root.render(
        createElement(Harness, {
          automatic: true,
          current: { ...view, revision: 1, needsOpening: true, busy: true },
        }),
      ),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][1].revision).toBe(0);
    expect(f.host.querySelector('iframe')).not.toBeNull();
  } finally {
    await f.cleanup();
  }
});

it.each(['before', 'after'])(
  'retries a definitely rejected automatic launch only with a newer revision arriving %s refusal',
  async (order) => {
    let reject!: (error: Error) => void;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(running);
    const f = await fixture();
    const advance = () =>
      f.root.render(createElement(Harness, { automatic: true, current: { ...view, revision: 1 } }));
    try {
      await act(async () => f.root.render(createElement(Harness, { automatic: true })));
      const first = mocks.request.mock.calls[0][1];
      if (order === 'before') await act(async () => advance());
      await act(async () =>
        reject(
          new SandboxRequestError('Progress changed', 409, 'SANDBOX_CONFLICT', 'PROGRESS_CHANGED'),
        ),
      );
      if (order === 'after') {
        expect(mocks.request).toHaveBeenCalledTimes(1);
        await act(async () => f.root.render(createElement(Harness, { automatic: true })));
        expect(mocks.request).toHaveBeenCalledTimes(1);
        await act(async () => advance());
      }
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request.mock.calls[1][1].revision).toBe(1);
      expect(mocks.request.mock.calls[1][1].id).not.toBe(first.id);
      expect(f.host.querySelector('iframe')).not.toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
