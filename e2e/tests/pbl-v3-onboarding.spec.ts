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
    finishedWork,
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
    finishedWork?: string;
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
  const applicationCalls: string[] = [];
  await page.route('https://onboarding-preview.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><label>Preview task<input aria-label="Preview task"></label>',
    }),
  );
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
    if (url.pathname.endsWith('/application')) {
      applicationCalls.push(body?.action);
      return route.fulfill({
        json: {
          state: 'running',
          observedAt: '',
          sourceChanged: false,
          ...(body?.action !== 'status'
            ? {
                preview: {
                  url: 'https://onboarding-preview.test/app',
                  expiresAt: Date.now() + 300000,
                },
              }
            : {}),
        },
      });
    }

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
            ...(finishedWork ? { finishedWork } : {}),
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
  return { view, workbench, commands, calls, applicationCalls, publish, publishRaw, stageId };
}

const tour = (page: Page) => page.locator('[data-pbl-onboarding="card"]');
const next = (page: Page) => tour(page).locator('footer button').last();

test('keeps the authored overview visible while its workbench guide toggles independently', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, {
    application: false,
    openingText: 'Welcome. First, we will work through the opening concepts together.',
    finishedWork: 'The complete greeting application with saved history.',
  });
  fixture.view.milestones![0].goal = 'Connect a name to a greeting.';
  fixture.view.milestones![0].outcome = 'A working greeting application.';
  fixture.view.revision++;
  await fixture.publish();
  const overview = page.locator('#pbl-project-overview');
  await expect(tour(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  const guideDetails = overview.locator('details');
  const guideToggle = guideDetails.locator('summary');
  await expect(guideDetails).not.toHaveAttribute('open');
  await expect(overview.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(overview).toContainText('A synthetic project for the workspace guide.');
  await expect(overview).toContainText('Connect a name to a greeting.');
  await expect(overview).toContainText('A working greeting application.');
  await expect(overview.locator('.pbl-overview-result')).toContainText(
    'The complete greeting application with saved history.',
  );
  await expect(overview.locator('.pbl-overview-result')).not.toContainText(
    'A working greeting application.',
  );
  await expect(overview.getByRole('list', { name: 'Project roadmap' })).toContainText('Greeting');
  await expect(overview).not.toContainText('Current learning step');
  await expect(overview).not.toContainText('Current goal');
  const opening = page.getByTestId('pbl-agent-turn').first();
  await expect(opening.getByRole('link', { name: 'Project overview' })).toHaveCount(0);
  const geometry = await overview.evaluate((el) => {
    const viewport = el.closest('.pbl-conversation-scroll');
    const content = el.querySelector('.pbl-overview-content');
    const outer = viewport!.getBoundingClientRect(),
      card = el.getBoundingClientRect();
    return {
      left: card.left - outer.left,
      right: outer.right - card.right,
      overflow: getComputedStyle(content!).overflowY,
      maxHeight: getComputedStyle(content!).maxHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(16);
  expect(geometry.right).toBeGreaterThanOrEqual(16);
  // The card fills the transcript at wide sizes too; only its content is compact.
  await page.getByRole('button', { name: 'Toggle code workspace', exact: true }).click();
  await expect
    .poll(() =>
      overview.evaluate((el) => el.parentElement!.clientWidth - el.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
  expect(geometry.overflow).toBe('visible');
  expect(geometry.maxHeight).toBe('none');
  await guideToggle.click();
  await expect(guideDetails).toHaveAttribute('open');
  await expect(guideDetails.locator('ol')).toBeVisible();
  await expect(overview).toContainText('Connect a name to a greeting.');
  // Server updates do not close a guide the learner is reading.
  fixture.view.revision++;
  await fixture.publish();
  await expect(guideDetails).toHaveAttribute('open');
  await guideToggle.focus();
  await page.keyboard.press('Enter');
  await expect(guideDetails).not.toHaveAttribute('open');
  await expect(guideToggle).toBeFocused();
  await expect(guideDetails.locator('ol')).not.toBeVisible();
  await expect(overview.getByRole('list', { name: 'Project roadmap' })).toBeVisible();
  await expect(overview).toContainText('A working greeting application.');
  expect(fixture.commands).toEqual([]);
});

test('shows only the current milestone goal and outcome in the drawer from its first step', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { started: true, application: false });
  fixture.view.milestones = [
    {
      id: 'greeting',
      title: 'First milestone',
      goal: 'First goal',
      outcome: 'First result',
      stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
    },
    {
      id: 'second',
      title: 'Second milestone',
      goal: 'Second goal',
      outcome: 'Second result',
      stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
    },
  ];
  fixture.view.revision++;
  await fixture.publish();
  const toggle = page.getByRole('button', { name: 'Current task', exact: true });
  const drawer = page.getByRole('region', { name: 'Current task details' });
  await toggle.click();
  // Legacy packages keep milestone results without copying one into the final work.
  await expect(page.locator('.pbl-overview-result')).toHaveCount(0);
  const summary = drawer.getByTestId('pbl-current-milestone-summary');
  await expect(summary).toContainText('Current milestone');
  await expect(summary.getByText('Goal:', { exact: true })).toHaveCSS('display', 'inline');
  await expect(summary.getByText('Outcome:', { exact: true })).toHaveCSS('display', 'inline');
  await expect(summary).toContainText('First goal');
  await expect(summary).toContainText('First result');
  await expect(summary).not.toContainText('Second goal');
  expect(await drawer.locator('.overflow-y-auto > *').first().getAttribute('data-testid')).toBe(
    'pbl-current-milestone-summary',
  );
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  fixture.view.state.position = { milestoneIndex: 1, milestoneId: 'second', stageIndex: 0 };
  fixture.view.revision++;
  await fixture.publish();
  await toggle.click();
  await expect(summary).toContainText('Second goal');
  await expect(summary).toContainText('Second result');
  await expect(summary).not.toContainText('First goal');
  expect(fixture.commands).toEqual([]);
});

for (const [width, guideCompleted] of [
  [1365, false],
  [390, false],
  [1365, true],
] as const) {
  test(`first entry keeps the overview visible through the welcome until the learner follows at ${width}px (tour completed: ${guideCompleted})`, async ({
    page,
    learningEvents,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await project(page, learningEvents, {
      application: false,
      guideCompleted,
    });
    fixture.view.messages = [{ role: 'assistant', text: 'Opening background.\n\n'.repeat(60) }];
    fixture.view.revision++;
    await fixture.publish();
    if (!guideCompleted) {
      await expect(tour(page)).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await expect(tour(page)).toHaveCount(0);
    const viewport = page.locator('.pbl-conversation-scroll');
    await expect(page.locator('#pbl-project-overview')).toBeVisible();
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
    for (let chunk = 0; chunk < 3; chunk++) {
      fixture.view.messages[0].text += `Welcome chunk ${chunk}.\n\n`.repeat(20);
      fixture.view.revision++;
      await fixture.publish();
      await expect(viewport).toContainText(`Welcome chunk ${chunk}.`);
      await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
    }
    const latest = page.getByTestId('pbl-conversation-scroll-button');
    await latest.click();
    fixture.view.messages[0].text += 'After choosing Latest.\n\n'.repeat(20);
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('After choosing Latest.');
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    await expect(latest).toBeVisible();
    const reading = await viewport.evaluate((el) => el.scrollTop);
    fixture.view.messages[0].text += 'While reading earlier text.\n\n'.repeat(20);
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('While reading earlier text.');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(reading, 0);
    await page.getByLabel('Your message', { exact: true }).fill('I am ready.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    expect(fixture.commands).toEqual(['chat']);
  });
}

test('highlights the existing next action only when progression is available', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { started: true, application: false });
  const advance = page.getByTestId('pbl-advance-bar');
  await expect(advance).toHaveCount(0);
  await expect(page.locator('#pbl-project-overview details')).not.toHaveAttribute('open');
  fixture.view.actions = ['chat', 'next'];
  fixture.view.revision++;
  await fixture.publish();
  const advanceButton = advance.getByRole('button', { name: 'Continue to Make your decisions' });
  await expect(advanceButton).toBeEnabled();
  await expect(advance).toHaveAttribute('data-attention', 'true');
  await advanceButton.hover();
  await expect(advance).toHaveAttribute('data-attention', 'false');
  await page.mouse.move(0, 0);
  fixture.view.revision++;
  await fixture.publish();
  await expect(advance).toHaveAttribute('data-attention', 'false');
  const barBox = (await advance.boundingBox())!;
  const buttonBox = (await advanceButton.boundingBox())!;
  const composerBox = (await page
    .locator('[data-pbl-tour="composer"] textarea')
    .locator('..')
    .boundingBox())!;
  expect(buttonBox.height).toBe(40);
  expect(buttonBox.width).toBeCloseTo(barBox.width, 0);
  expect(buttonBox.x).toBeCloseTo(composerBox.x, 0);
  expect(buttonBox.width).toBeCloseTo(composerBox.width, 0);
  expect(fixture.commands).toEqual([]);
  await advanceButton.click({ position: { x: 4, y: 20 } });
  await expect.poll(() => fixture.commands).toEqual(['next']);
});

test('stops next-step attention after eight seconds and respects reduced motion', async ({
  page,
  learningEvents,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await project(page, learningEvents, { started: true, application: false });
  await page.clock.install();
  fixture.view.actions = ['chat', 'next'];
  fixture.view.revision++;
  await fixture.publish();
  const advance = page.getByTestId('pbl-advance-bar');
  await expect(advance).toHaveAttribute('data-attention', 'true');
  await expect(advance).toHaveCSS('animation-name', 'none');
  await page.clock.fastForward(8_001);
  await expect(advance).toHaveAttribute('data-attention', 'false');
  await expect(advance.getByRole('button')).toBeEnabled();
  expect(fixture.commands).toEqual([]);
});

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
  const spotlights = page.locator('[data-pbl-onboarding="spotlight"]');
  // A hidden/off-screen region may have no spotlight, but never an unrelated one.
  if (!(await spotlights.count())) return;
  await expect
    .poll(async () => {
      const anchors = await Promise.all(
        (await page.locator(selector).all()).map((anchor) => anchor.boundingBox()),
      );
      const boxes = await Promise.all(
        (await spotlights.all()).map((spotlight) => spotlight.boundingBox()),
      );
      return (
        boxes.length > 0 &&
        boxes.every(
          (box) =>
            box &&
            anchors.some(
              (anchor) =>
                anchor &&
                box.x + box.width > anchor.x &&
                box.x < anchor.x + anchor.width &&
                box.y + box.height > anchor.y &&
                box.y < anchor.y + anchor.height,
            ),
        )
      );
    })
    .toBe(true);
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

test('loading keeps its accessible modal and focus through native fullscreen changes', async ({
  page,
  learningEvents,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const fixture = await project(page, learningEvents, {
      secondScene: true,
      environmentReady: false,
      prepareGate: gate,
    });
    const loading = page.getByTestId('pbl-workbench-loading');
    const dialog = page.getByRole('dialog', { name: 'Loading your workspace' });
    await expect(loading).toBeVisible();
    for (const fullscreen of [true, false]) {
      if (fullscreen)
        await page.getByTestId('pbl-v3-entry').evaluate((element) => element.requestFullscreen());
      else await page.evaluate(() => document.exitFullscreen());
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(fullscreen);
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      await page.keyboard.type('Must not become a draft');
      await expect(dialog).toBeFocused();
      await expect(page.locator('h1')).toHaveText('Workspace guide');
      await expect(page.locator('[data-pbl-tour="composer"] textarea')).toHaveValue('');
      expect(fixture.commands).toEqual(['prepare']);
    }
    release();
    await expect(loading).toHaveCount(0);
    await expect(tour(page)).toHaveAttribute('data-step', 'progress');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pbl-v3-workspace')).toBeFocused();
  } finally {
    release();
  }
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
  await correctSpotlight(page, '[data-pbl-tour="task"]');
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

test('narrow conversation jump control stays centered without widening either message gutter', async ({
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
      id: 'learner-question',
      speaker: 'user',
      status: 'succeeded',
      parts: [{ kind: 'text', id: 'learner-text', text: 'Learner question' }],
    },
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
  await assistant.locator('.pbl-conversation-scroll').hover();
  await page.mouse.wheel(0, -180);
  await expect(scroll).toBeVisible();
  const control = (await scroll.boundingBox())!;
  const viewport = await assistant
    .getByRole('log')
    .locator('.pbl-conversation-scroll')
    .evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height, contentRight: x + el.clientLeft + el.clientWidth };
    });
  const bubble = (await assistant.locator('.pbl-assistant-bubble').boundingBox())!;
  expect(control.x + control.width / 2).toBeCloseTo(viewport.x + viewport.width / 2, 0);
  expect(bubble.x - viewport.x).toBeCloseTo(16, 0);
  expect(viewport.contentRight - bubble.x - bubble.width).toBeCloseTo(16, 0);
  const learnerBubble = assistant.getByText('Learner question', { exact: true }).locator('..');
  await expect(learnerBubble).toHaveCSS('background-color', 'rgb(11, 122, 82)');
  await expect(learnerBubble).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(learnerBubble).toHaveCSS('padding', '8px 12px');
  const learner = (await learnerBubble.boundingBox())!;
  expect(viewport.contentRight - learner.x - learner.width).toBeCloseTo(16, 0);
  expect(control.y + control.height).toBeLessThanOrEqual(viewport.y + viewport.height);
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
    if (docked) await page.getByTestId('pbl-workspace-size').click();
    await page.locator('[data-pbl-tour="replay"]').click();
    const selectors = [
      '[data-pbl-tour="task"]',
      '[data-pbl-tour="conversation"]',
      '[data-testid="pbl-ide"]',
      '[data-testid="pbl-application-panel"], [data-testid="pbl-application-open"]',
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
    const spotlight = page.locator('[data-pbl-onboarding="spotlight"]').first();
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

test('focusing the composer before typing defers automatic entry through recovery', async ({
  page,
  learningEvents,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await project(page, learningEvents, {
      started: true,
      guideCompleted: false,
      environmentReady: false,
      prepareGate: gate,
    });
    const composer = page.locator('[data-pbl-tour="composer"] textarea');
    await composer.click();
    await expect(composer).toBeFocused();
    release();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await page.keyboard.type('Words with spaces after focus');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Words with spaces after focus');
    await expect(tour(page)).toHaveCount(0);
    await page.locator('[data-pbl-tour="replay"]').click();
    await expect(tour(page)).toBeVisible();
  } finally {
    release();
  }
});

test('hides Latest during the guide and restores the working control after dismissal', async ({
  page,
  learningEvents,
}) => {
  await project(page, learningEvents, { openingText: 'A long welcome.\n\n'.repeat(80) });
  await expect(tour(page)).toBeVisible();
  const viewport = page.locator('.pbl-conversation-scroll');
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  const readingBox = (await viewport.boundingBox())!;
  await page.mouse.move(readingBox.x + readingBox.width / 2, readingBox.y + readingBox.height / 2);
  await page.mouse.wheel(0, -180);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(8);
  const latest = page.getByTestId('pbl-conversation-scroll-button');
  await expect(latest).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('#pbl-project-overview details')).not.toHaveAttribute('open');
  await expect(latest).toBeVisible();
  const height = await viewport.evaluate((el) => el.clientHeight);
  await latest.click();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(8);
  expect(await viewport.evaluate((el) => el.clientHeight)).toBe(height);
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
    expect(card.y + card.height).toBeLessThanOrEqual(viewport.y);
    await page.screenshot({ path: testInfo.outputPath('assistant-visible.png') });
  });
}

for (const [width, height] of [
  [1365, 900],
  [390, 844],
] as const) {
  test(`Latest keeps following the same growing reply without resizing its viewport at ${width}x${height}`, async ({
    page,
    learningEvents,
  }) => {
    await page.setViewportSize({ width, height });
    const fixture = await project(page, learningEvents, { started: true });
    // Replay becomes enabled only after Hero expansion and its current snapshot settle.
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    const reply = {
      id: 'growing',
      speaker: 'discussion' as const,
      status: 'running' as 'running' | 'succeeded',
      parts: [
        {
          kind: 'text' as const,
          id: 'body',
          text: 'Streaming paragraph.\n\n'.repeat(50),
          streaming: true,
        },
      ],
    };
    fixture.view.conversation = [reply];
    fixture.view.busy = true;
    fixture.view.revision++;
    await fixture.publish();
    const viewport = page.locator('.pbl-conversation-scroll');
    const latest = page.getByTestId('pbl-conversation-scroll-button');
    const before = await viewport.evaluate((el) => el.clientHeight);
    // A fresh study opens at its overview; Latest explicitly opts into following.
    await latest.click();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(1);
    await expect(latest).toHaveCount(0);
    expect(await viewport.evaluate((el) => el.clientHeight)).toBe(before);
    for (let chunk = 0; chunk < 3; chunk++) {
      reply.parts[0].text += `New chunk ${chunk}.\n\n`.repeat(12);
      fixture.view.revision++;
      await fixture.publish();
      await expect(viewport).toContainText(`New chunk ${chunk}.`);
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(8);
    }
    // The shared Pro viewport anchor also follows changes outside the transcript.
    await page.setViewportSize({ width, height: height - 80 });
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    await page.setViewportSize({ width, height });
    // Deliberate upward reading still escapes follow mode.
    const following = await viewport.evaluate((el) => el.scrollTop);
    await viewport.hover();
    await page.mouse.wheel(0, -180);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeCloseTo(following - 180, 0);
    await expect(latest).toBeVisible();
    const reading = await viewport.evaluate((el) => el.scrollTop);
    reply.parts[0].text += 'More text while reading earlier content.\n\n'.repeat(12);
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('More text while reading earlier content.');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(reading, 0);
    await latest.click();
    const question = 'Are you ready to begin?';
    reply.parts[0].text += '\n\n' + question;
    reply.parts[0].streaming = false;
    reply.status = 'succeeded';
    fixture.view.busy = false;
    fixture.view.revision++;
    await fixture.publish();
    await expect(
      page.getByTestId('pbl-assistant').getByText(question, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    const text = (await page
      .getByTestId('pbl-assistant')
      .getByText(question, { exact: true })
      .boundingBox())!;
    const box = (await viewport.boundingBox())!;
    expect(text.y + text.height).toBeLessThanOrEqual(box.y + box.height + 1);
  });
}

for (const [width, height, gesture] of [
  [320, 480, 'touch'],
  [320, 480, 'wheel'],
  [320, 568, 'touch'],
  [390, 844, 'wheel'],
] as const) {
  test(`the guide allows reading a growing multi-paragraph welcome and its closing question at ${width}x${height} with ${gesture}`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height });
    const intro =
      'Welcome to your project. We will discuss your choices and build the result together.\n\n'.repeat(
        8,
      );
    const questions = [
      'What would you like to build?',
      'Do you have any questions before we start?',
    ];
    const fixture = await project(page, learningEvents, { openingText: intro + questions[0] });
    await expect(tour(page)).toBeVisible();
    await next(page).click();
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    const viewport = page.locator('.pbl-conversation-scroll');
    if (width === 320) {
      // The guide's own explanation needs visible space, as well as the welcome.
      await expect
        .poll(() =>
          tour(page).evaluate((element) => {
            const description = element.querySelector('p')!;
            const body = description.parentElement!.getBoundingClientRect();
            const copy = description.getBoundingClientRect();
            const visible = Math.max(
              0,
              Math.min(body.bottom, copy.bottom) - Math.max(body.top, copy.top),
            );
            return visible >= 2 * parseFloat(getComputedStyle(description).lineHeight);
          }),
        )
        .toBe(true);
    }
    for (let revision = 0; revision < 2; revision++) {
      if (revision) {
        fixture.view.messages[0].text = intro + intro + questions[revision];
        fixture.view.revision++;
        await fixture.publish();
      }
      const box = (await viewport.boundingBox())!;
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      if (gesture === 'wheel') {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, 6000);
      } else {
        await page.locator('[data-pbl-onboarding="overlay"]').evaluate(
          (element, { x, y }) => {
            for (let i = 0; i < 30; i++) {
              const point = (clientY: number) =>
                new Touch({ identifier: 1, target: element, clientX: x, clientY });
              element.dispatchEvent(
                new TouchEvent('touchstart', {
                  bubbles: true,
                  cancelable: true,
                  touches: [point(y + 30)],
                  targetTouches: [point(y + 30)],
                  changedTouches: [point(y + 30)],
                }),
              );
              element.dispatchEvent(
                new TouchEvent('touchmove', {
                  bubbles: true,
                  cancelable: true,
                  touches: [point(y - 30)],
                  targetTouches: [point(y - 30)],
                  changedTouches: [point(y - 30)],
                }),
              );
              element.dispatchEvent(
                new TouchEvent('touchend', {
                  bubbles: true,
                  cancelable: true,
                  touches: [],
                  targetTouches: [],
                  changedTouches: [point(y - 30)],
                }),
              );
            }
          },
          { x, y },
        );
      }
      await expect
        .poll(async () => {
          const question = await page
            .getByTestId('pbl-assistant')
            .getByText(questions[revision], { exact: true })
            .boundingBox();
          const reading = await viewport.boundingBox();
          const card = await tour(page).boundingBox();
          return (
            !!question &&
            !!reading &&
            !!card &&
            question.y >= reading.y &&
            question.y + question.height <= reading.y + reading.height + 1 &&
            card.y + card.height <= reading.y
          );
        })
        .toBe(true);
      await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    }
    if (height === 480) {
      // A smaller card must still let the learner read its full instructions.
      const instructions = tour(page).locator(':scope > div');
      expect(await instructions.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
        await instructions.evaluate((element) => element.clientHeight),
      );
      await instructions.hover();
      await page.mouse.wheel(0, 6000);
      await expect
        .poll(() =>
          instructions.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    // Reading gestures must not release modal focus or submit learning commands.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    expect(await tour(page).evaluate((element) => element.contains(document.activeElement))).toBe(
      true,
    );
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    expect(fixture.commands).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('closing-question-readable.png') });
    await page.keyboard.press('Escape');
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByTestId('pbl-v3-workspace')).toBeFocused();
  });
}

test('opens the preview by default and highlights its panel and toggle together', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await project(page, learningEvents);
  await expect(tour(page)).toHaveAttribute('data-step', 'progress');
  await expect(page.getByTestId('pbl-application-open')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => fixture.applicationCalls).toEqual(['open']);
  const controls = await page.getByTestId('pbl-workspace-size').evaluate((button) => {
    const theme = button.previousElementSibling!.getBoundingClientRect(),
      size = button.getBoundingClientRect();
    return { topDifference: Math.abs(theme.top - size.top), gap: size.left - theme.right };
  });
  expect(controls.topDifference).toBeLessThan(1);
  expect(controls.gap).toBeGreaterThanOrEqual(6);

  for (let i = 0; i < 3; i++) await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'application');
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toHaveCount(2);
  const boxes = await page.locator('[data-pbl-onboarding="spotlight"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }),
  );
  for (const target of [
    page.getByTestId('pbl-application-panel'),
    page.getByTestId('pbl-application-open'),
  ]) {
    const r = (await target.boundingBox())!;
    expect(
      boxes.some(
        (box) =>
          box.x <= r.x + 1 &&
          box.y <= r.y + 1 &&
          box.right >= r.x + r.width - 1 &&
          box.bottom >= r.y + r.height - 1,
      ),
    ).toBe(true);
  }
  await finish(page);
  await page.getByTestId('pbl-application-open').click();
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.getByTestId('pbl-application-open')).toHaveAttribute('aria-expanded', 'false');
  expect(fixture.applicationCalls).toEqual(['open']);
});

test('live and historical turns share regular spacing and body-size handoffs in both themes', async ({
  page,
  learningEvents,
}, testInfo) => {
  const fixture = await project(page, learningEvents, {
    started: true,
    guideCompleted: true,
    application: false,
  });
  const entries: NonNullable<LearningView['conversation']> = [
    {
      id: 'presentation-turn',
      speaker: 'coder',
      status: 'succeeded',
      parts: [
        { id: 'thinking-a', kind: 'thinking', text: 'Inspect the project.', streaming: false },
        { id: 'empty-prose', kind: 'text', text: '  \n' },
        {
          id: 'tool-a',
          kind: 'tool',
          action: 'read',
          status: 'succeeded',
          args: { path: 'PLAN.md' },
          result: 'Saved plan.',
        },
        {
          id: 'prose',
          kind: 'text',
          text: '## Project outline\n\nA regular body paragraph.\n\n### Review\n\n**Confirm the current plan.**',
        },
        { id: 'thinking-b', kind: 'thinking', text: 'Record the result.', streaming: false },
        { id: 'complete-a', kind: 'tool', action: 'complete', status: 'succeeded' },
      ],
    },
  ];
  fixture.view.conversation = entries;
  fixture.view.conversationHistory = [
    { sessionId: 'historical-coder', through: 10, role: 'coder' },
  ];
  await page.route('**/api/pbl/v3/history?**', (route) =>
    route.fulfill({ json: { through: 10, nextBefore: null, conversation: entries } }),
  );
  fixture.view.revision++;
  await fixture.publish();
  const measure = async (scope: ReturnType<Page['locator']>) =>
    scope.locator('.pbl-assistant-bubble').evaluate((bubble) => {
      const children = Array.from(bubble.children),
        rects = children.map((node) => node.getBoundingClientRect());
      const body = bubble.querySelector('.wb-prose p')!,
        bold = bubble.querySelector('p[data-pbl-lead="true"]')!;
      return {
        gaps: rects.slice(1).map((r, i) => r.top - rects[i].bottom),
        body: getComputedStyle(body).fontSize,
        bold: getComputedStyle(bold).fontSize,
        handoff: getComputedStyle(bubble.querySelector('[data-testid="pbl-completion-handoff"]')!)
          .fontSize,
        heading: getComputedStyle(bubble.querySelector('h2')!).fontSize,
        subtitle: getComputedStyle(bubble.querySelector('h3')!).fontSize,
        tool: getComputedStyle(bubble.querySelector('[data-testid="workbench-tool-card"] button')!)
          .fontSize,
        background: getComputedStyle(bubble).backgroundColor,
      };
    });
  for (const dark of [false, true]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark);
    const live = await measure(page.getByTestId('pbl-v3-frame'));
    expect(live.body).toBe('14px');
    expect(live.bold).toBe(live.body);
    expect(live.handoff).toBe(live.body);
    expect(live.heading).toBe('20px');
    expect(live.subtitle).toBe('16px');
    expect(live.tool).toBe('13px');
    expect(live.gaps.map(Math.round)).toEqual([5, 12, 12, 5]);
    await page.getByRole('button', { name: 'Conversation history', exact: true }).click();
    await expect(page.locator('.pbl-history [data-testid="pbl-agent-turn"]')).toBeVisible();
    await expect
      .poll(async () => (await measure(page.locator('.pbl-history'))).gaps[0])
      .toBeCloseTo(5, 1);
    const history = await measure(page.locator('.pbl-history'));
    expect({ ...history, gaps: [] }).toEqual({ ...live, gaps: [] });
    expect(history.gaps.map(Math.round)).toEqual([5, 12, 12, 5]);
    await page.screenshot({
      path: testInfo.outputPath(dark ? 'history-dark.png' : 'history-light.png'),
    });
    await page.keyboard.press('Escape');
  }
});

const readingParagraphs = () =>
  Array.from(
    { length: 100 },
    (_, index) =>
      `Reading passage ${index + 1}. This distinct paragraph wraps as the conversation pane changes width. Keep this passage visible while reading earlier output.`,
  ).join('\n\n');

async function readPassage(page: Page, number: number) {
  const viewport = page.locator('.pbl-conversation-scroll');
  const paragraph = viewport.locator('p').filter({ hasText: `Reading passage ${number}.` });
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(100);
  await paragraph.evaluate((element) =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  const offset = () =>
    paragraph.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest('.pbl-conversation-scroll')!.getBoundingClientRect().top,
    );
  await expect.poll(async () => Math.abs(await offset())).toBeLessThanOrEqual(2);
  return { viewport, paragraph, offset };
}

test('paused reading keeps the same passage through divider reflow and a delayed image', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  let loadImage!: () => void;
  const imageGate = new Promise<void>((resolve) => (loadImage = resolve));
  await page.route('https://pbl-reading.test/delayed.svg', async (route) => {
    await imageGate;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="lightblue"/></svg>',
    });
  });
  await project(page, learningEvents, {
    started: true,
    openingText:
      '![Delayed illustration](https://pbl-reading.test/delayed.svg)\n\n' + readingParagraphs(),
  });
  const { viewport, offset } = await readPassage(page, 60);
  const readingOffset = await offset();
  const beforeWidth = await viewport.evaluate((element) => element.clientWidth);
  const divider = page.getByRole('separator', { name: 'Resize workspace and assistant' }).last();
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect
    .poll(() => viewport.evaluate((element) => element.clientWidth))
    .toBeLessThan(beforeWidth - 70);
  await expect.poll(async () => Math.abs((await offset()) - readingOffset)).toBeLessThanOrEqual(2);
  loadImage();
  await expect
    .poll(() => viewport.locator('img').evaluate((image) => image.naturalHeight))
    .toBe(300);
  await expect.poll(async () => Math.abs((await offset()) - readingOffset)).toBeLessThanOrEqual(2);
});

test('a failure notice preserves paused reading after a small upward scroll and more output', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, {
    started: true,
    openingText: readingParagraphs(),
  });
  const viewport = page.locator('.pbl-conversation-scroll');
  const distance = () =>
    viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(distance).toBeLessThanOrEqual(1);
  await viewport.hover();
  await page.mouse.wheel(0, -50);
  await expect.poll(distance).toBeGreaterThan(40);
  await expect.poll(distance).toBeLessThan(80);
  const reading = await viewport.evaluate((element) => element.scrollTop);
  fixture.view.messages[0].text +=
    '\n\n' + 'Additional output below the selected passage.\n\n'.repeat(20);
  fixture.view.activitySequence!++;
  await fixture.publish();
  await expect(viewport).toContainText('Additional output below the selected passage.');
  await expect.poll(distance).toBeGreaterThan(300);
  const height = await viewport.evaluate((element) => element.clientHeight);
  fixture.view.roleRun = { status: 'failed', failure: 'timeout', canRetry: true };
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.getByTestId('pbl-assistant').getByRole('alert')).toBeVisible();
  await expect
    .poll(() => viewport.evaluate((element) => element.clientHeight))
    .toBeLessThan(height);
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(reading, 0);
});

test.describe('native mobile touch reading', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('mobile touch reading survives task details and resumes after returning to the tail', async ({
    page,
    learningEvents,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await project(page, learningEvents, {
      started: true,
      openingText: readingParagraphs(),
    });
    fixture.view.stage = {
      kind: 'dialogue',
      agent: 'discussion',
      studentActions: ['chat', 'decide'],
    } as LearningView['stage'];
    fixture.view.state.position.stageIndex = 1;
    fixture.view.decisions = [
      {
        id: 'choice',
        prompt: 'Choose a direction',
        options: [{ id: 'a', label: 'First direction' }],
      },
    ];
    fixture.view.revision++;
    await fixture.publish();
    const viewport = page.locator('.pbl-conversation-scroll');
    const distance = () =>
      viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(distance).toBeLessThanOrEqual(1);
    await viewport.scrollIntoViewIfNeeded();
    const box = (await viewport.boundingBox())!;
    const touch = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2,
      y = box.y + 10;
    // Keep the finger inside the short mobile conversation viewport. Dispatch
    // native touch events: Chromium's synthesized scroll gesture is a no-op on
    // the Linux CI runner even with a touch-enabled browser context.
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 10; step++) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + ((box.height - 20) * step) / 10 }],
      });
      await page.waitForTimeout(20);
    }
    // Lift after a stationary hold so inertial scrolling cannot race the
    // reading-position assertion that follows.
    await page.waitForTimeout(150);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(distance).toBeGreaterThan(80);
    const reading = await viewport.evaluate((element) => element.scrollTop);
    fixture.view.messages[0].text += '\n\n' + 'More output after a touch gesture.\n\n'.repeat(15);
    fixture.view.activitySequence!++;
    await fixture.publish();
    await expect(viewport).toContainText('More output after a touch gesture.');
    await page.locator('[data-pbl-tour="task-trigger"]').click();
    await expect(page.getByRole('region', { name: 'Current task details' })).toBeVisible();
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeCloseTo(reading, 0);
    await page.getByRole('button', { name: 'Close task details' }).click();
    await viewport.hover();
    await page.mouse.wheel(0, 100000);
    await expect.poll(distance).toBeLessThanOrEqual(1);
    fixture.view.messages[0].text += '\n\nFollowing again after manual return.';
    fixture.view.activitySequence!++;
    await fixture.publish();
    await expect(viewport).toContainText('Following again after manual return.');
    await expect.poll(distance).toBeLessThanOrEqual(8);
    await touch.detach();
  });
});

for (const checker of ['tests', 'quiz'] as const) {
  test(`keeps following the conversation when entering the ${checker} check without a composer`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents, {
      started: true,
      application: false,
      openingText: readingParagraphs(),
    });
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    const viewport = page.locator('.pbl-conversation-scroll');
    const composer = page.locator('[data-pbl-tour="composer"]');
    const distance = () =>
      viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect(composer).toBeVisible();
    await expect.poll(distance).toBeLessThanOrEqual(1);
    const height = await viewport.evaluate((el) => el.clientHeight);

    fixture.view.stage = { kind: 'check', checker } as LearningView['stage'];
    fixture.view.state.position.stageIndex = checker === 'tests' ? 4 : 5;
    fixture.view.actions = checker === 'tests' ? ['evaluate'] : ['quiz'];
    if (checker === 'quiz')
      fixture.view.questions = [{ q: 'What did you build?', options: ['A list', 'A timer'] }];
    fixture.view.revision++;
    await fixture.publish();
    await expect(composer).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Current task', exact: true })).toBeVisible();
    await expect.poll(() => viewport.evaluate((el) => el.clientHeight)).toBeGreaterThan(height);
    await expect.poll(distance).toBeLessThanOrEqual(1);

    const reply = {
      id: 'check-reply',
      speaker: 'mentor' as const,
      status: 'running' as const,
      parts: [{ kind: 'text' as const, id: 'body', text: '', streaming: true }],
    };
    fixture.view.conversation = [
      {
        id: '0',
        speaker: 'discussion',
        status: 'succeeded',
        parts: [{ kind: 'text', id: '0', text: fixture.view.messages[0].text }],
      },
      reply,
    ];
    fixture.view.busy = true;
    const append = async (paragraph: string) => {
      reply.parts[0].text += `\n\n${paragraph}\n\n` + 'The check is progressing.\n\n'.repeat(8);
      fixture.view.revision++;
      await fixture.publish();
      await expect(viewport).toContainText(paragraph);
    };
    await append('Check output starts.');
    await expect.poll(distance).toBeLessThanOrEqual(1);
    await append('Check output continues.');
    await expect.poll(distance).toBeLessThanOrEqual(1);

    const following = await viewport.evaluate((el) => el.scrollTop);
    await viewport.hover();
    await page.mouse.wheel(0, -180);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeCloseTo(following - 180, 0);
    const latest = page.getByTestId('pbl-conversation-scroll-button');
    await expect(latest).toBeVisible();
    const reading = await viewport.evaluate((el) => el.scrollTop);
    await append('More output while reading.');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(reading, 0);

    await page.mouse.wheel(0, (await distance()) - 40);
    await expect.poll(distance).toBeCloseTo(40, 0);
    await expect(latest).toHaveCount(0);
    await append('More output after returning near the bottom.');
    await expect.poll(distance).toBeLessThanOrEqual(1);
  });
}

test('independent columns, narrow assistant and a single scrolling tab row', async ({
  page,
  learningEvents,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 850 });
  const f = await project(page, learningEvents, { started: true, locale: 'zh-CN' });
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
  const names = [
    'PLAN.md',
    'DialogueService.java',
    'CourseChoices.java',
    'ChatEndpoint.java',
    'Json.java',
    'Application.java',
  ];
  f.view.files = names;
  f.view.revision++;
  await f.publish();
  const ide = page.getByTestId('pbl-ide');
  await expect(ide.locator('.monaco-editor')).toBeVisible();
  const tabs = ide.getByRole('tablist');
  for (const name of names.slice(1)) await ide.getByRole('button', { name, exact: true }).click();
  await expect(tabs.getByRole('tab', { name: 'Application.java', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const measure = async () => ({
    ide: (await ide.boundingBox())!,
    files: (await ide.getByRole('navigation', { name: '项目文件', exact: true }).boundingBox())!,
    app: (await page.getByTestId('pbl-application-panel').boundingBox())!,
    assistant: (await page.getByTestId('pbl-assistant').boundingBox())!,
  });
  const drag = async (separator: ReturnType<Page['getByRole']>, delta: number) => {
    const b = (await separator.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(120, b.height / 2));
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + delta, b.y + Math.min(120, b.height / 2), {
      steps: 14,
    });
    await page.mouse.up();
  };
  // Hero expansion and platform metrics can leave the tree near its 45% max.
  // Start away from that constraint so shrinking the IDE tests pixel preservation.
  const initial = await measure();
  await drag(
    page.getByRole('separator', { name: '调整文件目录宽度', exact: true }),
    initial.ide.width * 0.24 - initial.files.width,
  );
  await expect
    .poll(async () => {
      const layout = await measure();
      return layout.files.width / layout.ide.width;
    })
    .toBeCloseTo(0.24, 1);
  const before = await measure();
  await page.screenshot({ path: testInfo.outputPath('initial.png') });
  const dividers = page.getByRole('separator', { name: '调整工作区与助手宽度', exact: true });
  await drag(dividers.last(), 100);
  const outer = await measure();
  await page.screenshot({ path: testInfo.outputPath('outer-drag.png') });
  // The tree must still fit below its max after the planned 60px IDE shrink.
  expect(outer.files.width).toBeLessThan((outer.ide.width - 60) * 0.45 - 2);
  await drag(dividers.first(), -60);
  const inner = await measure();
  await page.screenshot({ path: testInfo.outputPath('inner-drag.png') });
  await ide.screenshot({ path: testInfo.outputPath('tabs.png') });
  const tabRows = await tabs
    .getByRole('tab')
    .evaluateAll(
      (elements) => new Set(elements.map((e) => Math.round(e.getBoundingClientRect().y))).size,
    );
  const tabOverflow = await tabs.evaluate((e) => ({ scroll: e.scrollWidth, width: e.clientWidth }));
  {
    expect(Math.abs(outer.ide.width - before.ide.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(outer.files.width - before.files.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(inner.assistant.width - outer.assistant.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(inner.files.width - outer.files.width)).toBeLessThanOrEqual(2);
    expect(tabRows).toBe(1);
    expect(tabOverflow.scroll).toBeGreaterThan(tabOverflow.width);
    await tabs.evaluate((e) => (e.scrollLeft = 0));
    await tabs.getByRole('tab', { name: 'PLAN.md', exact: true }).click();
    await ide.getByRole('button', { name: 'Application.java', exact: true }).click();
    await expect.poll(() => tabs.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  }
  const width = await page.getByTestId('pbl-workbench-split').evaluate((e) => e.clientWidth);
  await drag(dividers.last(), inner.assistant.width - width * 0.22);
  const narrow = await measure();
  await page.screenshot({ path: testInfo.outputPath('narrow.png') });
  expect(narrow.assistant.width).toBeGreaterThan(200);
  expect(narrow.assistant.width / width).toBeLessThan(0.23);
});
