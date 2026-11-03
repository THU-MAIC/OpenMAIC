import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';
import { ONBOARDING_STORAGE_KEY } from '@/lib/pbl/v3/onboarding';

test.setTimeout(120000);

async function project(
  page: Page,
  learningEvents: (read: () => LearningSnapshot) => Promise<() => void>,
  {
    started = false,
    secondScene = false,
    streamFailure = false,
    completed = false,
    guideCompleted = started,
    acknowledgementFailure = false,
    application = true,
    quiz = false,
    locale = 'en-US',
    environmentReady = true,
    busy = false,
    completedArtifacts = completed,
    prepareGate,
    prepareFailure = false,
    beginGate,
    lagOpeningWorkbench = false,
    opening = false,
    initialDraft = '',
    staleWorkbench = false,
    priorProgress,
    openingText = '',
  }: {
    started?: boolean;
    secondScene?: boolean;
    streamFailure?: boolean;
    completed?: boolean;
    guideCompleted?: boolean | null;
    acknowledgementFailure?: boolean;
    application?: boolean;
    quiz?: boolean;
    locale?: string;
    environmentReady?: boolean;
    busy?: boolean;
    completedArtifacts?: boolean;
    prepareGate?: Promise<void>;
    prepareFailure?: boolean;
    beginGate?: Promise<void>;
    lagOpeningWorkbench?: boolean;
    opening?: boolean;
    initialDraft?: string;
    staleWorkbench?: boolean;
    priorProgress?: 'stage' | 'reset' | 'discard';
    openingText?: string;
  } = {},
) {
  await page.addInitScript((language) => localStorage.setItem('locale', language), locale);
  const stageId = uniqueStageId('onboarding');
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Workspace guide', createdAt: Date.now(), updatedAt: Date.now() },
    scenes: [
      {
        id: 'project',
        stageId,
        type: 'pbl',
        title: 'Workspace guide',
        order: 0,
        content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.1.0' } },
        actions: [],
      },
      ...(secondScene
        ? [
            {
              id: 'second',
              stageId,
              type: 'pbl' as const,
              title: 'Second project',
              order: 1,
              content: {
                type: 'pbl' as const,
                projectV3: { id: 'greeting-python-lab', version: '1.1.0' },
              },
              actions: [],
            },
          ]
        : []),
    ],
  });
  const view = {
    id: `${stageId}-study`,
    revision: 0,
    activitySequence: 0,
    title: 'Workspace guide',
    reportAvailable: completed,
    ...(guideCompleted === null ? {} : { onboardingCompleted: guideCompleted }),
    completedFilesAvailable: completedArtifacts,
    environmentId: 'fixture-environment',
    environment: { state: environmentReady ? 'running' : 'creating', ready: environmentReady },
    recovery: priorProgress === 'reset' ? { checkpointRevision: 0, progressReset: true } : null,
    ...(priorProgress === 'discard' ? { archiveDiscard: { at: new Date().toISOString() } } : {}),
    state: {
      status: completed ? 'completed' : 'running',
      position: {
        milestoneIndex: 0,
        milestoneId: 'greeting',
        stageIndex: quiz ? 5 : priorProgress === 'stage' ? 1 : 0,
      },
      milestones: [{ milestoneId: 'greeting', status: 'active' }],
      collected: { greeting: { decisions: [] } },
      decisionRevisions: {},
      lastSequence: 0,
    },
    stage: quiz
      ? { kind: 'check', checker: 'quiz' }
      : {
          kind: 'mentor_say',
          agent: 'discussion',
          say: 'Welcome',
          reads: [],
          studentActions: ['chat'],
        },
    milestones: [
      {
        id: 'greeting',
        title: 'Greeting',
        stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
      },
    ],
    role: quiz ? null : 'discussion',
    actions: quiz ? ['quiz'] : ['chat'],
    needsOpening: opening,
    files: ['PLAN.md'],
    busy,
    messages: openingText ? [{ role: 'assistant', text: openingText }] : [],
    roleRun: null,
    decisions: [],
    questions: quiz
      ? [{ q: 'A synthetic question', options: ['Draft choice', 'Other choice'] }]
      : [],
    evaluation: null,
    ...(application
      ? { application: { title: 'Guide preview', description: 'A synthetic application.' } }
      : {}),
  } as unknown as LearningView;
  const workbench = {
    environmentId: staleWorkbench ? 'stale-environment' : view.environmentId!,
    revision: 0,
    epoch: 0,
    canEdit: false,
    canManageFiles: false,
    canRun: false,
    planning: false,
    commands: [],
    terminals: [],
  };
  const commands: string[] = [];
  const calls: string[] = [];
  if (initialDraft)
    await page.addInitScript(
      ({ id, text }) => {
        sessionStorage.setItem(
          `maic:pbl-draft:v1:${id}:ui`,
          JSON.stringify({
            text,
            quizAnswers: { key: '', values: [] },
            decisionDrafts: {},
            showWorkspace: true,
            showAssistant: true,
          }),
        );
      },
      { id: view.id, text: initialDraft },
    );
  await page.route('**/api/pbl/v3**', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (url.pathname.endsWith('/activity')) return route.fulfill({ json: { recorded: true } });
    calls.push(
      `${route.request().method()} ${url.pathname}${body?.action ? ` ${body.action}` : ''}`,
    );
    if (url.searchParams.get('project') === '1')
      return route.fulfill({
        json: {
          started,
          hero: {
            title: view.title,
            description: 'A synthetic project for the workspace guide.',
            gains: ['Read, decide and review'],
            instructorName: 'Project tutor',
            milestoneCount: 1,
            taskCount: 7,
          },
        },
      });
    if (url.pathname.endsWith('/onboarding')) {
      if (acknowledgementFailure)
        return route.fulfill({ status: 503, json: { error: 'Try again' } });
      view.onboardingCompleted = true;
      return route.fulfill({ json: { onboardingCompleted: true } });
    }
    if (url.pathname.endsWith('/workspace')) return route.fulfill({ json: workbench });
    if (url.searchParams.has('file'))
      return route.fulfill({ json: { text: 'A saved plan.', hash: 'a'.repeat(64) } });
    if (body?.command) {
      commands.push(body.command.type);
      if (body.command.type === 'prepare') {
        if (prepareFailure)
          return route.fulfill({ status: 500, json: { error: 'Preparation failed' } });
        await prepareGate;
        view.environment = { state: 'running', ready: true };
        view.revision++;
        workbench.revision = view.revision;
      }
      if (body.command.type === 'begin') {
        await beginGate;
        view.needsOpening = false;
        view.busy = true;
        view.roleRun = { status: 'running', failure: null, canRetry: false };
        view.revision++;
        if (!lagOpeningWorkbench) workbench.revision = view.revision;
      }
    }
    return route.fulfill({ json: body?.command ? { view } : view });
  });
  const publishRaw = await learningEvents(() => ({
    view,
    workbench: view.environment?.ready ? workbench : null,
  }));
  if (streamFailure)
    await page.route('**/api/pbl/v3/events?**', (route) =>
      route.fulfill({ status: 503, body: 'Unavailable' }),
    );
  const publish = async () => {
    workbench.revision = view.revision;
    await publishRaw();
  };
  await page.goto(`/classroom/${stageId}`);
  await page.locator('[data-testid="pbl-v3-entry"] button').first().click();
  await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'true');
  return { view, workbench, commands, calls, publish, publishRaw, stageId };
}

const tour = (page: Page) => page.locator('[data-pbl-onboarding="card"]');
const next = (page: Page) => tour(page).locator('footer button').last();
async function finish(page: Page) {
  while (await tour(page).count()) {
    const last = (await tour(page).getAttribute('data-step')) === 'replay';
    await next(page).click();
    if (last) {
      await expect(tour(page)).toHaveCount(0);
      break;
    }
  }
}
async function correctSpotlight(page: Page, selector: string) {
  const spotlight = page.locator('[data-pbl-onboarding="spotlight"]');
  // A hidden/off-screen region may have no spotlight, but never an unrelated one.
  if (!(await spotlight.count())) return;
  const anchor = (await page.locator(selector).boundingBox())!;
  const box = (await spotlight.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(anchor.x);
  expect(box.x).toBeLessThan(anchor.x + anchor.width);
  expect(box.y + box.height).toBeGreaterThan(anchor.y);
  expect(box.y).toBeLessThan(anchor.y + anchor.height);
}

test('blocks pointer and keyboard interaction during preparation, then opens the first real region', async ({
  page,
  learningEvents,
}, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await project(page, learningEvents, {
    environmentReady: false,
    prepareGate: gate,
    opening: true,
  });
  const loading = page.getByTestId('pbl-workbench-loading');
  await expect(loading).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('entry-loading.png') });
  await expect(page.getByRole('dialog')).toContainText('Loading your workspace');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Must not become a draft');
  await loading.click({ position: { x: 10, y: 10 } });
  await expect(loading).toBeVisible();
  await expect(page.locator('[data-pbl-tour="composer"] textarea')).toHaveValue('');
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  expect(fixture.commands).toEqual(['prepare']);
  release();
  await expect(loading).toHaveCount(0);
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await expect.poll(() => fixture.commands).toEqual(['prepare', 'begin']);
  expect(fixture.view.busy).toBe(true);
});

test('releases the entry barrier for preparation errors so retry remains usable', async ({
  page,
  learningEvents,
}) => {
  await project(page, learningEvents, { environmentReady: false, prepareFailure: true });
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await expect(page.getByTestId('pbl-environment-setup').getByRole('button')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
});

test('does not keep a barrier while only the stream is reconnecting', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  await project(page, learningEvents, { streamFailure: true });
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await page.clock.runFor(15000);
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh progress', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
});

test('Continue keeps drafts and navigation usable during a slow restore', async ({
  page,
  learningEvents,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await project(page, learningEvents, {
    started: true,
    environmentReady: false,
    prepareGate: gate,
  });
  await expect.poll(() => fixture.commands).toContain('prepare');
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await page
    .locator('[data-pbl-tour="composer"] textarea')
    .fill('Keep this returning learner draft');
  await expect(page.locator('[data-pbl-tour="composer"] textarea')).toHaveValue(
    'Keep this returning learner draft',
  );
  await page.getByRole('button', { name: 'Back to project overview', exact: true }).click();
  release();
  await expect(page.getByTestId('pbl-v3-workspace')).toHaveCount(0);
});

for (const completed of [false, true]) {
  test(`does not trap an unavailable passive view (completed=${completed})`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents, {
      started: completed,
      completed,
      completedArtifacts: false,
      application: false,
      environmentReady: false,
      busy: !completed,
    });
    await expect(page.getByTestId('pbl-environment-setup')).toBeVisible();
    await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
    expect(fixture.commands).not.toContain('prepare');
    await page.getByRole('button', { name: 'Back to project overview', exact: true }).click();
    await expect(page.getByTestId('pbl-v3-workspace')).toHaveCount(0);
  });
}

test('a hung initial prepare releases the barrier without retrying the unknown operation', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await project(page, learningEvents, {
    environmentReady: false,
    prepareGate: gate,
  });
  await expect.poll(() => fixture.commands).toEqual(['prepare']);
  await expect(page.getByTestId('pbl-workbench-loading')).toBeVisible();
  await page.clock.runFor(30_100);
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  expect(fixture.commands).toEqual(['prepare']);
  await page.getByRole('button', { name: 'Back to project overview', exact: true }).click();
  release();
  await expect(page.getByTestId('pbl-v3-workspace')).toHaveCount(0);
});

test('uses the current progress anchor after a live stage transition', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  fixture.view.state.position.stageIndex = 1;
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.locator('[data-pbl-tour="progress"]')).toContainText('2/7');
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toBeVisible();
  await correctSpotlight(page, '[data-pbl-tour="progress"]');
});

test('completed projects replay basic UI without claiming a current learning step', async ({
  page,
  learningEvents,
}) => {
  await project(page, learningEvents, { started: true, completed: true, application: false });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await page.locator('[data-pbl-tour="replay"]').click();
  for (let i = 0; i < 3; i++) await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'replay');
  await expect(tour(page)).not.toContainText('current step');
  await finish(page);
});

test('keeps the current page when an HTTP reply arrives before its workspace snapshot', async ({
  page,
  learningEvents,
}) => {
  let release!: () => void;
  const beginGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await project(page, learningEvents, {
    opening: true,
    beginGate,
    lagOpeningWorkbench: true,
  });
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.command?.type === 'begin',
  );
  release();
  await (await response).finished();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  await fixture.publish();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  expect(fixture.commands).toEqual(['begin']);
});

for (const event of ['online', 'visibilitychange']) {
  test(`retains the guide and page during ${event} reconnection`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents);
    await expect(tour(page)).toBeVisible();
    await next(page).click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reconnect!: () => void;
    const started = new Promise<void>((resolve) => {
      reconnect = resolve;
    });
    await page.route('**/api/pbl/v3/events?**', async (route) => {
      reconnect();
      await gate;
      await route.fallback();
    });
    await page.evaluate((event) => {
      if (event === 'online') window.dispatchEvent(new Event(event));
      else {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event(event));
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        document.dispatchEvent(new Event(event));
      }
    }, event);
    await started;
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
    release();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    expect(fixture.commands).toEqual([]);
  });
}

test('five essential regions preserve focus and perform no learning actions', async ({
  page,
  learningEvents,
}, testInfo) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await expect(tour(page)).toContainText('Workspace guide 1/5');
  await page.screenshot({ path: testInfo.outputPath('first-region.png') });
  await expect(next(page)).toBeFocused();
  await expect(tour(page).locator('footer button')).toHaveCount(1);
  await page.locator('[data-pbl-onboarding="overlay"]').click({ position: { x: 5, y: 400 } });
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await page.keyboard.press('Space');
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  await expect(next(page)).toBeFocused();
  await correctSpotlight(page, '[data-testid="pbl-assistant"]');
  await page.screenshot({ path: testInfo.outputPath('assistant-region.png') });
  const anchor = (await page.getByTestId('pbl-assistant').boundingBox())!;
  const lit = (await page.locator('[data-pbl-onboarding="spotlight"]').boundingBox())!;
  expect(lit.height).toBeGreaterThan(anchor.height - 12);
  await tour(page).getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  for (const step of ['discussion', 'code', 'application', 'replay']) {
    await next(page).click();
    await expect(tour(page)).toHaveAttribute('data-step', step);
  }
  await expect(tour(page)).toContainText('Workspace guide 5/5');
  await next(page).click();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId('pbl-v3-workspace')).toBeFocused();
  await expect.poll(() => fixture.view.onboardingCompleted).toBe(true);
  expect(fixture.commands).toEqual([]);
  expect(fixture.calls.some((call) => /application|report/.test(call))).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Start Project', exact: true }).click();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await finish(page);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeFocused();
});

test('collapsed code region highlights its own expand control', async ({
  page,
  learningEvents,
}) => {
  await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await finish(page);
  await page.locator('[data-pbl-tour="workspace-toggle"]').click();
  await expect(page.locator('[data-pbl-tour="workspace-toggle"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.locator('[data-pbl-tour="replay"]').click();
  await next(page).click();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'code');
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toBeVisible();
  await correctSpotlight(page, '[data-pbl-tour="workspace-toggle"]');
});

test('retained first-entry drafts defer the guide and remain available through manual replay', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { initialDraft: 'Keep this draft' });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await finish(page);
  await expect(page.locator('[data-pbl-tour="composer"] textarea')).toHaveValue('Keep this draft');
  expect(fixture.commands).toEqual([]);
});

test('existing quiz uses four regions, preserves task drafts, and survives denied preference storage', async ({
  page,
  learningEvents,
}) => {
  await page.addInitScript((key) => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw Error('Denied');
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw Error('Denied');
      return set.call(this, name, value);
    };
  }, ONBOARDING_STORAGE_KEY);
  const fixture = await project(page, learningEvents, {
    started: true,
    application: false,
    quiz: true,
  });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Current task', exact: true }).click();
  await page.getByRole('radio', { name: 'Draft choice', exact: true }).check();
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toContainText('Workspace guide 1/4');
  await finish(page);
  await expect(page.getByRole('radio', { name: 'Draft choice', exact: true })).toBeChecked();
  expect(fixture.commands).toEqual([]);
});

for (const guideCompleted of [false, null] as const)
  test(`V3 entry ignores legacy browser history and resumes unfinished metadata=${guideCompleted}`, async ({
    page,
    learningEvents,
  }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'seen'), ONBOARDING_STORAGE_KEY);
    const fixture = await project(page, learningEvents, {
      started: true,
      guideCompleted,
    });
    await expect(tour(page)).toHaveAttribute('data-step', 'progress');
    await page.reload();
    await page.getByTestId('pbl-v3-entry').getByRole('button').first().click();
    await expect(tour(page)).toHaveAttribute('data-step', 'progress');
    await finish(page);
    await expect.poll(() => fixture.view.onboardingCompleted).toBe(true);
  });

test('failed seen writes close immediately and retry on the next untouched entry', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { acknowledgementFailure: true });
  await expect(tour(page)).toBeVisible();
  await finish(page);
  await expect(tour(page)).toHaveCount(0);
  expect(fixture.view.onboardingCompleted).toBe(false);
  await expect(page.locator('[data-pbl-tour="composer"] textarea')).toBeEditable();
  await page.reload();
  await page.getByTestId('pbl-v3-entry').getByRole('button').first().click();
  await expect(tour(page)).toBeVisible();
  await page.route('**/api/pbl/v3/onboarding', async (route) => {
    fixture.view.onboardingCompleted = true;
    await route.fulfill({ json: { onboardingCompleted: true } });
  });
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(() => fixture.view.onboardingCompleted).toBe(true);
});

test('requires a current matching snapshot only for entry and prioritizes real failures', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { staleWorkbench: true });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await expect(tour(page)).toHaveCount(0);
  fixture.workbench.environmentId = fixture.view.environmentId!;
  fixture.workbench.revision = fixture.view.revision;
  await fixture.publish();
  await expect(tour(page)).toBeVisible();
  for (const status of ['failed', 'missing', 'cancelled'] as const) {
    fixture.view.roleRun = { status, failure: null, canRetry: true };
    fixture.view.revision++;
    await fixture.publish();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry response', exact: true })).toBeVisible();
    fixture.view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
    fixture.view.revision++;
    await fixture.publish();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await expect(tour(page)).toBeVisible();
  }
  fixture.view.environment = { state: 'stopped', ready: false };
  fixture.view.busy = true;
  fixture.view.revision++;
  await fixture.publish();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId('pbl-environment-setup')).toBeVisible();
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
});

test('close and Escape acknowledge first viewing and do not replay automatically', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole('button', { name: 'Close guide', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(() => fixture.view.onboardingCompleted).toBe(true);
  await page.reload();
  await page.getByTestId('pbl-v3-entry').getByRole('button').first().click();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeFocused();
});

test('1440px first page highlights the whole task bar without covering its hint', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  const task = (await page.locator('[data-pbl-tour="task"]').boundingBox())!;
  const lit = (await page.locator('[data-pbl-onboarding="spotlight"]').boundingBox())!;
  const card = (await tour(page).boundingBox())!;
  const visibleRight = await page.evaluate(() =>
    Math.min(
      document.documentElement.clientWidth,
      document.documentElement.getBoundingClientRect().right,
    ),
  );
  expect(lit.x).toBeLessThanOrEqual(task.x);
  expect(lit.x + lit.width).toBeGreaterThanOrEqual(Math.min(visibleRight, task.x + task.width));
  expect(lit.height).toBeGreaterThanOrEqual(task.height);
  expect(
    Math.max(0, Math.min(card.x + card.width, task.x + task.width) - Math.max(card.x, task.x)) *
      Math.max(0, Math.min(card.y + card.height, task.y + task.height) - Math.max(card.y, task.y)),
  ).toBe(0);
});

test('narrow conversation jump control reserves space outside question text', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole('button', { name: 'Close guide', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  fixture.view.conversation = [
    {
      id: 'question',
      speaker: 'discussion',
      status: 'succeeded',
      parts: [{ kind: 'text', id: 'text', text: 'Read this question carefully.\n\n'.repeat(40) }],
    },
  ];
  fixture.view.revision++;
  await fixture.publish();
  const assistant = page.getByTestId('pbl-assistant');
  const scroll = assistant.getByTestId('pbl-conversation-scroll-button');
  await expect(scroll).toBeVisible();
  const control = (await scroll.boundingBox())!;
  const viewport = (await assistant
    .getByRole('log')
    .locator(':scope > div')
    .first()
    .boundingBox())!;
  expect(control.y).toBeGreaterThanOrEqual(viewport.y + viewport.height);
});

for (const [width, height, locale, docked] of [
  [320, 568, 'zh-CN', false],
  [390, 844, 'zh-CN', true],
  [320, 480, 'de-DE', false],
  [320, 480, 'ar-SA', false],
] as const) {
  test(`correct visible highlights and reachable controls at ${width}x${height} ${locale} docked=${docked}`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await project(page, learningEvents, { locale });
    await expect(tour(page)).toBeVisible();
    await finish(page);
    if (docked) await page.getByTestId('pbl-workspace-frame').locator(':scope > button').click();
    await page.locator('[data-pbl-tour="replay"]').click();
    const selectors = [
      '[data-pbl-tour="progress"]',
      '[data-pbl-tour="conversation"]',
      '[data-testid="pbl-ide"]',
      '[data-testid="pbl-application-open"]',
      '[data-pbl-tour="replay"]',
    ];
    for (let i = 0; i < 5; i++) {
      await correctSpotlight(page, selectors[i]);
      const box = (await tour(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
      await expect(next(page)).toBeInViewport();
      if (i === 0)
        await testInfo.attach('compact-guide', {
          body: await page.screenshot({ path: testInfo.outputPath('compact-guide.png') }),
          contentType: 'image/png',
        });
      await next(page).click();
    }
    await expect(tour(page)).toHaveCount(0);
  });
}

for (const guideCompleted of [false, true]) {
  test(`docking during Continue restoration preserves guide eligibility (seen=${guideCompleted})`, async ({
    page,
    learningEvents,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await project(page, learningEvents, {
      started: true,
      guideCompleted,
      environmentReady: false,
      prepareGate: gate,
    });
    await expect.poll(() => fixture.commands).toEqual(['prepare']);
    await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
    await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'false');
    release();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    if (!guideCompleted) {
      await expect(tour(page)).toHaveAttribute('data-step', 'progress');
      await finish(page);
    } else {
      await expect(tour(page)).toHaveCount(0);
    }
    await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'false');
    expect(fixture.commands).toEqual(['prepare']);
  });
}

test('completed-file replay survives transient reconnect but yields to terminal stream unavailability', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, {
    started: true,
    completed: true,
    application: false,
    environmentReady: false,
  });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await page.locator('[data-pbl-tour="replay"]').click();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconnect = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/api/pbl/v3/events?**', async (route) => {
    requested();
    await gate;
    await route.fulfill({ status: 401, json: { error: 'Unavailable' } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await reconnect;
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  release();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh progress', exact: true })).toBeEnabled();
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  expect(fixture.commands).toEqual([]);
});

for (const success of [true, false]) {
  test(`native fullscreen closes immediately while the optional seen write waits (success=${success})`, async ({
    page,
    learningEvents,
  }) => {
    await project(page, learningEvents, { secondScene: true });
    await expect(tour(page)).toBeVisible();
    await page.getByTestId('pbl-v3-entry').evaluate((element) => element.requestFullscreen());
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/pbl/v3/onboarding', async (route) => {
      await gate;
      await route.fulfill({
        status: success ? 200 : 503,
        json: success ? { onboardingCompleted: true } : { error: 'Retry' },
      });
    });
    await tour(page).getByRole('button', { name: 'Close guide', exact: true }).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByTestId('pbl-v3-workspace')).toBeFocused();
    await page.locator('[data-pbl-tour="composer"] textarea').fill('Keep typing while saving');
    await expect(page.locator('h1')).toHaveText('Workspace guide');
    const acknowledgement = page.waitForResponse((response) =>
      response.url().endsWith('/api/pbl/v3/onboarding'),
    );
    release();
    await (await acknowledgement).finished();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.locator('[data-pbl-tour="composer"] textarea')).toHaveValue(
      'Keep typing while saving',
    );
    await page.evaluate(() => document.exitFullscreen());
  });
}

test('320x480 docked assistant spotlight stays within its scroll viewport while scrolling', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await finish(page);
  await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  await page.locator('[data-pbl-tour="replay"]').click();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  const split = page.getByTestId('pbl-workbench-split');
  const check = async () => {
    const viewport = (await split.boundingBox())!;
    const spotlight = page.locator('[data-pbl-onboarding="spotlight"]');
    const lit = (await spotlight.count()) ? await spotlight.boundingBox() : null;
    if (lit) {
      expect(lit.x).toBeGreaterThanOrEqual(viewport.x - 1);
      expect(lit.y).toBeGreaterThanOrEqual(viewport.y - 1);
      expect(lit.x + lit.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
      expect(lit.y + lit.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    }
  };
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toBeVisible();
  await check();
  await split.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toHaveCount(0);
  await check();
});

for (const started of [false, true]) {
  test(`editing during restore defers auto-entry and preserves spaces/focus (Continue=${started})`, async ({
    page,
    learningEvents,
  }) => {
    await page.clock.install();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await project(page, learningEvents, {
      started,
      guideCompleted: false,
      environmentReady: false,
      prepareGate: gate,
    });
    await expect.poll(() => fixture.commands).toContain('prepare');
    if (!started) await page.clock.runFor(30_100);
    await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
    const composer = page.locator('[data-pbl-tour="composer"] textarea');
    await composer.fill('A draft before recovery');
    // Deferral lasts for this visit even if the learner clears the draft.
    await composer.fill('');
    release();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await page.keyboard.type('Words with spaces after recovery');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Words with spaces after recovery');
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
    await expect(tour(page)).toBeVisible();
  });
}

for (const priorProgress of ['stage', 'reset', 'discard', 'completed'] as const) {
  test(`existing ${priorProgress} progress never auto-opens but still supports replay`, async ({
    page,
    learningEvents,
  }) => {
    await project(page, learningEvents, {
      started: true,
      guideCompleted: false,
      ...(priorProgress === 'completed'
        ? { completed: true, environmentReady: false }
        : { priorProgress }),
    });
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
    await expect(tour(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tour(page)).toHaveCount(0);
  });
}

for (const [width, height] of [
  [320, 568],
  [390, 844],
] as const) {
  test(`assistant page keeps its opening question visible without an empty jump lane at ${width}x${height}`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    const question = 'What would you like to build?';
    await project(page, learningEvents, { openingText: question });
    await expect(tour(page)).toBeVisible();
    await next(page).click();
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    const assistant = page.getByTestId('pbl-assistant');
    await expect(assistant.getByTestId('pbl-conversation-scroll-lane')).toHaveCount(0);
    const text = (await assistant.getByText(question, { exact: true }).boundingBox())!;
    const viewport = (await assistant
      .getByRole('log', { includeHidden: true })
      .locator(':scope > div')
      .first()
      .boundingBox())!;
    expect(text.y).toBeGreaterThanOrEqual(viewport.y);
    expect(text.y + text.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    const card = (await tour(page).boundingBox())!;
    expect(text.y + text.height).toBeLessThanOrEqual(card.y);
    await page.screenshot({ path: testInfo.outputPath('assistant-visible.png') });
  });
}
