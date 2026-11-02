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
    application = true,
    quiz = false,
    locale = 'en-US',
    environmentReady = true,
    prepareGate,
    beginGate,
    lagOpeningWorkbench = false,
    opening = false,
    initialDraft = '',
    staleWorkbench = false,
  }: {
    started?: boolean;
    application?: boolean;
    quiz?: boolean;
    locale?: string;
    environmentReady?: boolean;
    prepareGate?: Promise<void>;
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
    reportAvailable: false,
    environmentId: 'fixture-environment',
    environment: { state: environmentReady ? 'running' : 'creating', ready: environmentReady },
    recovery: null,
    state: {
      status: 'running',
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
const next = (page: Page) => tour(page).getByRole('button', { name: 'Got it, next', exact: true });

test('keeps the current guide page when an opening reply arrives before its workspace snapshot', async ({
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
  await expect.poll(() => fixture.commands).toEqual(['begin']);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  const response = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      request.url().endsWith('/api/pbl/v3') &&
      request.postDataJSON()?.command?.type === 'begin'
    );
  });
  release();
  await (await response).finished();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await fixture.publish();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  expect(fixture.commands).toEqual(['begin']);
});

test('waits through slow preparation and harmless loading clicks, without waiting for the opening reply', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  let release!: () => void;
  const prepareGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await project(page, learningEvents, {
    environmentReady: false,
    prepareGate,
    opening: true,
  });
  await expect.poll(() => fixture.commands).toContain('prepare');
  await page.clock.runFor(2000);
  await expect(page.getByTestId('pbl-environment-setup')).toBeVisible();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  await expect(tour(page)).toHaveCount(0);
  await page
    .getByTestId('pbl-v3-workspace')
    .getByRole('heading', { name: 'Workspace guide', exact: true })
    .click();
  release();
  await expect.poll(() => fixture.commands).toEqual(['prepare', 'begin']);
  await expect(tour(page)).toHaveAttribute('data-step', 'welcome');
  expect(fixture.view.busy).toBe(true);
  expect(fixture.view.roleRun?.status).toBe('running');
});

for (const draft of ['typed', 'retained']) {
  test(`does not interrupt a ${draft} draft after the learning environment connects`, async ({
    page,
    learningEvents,
  }) => {
    await page.clock.install();
    let release!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const text = 'A draft kept while the environment connects';
    const fixture = await project(page, learningEvents, {
      environmentReady: false,
      prepareGate,
      initialDraft: draft === 'retained' ? text : '',
    });
    const composer = page.locator('[data-pbl-tour="composer"] textarea');
    if (draft === 'typed') await composer.fill(text);
    await expect(composer).toHaveValue(text);
    await page.clock.runFor(2000);
    await expect(tour(page)).toHaveCount(0);
    release();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
    await expect(tour(page)).toBeVisible();
    await tour(page).getByRole('button', { name: 'Skip for now', exact: true }).click();
    await expect(composer).toHaveValue(text);
    expect(fixture.commands).toEqual(['prepare']);
  });
}

test('requires a current matching workspace snapshot before introducing the workbench', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  const fixture = await project(page, learningEvents, { staleWorkbench: true });
  await page.clock.runFor(2000);
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  fixture.workbench.environmentId = fixture.view.environmentId!;
  fixture.view.revision += 2;
  await fixture.publishRaw();
  await page.clock.runFor(100);
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
  fixture.workbench.revision = fixture.view.revision;
  await fixture.publishRaw();
  await expect(tour(page)).toBeVisible();
  expect(fixture.commands).toEqual([]);
});

test('gives asynchronous assistant failure and retry feedback priority over the guide', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  for (const status of ['failed', 'missing', 'cancelled'] as const) {
    fixture.view.busy = false;
    fixture.view.roleRun = { status, failure: null, canRetry: true };
    fixture.view.revision++;
    await fixture.publish();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry response', exact: true })).toBeVisible();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
    fixture.view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
    fixture.view.revision++;
    await fixture.publish();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
    await expect(tour(page)).toBeVisible();
  }
  expect(fixture.commands).toEqual([]);
});

test('closes for environment loss and leaves reconnect recovery in the learner’s control', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  fixture.view.environment = { state: 'stopped', ready: false };
  fixture.view.busy = true;
  fixture.view.revision++;
  await fixture.publish();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId('pbl-environment-setup')).toBeVisible();
  fixture.view.environment = { state: 'running', ready: true };
  fixture.view.busy = false;
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toBeVisible();
  expect(fixture.commands).toEqual([]);
});

test('fresh entry follows all 13 real regions without submitting, then remembers completion', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toHaveAttribute('data-step', 'welcome');
  await expect(tour(page)).toContainText('Workbench tour 1/13');
  await expect(page.locator('[data-pbl-tour="progress"]')).toContainText('1/7');
  await tour(page).getByRole('button', { name: 'More detail', exact: true }).click();
  await expect(tour(page)).toContainText('The code workspace (IDE)');
  await next(page).focus();
  await page.keyboard.press('Space');
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await expect(tour(page)).toContainText('M1 · 1/7');
  await tour(page).getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(
    tour(page).getByRole('button', { name: 'More detail', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  for (let i = 0; i < 12; i++) {
    await next(page).click();
    await page.keyboard.press('Tab');
    expect(await tour(page).evaluate((element) => element.contains(document.activeElement))).toBe(
      true,
    );
  }
  await expect(tour(page)).toHaveAttribute('data-step', 'return');
  await expect(tour(page)).toContainText('Workbench tour 13/13');
  expect(fixture.commands).toEqual([]);
  expect(fixture.calls.some((call) => /application|report/.test(call))).toBe(false);
  await tour(page).getByRole('button', { name: 'Finish and return', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByTestId('pbl-v3-workspace')).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    'seen',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Start Project', exact: true }).click();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeVisible();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toHaveAttribute('data-step', 'welcome');
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeFocused();
  expect(fixture.commands).toEqual([]);
});

test('can replay the guide in a ready docked workspace', async ({ page, learningEvents }) => {
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole('button', { name: 'Skip for now', exact: true }).click();
  await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'false');
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole('button', { name: 'Close tour', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeFocused();
  expect(fixture.commands).toEqual([]);
});

test('existing quiz replays 12 steps, preserves task drafts and handles denied preference storage', async ({
  page,
  learningEvents,
}) => {
  await page.addInitScript((key) => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new Error('Denied');
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error('Quota');
      return set.call(this, name, value);
    };
  }, ONBOARDING_STORAGE_KEY);
  const fixture = await project(page, learningEvents, {
    started: true,
    application: false,
    quiz: true,
  });
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="composer"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Current task', exact: true }).click();
  await page.getByRole('radio', { name: 'Draft choice', exact: true }).check();
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toContainText('Workbench tour 1/12');
  await next(page).click();
  await expect(tour(page)).toContainText('M1 · 6/7');
  await next(page).click();
  await expect(tour(page)).toContainText('This step uses task controls');
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Draft choice', exact: true })).toBeChecked();
  await expect(
    page.getByRole('region', { name: 'Current task details', exact: true }),
  ).toBeVisible();
  await page.locator('[data-pbl-tour="replay"]').click();
  await tour(page).getByRole('button', { name: 'Skip for now', exact: true }).click();
  expect(fixture.commands).toEqual([]);
});

test('typing defers automatic entry and recovery takes precedence without losing the draft', async ({
  page,
  learningEvents,
}) => {
  await page.clock.install();
  const fixture = await project(page, learningEvents);
  const composer = page.locator('[data-pbl-tour="composer"] textarea');
  await composer.fill('A learner draft before the tour');
  await page.clock.runFor(2000);
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await expect(tour(page)).toBeVisible();
  fixture.view.lifecycleError = 'Fixture checkpoint failure';
  fixture.view.revision++;
  await fixture.publish();
  await expect(tour(page)).toHaveCount(0);
  fixture.view.lifecycleError = null;
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await expect(tour(page)).toHaveCount(0);
  await page.locator('[data-pbl-tour="replay"]').click();
  await tour(page).getByRole('button', { name: 'Skip for now', exact: true }).click();
  await expect(composer).toHaveValue('A learner draft before the tour');
  expect(fixture.commands).toEqual([]);
});

test('Chinese progress explanation highlights the real task progress in both themes', async ({
  page,
  learningEvents,
}, testInfo) => {
  await project(page, learningEvents, { locale: 'zh-CN' });
  await expect(tour(page)).toBeVisible();
  await tour(page).locator('footer > div button').last().click();
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await tour(page).getByRole('button', { expanded: false }).click();
  const anchor = (await page.locator('[data-pbl-tour="progress"]').boundingBox())!;
  const spotlight = (await page.locator('[data-pbl-onboarding="spotlight"]').boundingBox())!;
  expect(spotlight.x).toBeLessThanOrEqual(anchor.x);
  expect(spotlight.y).toBeLessThanOrEqual(anchor.y);
  expect(spotlight.x + spotlight.width).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  expect(spotlight.y + spotlight.height).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark');
    await testInfo.attach(`zh-CN-progress-${theme}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
});

for (const locale of ['zh-CN', 'de-DE', 'ar-SA']) {
  test(`guide fits a short narrow workspace with details (${locale})`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await project(page, learningEvents, { locale });
    await expect(tour(page)).toHaveAttribute('data-step', 'welcome');
    await expect
      .poll(() =>
        tour(page)
          .locator('header button')
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            );
          }),
      )
      .toBe(true);
    await tour(page).getByRole('button', { expanded: false }).click();
    await testInfo.attach(`${locale}-narrow-guide`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    for (let i = 0; i < 13; i++) {
      await expect
        .poll(() =>
          tour(page)
            .locator('header button')
            .evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                ),
              );
            }),
        )
        .toBe(true);
      const box = await tour(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(321);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        await page.evaluate(() =>
          Math.min(
            document.documentElement.clientWidth,
            document.documentElement.getBoundingClientRect().right,
          ),
        ),
      );
      expect(box!.y + box!.height).toBeLessThanOrEqual(481);
      expect(
        await tour(page)
          .locator('footer')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await tour(page).locator('footer > div button').last().click();
    }
    await expect(tour(page)).toHaveCount(0);
  });
}
