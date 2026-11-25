// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as audio from '@/lib/hooks/use-audio-recorder';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';
import { ONBOARDING_STORAGE_KEY } from '@/lib/pbl/v3/onboarding';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  status: 'connected',
  reconnect: vi.fn(),
  receive: (_snapshot: LearningSnapshot) => {},
  dirty: (_dirty: boolean) => {},
  message: { begin: vi.fn(), finish: vi.fn(), observe: vi.fn() },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: mocks.t, locale: 'en-US' }) }));
vi.mock('@/lib/hooks/use-theme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: () => 'stage' }));
vi.mock('@/components/scene-renderers/pbl/v3/activity-provider', () => ({
  usePblActivityGeneration: () => 1,
}));
vi.mock('@/components/scene-renderers/pbl/v3/use-learning-stream', () => ({
  useLearningStream: (_id: string, receive: typeof mocks.receive) => {
    mocks.receive = receive;
    return { status: mocks.status, reconnect: mocks.reconnect };
  },
}));
vi.mock('@/components/scene-renderers/pbl/v3/use-learner-message', () => ({
  useLearnerMessage: () => mocks.message,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workspace-frame', () => ({
  WorkspaceFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-split', () => ({
  WorkbenchSplit: ({ workspace, assistant }: { workspace: ReactNode; assistant: ReactNode }) =>
    createElement('div', null, workspace, assistant),
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-panel', () => ({
  LearningWorkbenchPanel: ({ onDirtyChange }: { onDirtyChange: typeof mocks.dirty }) => {
    mocks.dirty = onDirtyChange;
    return null;
  },
}));
vi.mock('@/components/scene-renderers/pbl/v3/task-dock', () => ({
  TaskDock: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/scene-renderers/pbl/v3/learning-panels', () => ({
  LearningPanels: () => null,
}));
vi.mock('@/components/scene-renderers/pbl/v3/conversation', () => ({
  LearningConversation: ({ overview }: { overview: ReactNode }) => overview,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-loading', () => ({
  WorkbenchLoading: ({ onReturnToHero }: { onReturnToHero?: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'loading' },
      onReturnToHero && createElement('button', { onClick: onReturnToHero }, 'Return'),
    ),
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-onboarding', () => ({
  WorkbenchOnboarding: ({ onFinish }: { onFinish: () => void }) =>
    createElement('button', { 'data-testid': 'guide', onClick: onFinish }, 'Finish guide'),
}));
import { PBLV3Workspace } from '@/components/scene-renderers/pbl/v3/workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
let view: LearningView;
let revision = 0;
let commands: { type: string; id: string }[];
let finishRequest: (() => void) | undefined;
let commandFailure: string | undefined;
let receipt: 'success' | 'failure' | 'pending';
let writes: number;
const returned = vi.fn();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const guide = () => host.querySelector<HTMLButtonElement>('[data-testid="guide"]');
const loading = () => host.querySelector('[data-testid="loading"]');
const start = () =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'pblV3.overview.startLearning',
  );
async function render(initialEntry = true) {
  await act(async () =>
    root.render(
      createElement(PBLV3Workspace, {
        sceneId: 'project',
        autoOnboarding: true,
        initialEntry,
        onReturnToHero: returned,
      }),
    ),
  );
}
async function publish(environmentId = view.environmentId!) {
  await act(async () =>
    mocks.receive({
      view: structuredClone(view),
      workbench: {
        environmentId,
        revision,
        epoch: 0,
        canEdit: false,
        canManageFiles: false,
        canRun: false,
        planning: false,
        commands: [],
        terminals: [],
      },
    }),
  );
}
async function click(button: HTMLButtonElement | null | undefined) {
  expect(button).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.status = 'connected';
  commands = [];
  revision = 0;
  writes = 0;
  receipt = 'success';
  finishRequest = undefined;
  commandFailure = undefined;
  view = {
    id: 'study',
    revision: 0,
    activitySequence: 0,
    title: 'Project',
    onboardingCompleted: false,
    environmentId: 'environment',
    environment: { state: 'running', ready: true },
    state: {
      status: 'running',
      position: { milestoneId: 'first', milestoneIndex: 0, stageIndex: 0 },
      collected: { first: { decisions: [] } },
      milestones: [],
      decisionRevisions: {},
      lastSequence: 0,
    },
    stage: {
      kind: 'mentor_say',
      agent: 'discussion',
      say: 'Welcome',
      reads: [],
      studentActions: ['chat'],
    },
    role: 'discussion',
    actions: ['chat'],
    needsOpening: true,
    busy: false,
    messages: [],
    questions: [],
    decisions: [],
    files: [],
    roleRun: null,
  } as unknown as LearningView;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/onboarding')) {
        writes++;
        if (receipt === 'pending')
          await new Promise<void>((resolve) => {
            finishRequest = resolve;
          });
        if (receipt === 'failure') return response({ error: 'Receipt unavailable' }, 503);
        view.onboardingCompleted = true;
        return response({ onboardingCompleted: true });
      }
      if (body.command) {
        commands.push(body.command);
        if (body.command.type === commandFailure) return response({ error: 'Try again' }, 503);
        if (body.command.type === 'prepare') {
          await new Promise<void>((resolve) => {
            finishRequest = resolve;
          });
          view.environment = { state: 'running', ready: true };
          view.revision++;
        }
        if (body.command.type === 'begin') {
          view.needsOpening = false;
          view.busy = true;
          view.roleRun = { status: 'running', failure: null, canRetry: false };
          view.revision++;
        }
        return response({ view });
      }
      return response(view);
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    finishRequest?.();
  });
  await act(async () => root.unmount());
  host.remove();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  returned.mockClear();
  mocks.reconnect.mockClear();
});

it('keeps a typed draft unsent until speech processing finishes', async () => {
  view.id = 'speech-study';
  view.onboardingCompleted = true;
  view.needsOpening = false;
  let processing = true;
  const useRecorder = audio.useAudioRecorder;
  const recorder = vi.spyOn(audio, 'useAudioRecorder').mockImplementation((options) => ({
    ...useRecorder(options),
    isProcessing: processing,
  }));
  await render(false);
  await publish();
  const form = host.querySelector<HTMLFormElement>('[data-pbl-tour="composer"]')!;
  const input = form.querySelector('textarea')!;
  const send = form.querySelector<HTMLButtonElement>('[aria-label="pblV3.send"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'Typed',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(send.disabled).toBe(true);
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    form.requestSubmit();
  });
  expect(commands).toEqual([]);
  await act(async () => {
    recorder.mock.lastCall![0]!.onTranscription!('and spoken');
    processing = false;
  });
  await publish();
  expect(input.value).toBe('Typed and spoken');
  await click(send);
  expect(commands).toEqual([expect.objectContaining({ type: 'chat', text: 'Typed and spoken' })]);
});

it.each([false, true])(
  'waits for explicit Start learning with guide completed=%s',
  async (completed) => {
    view.onboardingCompleted = completed;
    await render();
    await publish();
    expect(commands).toEqual([]);
    if (!completed) {
      expect(start()!.disabled).toBe(true);
      expect(host.querySelector('#pbl-start-blocked-project')!.textContent).toContain('guide');
      await click(guide());
    }
    await publish();
    expect(commands).toEqual([]);
    await click(start());
    expect(commands.map((command) => command.type)).toEqual(['begin']);
    expect(start()).toBeUndefined();
  },
);

it.each(['unsaved', 'retrying'] as const)(
  'explains %s and sends no opening until recovery',
  async (reason) => {
    view.onboardingCompleted = true;
    await render();
    await publish();
    if (reason === 'unsaved') await act(async () => mocks.dirty(true));
    else {
      mocks.status = 'retrying';
      await render();
    }
    expect(start()!.disabled).toBe(true);
    expect(start()!.getAttribute('aria-describedby')).toBe('pbl-start-blocked-project');
    expect(host.querySelector('#pbl-start-blocked-project')!.textContent).toContain(reason);
    expect(host.querySelector('#pbl-start-blocked-project')!.hasAttribute('role')).toBe(false);
    if (reason === 'retrying')
      expect(
        [...host.querySelectorAll('[role="status"]')].filter((status) =>
          status.textContent?.includes('pblV3.reconnectingUpdates'),
        ),
      ).toHaveLength(1);
    expect(commands).toEqual([]);
    await act(async () => mocks.dirty(false));
    mocks.status = 'connected';
    await render();
    await click(start());
    expect(commands.map((command) => command.type)).toEqual(['begin']);
  },
);

it('retries a failed first start only on explicit input', async () => {
  view.onboardingCompleted = true;
  commandFailure = 'begin';
  await render();
  await publish();
  start()!.focus();
  await click(start());
  await publish();
  expect(commands.map((command) => command.type)).toEqual(['begin']);
  expect(start()!.disabled).toBe(false);
  expect(document.activeElement).toBe(start());
  commandFailure = undefined;
  await click(start());
  expect(commands.map((command) => command.type)).toEqual(['begin', 'begin']);
  expect(start()).toBeUndefined();
});

it.each(['queued', 'existing', 'later'] as const)(
  'resumes %s entry without first-start gating',
  async (entry) => {
    view.onboardingCompleted = true;
    if (entry === 'queued') {
      view.busy = true;
      view.roleRun = { status: 'queued', failure: null, canRetry: false };
    } else if (entry === 'existing')
      view.messages = [{ role: 'assistant', text: 'Existing opening' }];
    else view.state.position.stageIndex = 1;
    await render(false);
    await publish();
    expect(start()).toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(entry === 'queued' ? [] : ['begin']);
  },
);

it.each(['stage', 'reset', 'discard', 'completed'] as const)(
  'offers replay without auto-entry after %s progress',
  async (progress) => {
    view.needsOpening = false;
    if (progress === 'stage') view.state.position.stageIndex = 1;
    if (progress === 'reset') view.recovery = { progressReset: true, checkpointRevision: 0 };
    if (progress === 'discard')
      view.archiveDiscard = {
        at: new Date(0).toISOString(),
        environmentId: 'old-environment',
        checkpointRevision: 0,
        checkpointAt: null,
        reason: 'unavailable',
      };
    if (progress === 'completed') view.state.status = 'completed';
    await render(false);
    await publish();
    expect(guide()).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
    expect(guide()).not.toBeNull();
    await click(guide());
    expect(guide()).toBeNull();
    expect(commands).toEqual([]);
  },
);

it.each(['failure', 'pending', 'success'] as const)(
  'closes locally before an optional %s seen receipt',
  async (outcome) => {
    receipt = outcome;
    await render();
    await publish();
    await click(guide());
    expect(guide()).toBeNull();
    expect(writes).toBe(1);
    await publish();
    expect(guide()).toBeNull();
    await act(async () => {
      finishRequest?.();
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    await publish();
    expect(!!guide()).toBe(outcome === 'failure');
    expect(commands).toEqual([]);
  },
);

it.each([false, undefined])(
  'ignores legacy completion when server completion is %s',
  async (completed) => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'seen');
    view.onboardingCompleted = completed;
    await render();
    await publish();
    expect(guide()).not.toBeNull();
    await click(guide());
    expect(writes).toBe(1);
  },
);

it('never reads or writes denied legacy preferences', async () => {
  const get = Storage.prototype.getItem,
    set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (key === ONBOARDING_STORAGE_KEY) throw Error('Denied');
    return get.call(this, key);
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === ONBOARDING_STORAGE_KEY) throw Error('Denied');
    return set.call(this, key, value);
  });
  await render();
  await publish();
  await click(guide());
  expect(guide()).toBeNull();
  expect(writes).toBe(1);
});

it('does not write another receipt when an acknowledged guide is replayed', async () => {
  view.onboardingCompleted = true;
  await render();
  await publish();
  expect(guide()).toBeNull();
  await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
  await click(guide());
  expect(writes).toBe(0);
  expect(commands).toEqual([]);
});

it.each(['failed', 'missing', 'cancelled'] as const)(
  'yields to a %s run and resumes after recovery',
  async (status) => {
    await render();
    await publish();
    expect(guide()).not.toBeNull();
    view.roleRun = { status, failure: null, canRetry: true };
    view.revision++;
    revision = view.revision;
    await publish();
    expect(guide()).toBeNull();
    view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
    view.revision++;
    revision = view.revision;
    await publish();
    expect(guide()).not.toBeNull();
  },
);

it('requires a matching snapshot to enter but holds an open guide through metadata gaps', async () => {
  view.revision = 1;
  await render();
  await publish();
  expect(guide()).toBeNull();
  expect(loading()).not.toBeNull();
  revision = 1;
  await publish();
  expect(guide()).not.toBeNull();
  view.revision++;
  await publish();
  expect(guide()).not.toBeNull();
  mocks.status = 'retrying';
  await render();
  expect(guide()).not.toBeNull();
  mocks.status = 'unavailable';
  await render();
  expect(guide()).toBeNull();
  expect(loading()).toBeNull();
});

it.each([false, true])(
  'prepares once and keeps the snapshot barrier only on initial entry=%s',
  async (initial) => {
    view.environment = { state: 'creating', ready: false };
    await render(initial);
    expect(commands.map((command) => command.type)).toEqual(['prepare']);
    expect(!!loading()).toBe(initial);
    await publish();
    expect(commands).toHaveLength(1);
    await act(async () => {
      finishRequest!();
    });
    expect(!!loading()).toBe(initial);
    expect(guide()).toBeNull();
    revision = view.revision;
    await publish();
    expect(loading()).toBeNull();
    expect(guide()).not.toBeNull();
    await click(guide());
    await click(start());
    expect(commands.map((command) => command.type)).toEqual(['prepare', 'begin']);
  },
);

it.each(['busy', 'completed', 'failed', 'retrying'] as const)(
  'releases the entry barrier for %s views',
  async (state) => {
    view.environment = { state: 'creating', ready: false };
    if (state === 'busy') view.busy = true;
    if (state === 'completed') view.state.status = 'completed';
    if (state === 'failed') commandFailure = 'prepare';
    if (state === 'retrying') mocks.status = 'retrying';
    await render();
    await publish();
    expect(loading()).toBeNull();
    expect(guide()).toBeNull();
    expect(commands.map((command) => command.type)).toEqual(
      ['busy', 'completed'].includes(state) ? [] : ['prepare'],
    );
    if (state === 'failed')
      expect(
        host.querySelector<HTMLButtonElement>('[data-testid="pbl-environment-setup"] button')!
          .disabled,
      ).toBe(false);
  },
);

it('keeps refresh usable during stream reconnection without holding an entry barrier', async () => {
  vi.useFakeTimers();
  mocks.status = 'retrying';
  await render();
  await publish();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(loading()).toBeNull();
  expect(guide()).toBeNull();
  await click(host.querySelector<HTMLButtonElement>('[aria-label="pblV3.refresh"]'));
  expect(mocks.reconnect).toHaveBeenCalledOnce();
  expect(commands).toEqual([]);
  expect(guide()).toBeNull();
});

it.each(['return', 'complete'] as const)(
  'keeps a slow prepare covered until %s without resending it',
  async (outcome) => {
    vi.useFakeTimers();
    view.environment = { state: 'creating', ready: false };
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    expect(loading()).not.toBeNull();
    expect(commands.map((command) => command.type)).toEqual(['prepare']);
    if (outcome === 'return') {
      await click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === 'Return'),
      );
      expect(returned).toHaveBeenCalledOnce();
    } else {
      await act(async () => {
        finishRequest!();
      });
      revision = view.revision;
      await publish();
      expect(loading()).toBeNull();
      expect(guide()).not.toBeNull();
    }
    expect(commands.map((command) => command.type)).toEqual(['prepare']);
  },
);

it('preserves a restored draft through manual replay without sending commands', async () => {
  view.needsOpening = false;
  window.sessionStorage.setItem(
    'maic:pbl-draft:v1:study:ui',
    JSON.stringify({
      text: 'Keep this draft',
      quizAnswers: { key: '', values: [] },
      decisionDrafts: {},
      showWorkspace: true,
      showAssistant: true,
    }),
  );
  await render(false);
  await publish();
  expect(guide()).toBeNull();
  await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
  await click(guide());
  expect(host.querySelector('textarea')!.value).toBe('Keep this draft');
  expect(commands).toEqual([]);
});

it('keeps returning input usable and defers the guide after focus during restoration', async () => {
  view.needsOpening = false;
  view.environment = { state: 'creating', ready: false };
  await render(false);
  const textarea = host.querySelector('textarea')!;
  await act(async () => textarea.focus());
  await act(async () => {
    finishRequest!();
  });
  revision = view.revision;
  await publish();
  expect(loading()).toBeNull();
  expect(guide()).toBeNull();
  expect(document.activeElement).toBe(textarea);
  expect(textarea.disabled).toBe(false);
  await click(
    host.querySelector<HTMLButtonElement>('[aria-label="pbl.v2.workspace.returnToHero"]'),
  );
  expect(returned).toHaveBeenCalledOnce();
  await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
  expect(guide()).not.toBeNull();
  expect(commands.map((command) => command.type)).toEqual(['prepare']);
});

it('replays completed files without restoring compute and yields to terminal stream failure', async () => {
  view.needsOpening = false;
  view.state.status = 'completed';
  view.completedFilesAvailable = true;
  view.environment = { state: 'destroyed', ready: false };
  await render(false);
  await publish();
  await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
  mocks.status = 'retrying';
  await render(false);
  expect(guide()).not.toBeNull();
  mocks.status = 'unavailable';
  await render(false);
  expect(guide()).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]')!.disabled).toBe(true);
  expect(loading()).toBeNull();
  expect(commands).toEqual([]);
});

it('requires the current environment before offering the guide', async () => {
  await render();
  await publish('stale-environment');
  expect(guide()).toBeNull();
  await publish();
  expect(guide()).not.toBeNull();
});

it('marks only acknowledged quiz answers submitted and enables changed answers', async () => {
  view.needsOpening = false;
  view.onboardingCompleted = true;
  view.stage = { kind: 'check', checker: 'quiz' } as LearningView['stage'];
  view.state.position.stageIndex = 5;
  view.questions = [{ q: 'Choose a direction', options: ['First', 'Second'] }];
  view.actions = ['quiz'];
  await render(false);
  await publish();
  const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  const button = (key: string) =>
    [...host.querySelectorAll('button')].find((element) => element.textContent === `pblV3.${key}`);
  await act(async () => radios[0]!.click());
  await click(host.querySelector<HTMLButtonElement>('[data-pbl-tour="replay"]'));
  await click(guide());
  expect(radios[0]!.checked).toBe(true);
  expect(commands).toEqual([]);
  await click(button('submitQuiz'));
  expect(button('submitted')).toBeUndefined();
  view.state.collected.first!.quiz = {
    id: 'receipt',
    attempt: 1,
    passed: true,
    score: 1,
    total: 1,
    wrong: [],
    answers: [0],
  };
  view.actions = ['quiz', 'next'];
  view.revision++;
  revision = view.revision;
  await publish();
  expect(button('submitted')!.disabled).toBe(true);
  await act(async () => radios[1]!.click());
  expect(button('resubmit')!.disabled).toBe(false);
  await act(async () => radios[0]!.click());
  expect(button('submitted')!.disabled).toBe(true);
  expect(commands.map((command) => command.type)).toEqual(['quiz']);
});
