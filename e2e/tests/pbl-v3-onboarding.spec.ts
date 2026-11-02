import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';
import { ONBOARDING_STORAGE_KEY } from '@/lib/pbl/v3/onboarding';

test.use({ onboarding: true });
test.setTimeout(120000);

async function project(
  page: Page,
  learningEvents: (read: () => LearningSnapshot) => Promise<() => void>,
  {
    started = false,
    streamFailure = false,
    completed = false,
    application = true,
    quiz = false,
    locale = 'en-US',
    environmentReady = true,
    prepareGate,
    prepareFailure = false,
    beginGate,
    lagOpeningWorkbench = false,
    opening = false,
    initialDraft = '',
    staleWorkbench = false,
  }: {
    started?: boolean;
    streamFailure?: boolean;
    completed?: boolean;
    application?: boolean;
    quiz?: boolean;
    locale?: string;
    environmentReady?: boolean;
    prepareGate?: Promise<void>;
    prepareFailure?: boolean;
    beginGate?: Promise<void>;
    lagOpeningWorkbench?: boolean;
    opening?: boolean;
    initialDraft?: string;
    staleWorkbench?: boolean;
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
    ],
  });
  const view = {
    id: `${stageId}-study`,
    revision: 0,
    activitySequence: 0,
    title: 'Workspace guide',
    reportAvailable: completed,
    completedFilesAvailable: completed,
    environmentId: 'fixture-environment',
    environment: { state: environmentReady ? 'running' : 'creating', ready: environmentReady },
    recovery: null,
    state: {
      status: completed ? 'completed' : 'running',
      position: { milestoneIndex: 0, milestoneId: 'greeting', stageIndex: quiz ? 5 : 0 },
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
    busy: false,
    messages: [],
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
  while (await tour(page).count()) await next(page).click();
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

test('releases initial loading after repeated stream failures and exposes recovery', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  await project(page, learningEvents, { streamFailure: true });
  await expect(page.getByTestId('pbl-workbench-loading')).toBeVisible();
  await page.clock.runFor(15000);
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh progress', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
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

test('five essential regions require completion, preserve focus, and perform no learning actions', async ({
  page,
  learningEvents,
}, testInfo) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await expect(tour(page)).toContainText('Workspace guide 1/5');
  await page.screenshot({ path: testInfo.outputPath('first-region.png') });
  await expect(next(page)).toBeFocused();
  await expect(tour(page).getByRole('button')).toHaveCount(1);
  await page.keyboard.press('Escape');
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
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    'seen',
  );
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

test('retained drafts prevent automatic entry and survive completing a replay', async ({
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

test('requires a current matching snapshot only for entry and prioritizes real failures', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { staleWorkbench: true });
  await expect(page.getByTestId('pbl-workbench-loading')).toBeVisible();
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
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
  }
  fixture.view.environment = { state: 'stopped', ready: false };
  fixture.view.busy = true;
  fixture.view.revision++;
  await fixture.publish();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId('pbl-environment-setup')).toBeVisible();
  await expect(page.getByTestId('pbl-workbench-loading')).toHaveCount(0);
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
