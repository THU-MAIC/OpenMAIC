import { test, expect } from '@playwright/test';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import type { LearningView } from '@/lib/pbl/v3/types';

test('PBL conversation stays in the host classroom through expansion, scene navigation and refresh', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('locale', 'en-US');
      localStorage.setItem('maic:account:settings-storage', settings);
    },
    createSettingsStorage({ sidebarCollapsed: false }),
  );
  const stageId = uniqueStageId('pbl-ui');
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Programming course',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    scenes: [
      {
        id: 'overview',
        stageId,
        type: 'slide',
        title: 'Course overview',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'overview-slide',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            elements: [
              {
                type: 'text',
                id: 'intro-text',
                content: 'Course overview',
                left: 50,
                top: 50,
                width: 900,
                height: 100,
              },
            ],
          },
        },
      },
      {
        id: 'project',
        stageId,
        type: 'pbl',
        title: 'Practice project',
        order: 1,
        content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.0.0' } },
        actions: [],
      },
    ],
    outline: {
      outlines: [],
      generationComplete: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
  const view = {
    id: 'ui-study',
    revision: 8,
    activitySequence: 10,
    title: 'Greeting project',
    task: { title: 'Implement a greeting', goal: 'Connect input to output' },
    environmentId: 'fixture-environment',
    environment: { state: 'running', ready: true },
    recovery: null,
    state: {
      status: 'running',
      introCompleted: true,
      position: { milestoneIndex: 0, milestoneId: 'greeting', stageIndex: 0 },
      milestones: [{ milestoneId: 'greeting', status: 'active' }],
      collected: { greeting: { decisions: [] } },
      decisionRevisions: {},
      lastSequence: 1,
    },
    stage: {
      kind: 'mentor_say',
      agent: 'discussion',
      say: 'Explain',
      studentActions: ['chat', 'next'],
    },
    milestones: [
      {
        id: 'greeting',
        title: 'Implement a greeting',
        optional: false,
        stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
      },
      {
        id: 'normalize',
        title: 'Extend the greeting',
        optional: false,
        stages: ['teaching', 'plan', 'code', 'tests', 'quiz', 'recap'],
      },
    ],
    role: 'discussion',
    actions: ['chat'],
    files: ['PLAN.md'],
    busy: false,
    messages: [],
    roleRun: null,
    decisions: [],
    questions: [],
    evaluation: null,
    conversation: [
      {
        id: 'u1',
        speaker: 'user',
        parts: [{ kind: 'text', id: '1', text: 'I do not understand return.' }],
      },
      {
        id: 'a1',
        speaker: 'discussion',
        parts: [
          { kind: 'text', id: '2', text: 'Return sends a value to the caller.' },
          { kind: 'tool', id: '3', action: 'review', status: 'succeeded' },
          { kind: 'text', id: '4', text: 'Where does the value go?' },
        ],
      },
    ],
  } as unknown as LearningView;
  let openings = 0;
  let failOpening = true;
  let advances = 0;
  let collections = 0;
  let failCollection = true;
  let testRun = 0;
  await page.route('**/api/pbl/v3**', async (route) => {
    const command =
      route.request().method() === 'POST' ? route.request().postDataJSON()?.command : undefined;
    if (command?.type === 'chat') {
      // The server preserves a completed review while answering a follow-up.
      view.activitySequence!++;
      return route.fulfill({ json: { view } });
    }
    if (command?.type === 'evaluate') {
      testRun++;
      view.evaluation = {
        id: `test-run-${testRun}`,
        state: 'running',
        stdout: 'PRIVATE DRIVER OUTPUT',
        stderr: 'PRIVATE STDERR',
      };
      view.actions = ['chat', 'evaluate'];
      view.revision++;
      return route.fulfill({ json: { view } });
    }
    if (command?.type === 'collect') {
      collections++;
      expect(command.evaluationId).toBe(view.evaluation?.id);
      if (failCollection) {
        failCollection = false;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SANDBOX_UNAVAILABLE', message: 'private error' } },
        });
      }
      const passed = testRun > 1;
      view.state.collected.greeting!.tests = {
        id: view.evaluation!.id,
        status: passed ? 'passed' : 'failed',
        publicDiagnostics: {
          kind: 'assertion',
          summary: 'Safe assessment feedback',
          reportGenerated: true,
          caseResults: [
            { id: 'append', label: 'Add one task', passed },
            { id: 'order', label: 'Keep the original order', passed: true },
          ],
        },
      } as NonNullable<LearningView['state']['collected'][string]['tests']>;
      view.evaluation = null;
      view.actions = passed ? ['chat', 'evaluate', 'next'] : ['chat', 'evaluate'];
      view.revision++;
      return route.fulfill({ json: { view } });
    }
    if (command?.type === 'next' && view.stage.kind === 'check' && view.stage.checker === 'tests') {
      expect(view.actions).toContain('next');
      view.stage = {
        kind: 'check',
        checker: 'quiz',
        studentActions: ['chat', 'quiz', 'next'],
      } as LearningView['stage'];
      view.state.position.stageIndex = 5;
      view.actions = ['chat', 'quiz'];
      view.questions = [
        { q: 'What does return do?', options: ['Gives a value back', 'Prints text'] },
      ];
      view.revision++;
      return route.fulfill({ json: { view } });
    }
    if (command?.type === 'next') {
      expect(view.actions).toContain('next');
      advances++;
      view.stage = {
        kind: 'dialogue',
        agent: 'discussion',
        studentActions: ['chat', 'decide', 'next'],
      } as LearningView['stage'];
      view.state.position.stageIndex = 1;
      view.actions = ['chat', 'decide'];
      view.decisions = [
        {
          id: 'storage',
          prompt: 'Where will tasks live?',
          options: [{ id: 'list', label: 'A Python list' }],
        },
      ];
      view.needsOpening = true;
      view.revision++;
      return route.fulfill({ json: { view } });
    }
    if (
      route.request().method() === 'POST' &&
      route.request().postDataJSON()?.command?.type === 'begin'
    ) {
      openings++;
      if (failOpening) {
        failOpening = false;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SANDBOX_UNAVAILABLE', message: 'Private provider diagnostic' } },
        });
      }
      view.needsOpening = false;
      return route.fulfill({ json: { view } });
    }
    if (new URL(route.request().url()).searchParams.has('file'))
      return route.fulfill({
        json: {
          text: '## Greeting plan\nConnect input to a returned greeting.',
          hash: 'a'.repeat(64),
        },
      });
    // Also supports local combination with the companion workbench PR.
    if (new URL(route.request().url()).pathname.endsWith('/workspace'))
      return route.fulfill({
        json: {
          environmentId: view.environmentId,
          revision: view.revision,
          epoch: 0,
          canEdit: false,
          canManageFiles: false,
          canRun: false,
          planning: false,
          ports: [],
          commands: [],
          terminals: [],
          checkpoint: null,
        },
      });
    if (new URL(route.request().url()).pathname.endsWith('/report'))
      return route.fulfill({
        json: {
          studyId: view.id,
          project: { id: 'greeting', version: '1', title: view.title },
          revision: 8,
          requiredComplete: false,
          milestones: [],
          evidence: [],
          counts: {},
          conversations: [],
          truncated: false,
        },
      });
    return route.fulfill({ json: view });
  });
  await page.goto(`/classroom/${stageId}`);
  await page.getByTestId('scene-title').filter({ hasText: 'Practice project' }).click();
  await expect(page.getByTestId('pbl-v3-workspace')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Current learning step' })
      .getByText('Learn before deciding', { exact: true }),
  ).toBeVisible();
  const task = page.getByRole('region', { name: 'Current learning step', exact: true });
  const details = page.getByRole('region', { name: 'Current task details', exact: true });
  await expect(task.getByText('1/7', { exact: true })).toBeVisible();
  view.needsOpening = true;
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect.poll(() => openings).toBe(1);
  const openingRetry = page.getByRole('button', { name: 'Retry step opening', exact: true });
  await expect(openingRetry).toBeVisible();
  await page.getByLabel('Your message', { exact: true }).fill('My unsent answer');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  expect(openings).toBe(1);
  await openingRetry.click();
  await expect.poll(() => openings).toBe(2);
  await expect(openingRetry).toHaveCount(0);
  await expect(page.getByLabel('Your message', { exact: true })).toHaveValue('My unsent answer');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByLabel('Your message', { exact: true }).fill('');
  // Teaching has no drawer; decisions expose only the actual current task.
  await expect(task.getByRole('button', { name: /Current task details/ })).toHaveCount(0);
  await expect(details).toHaveCount(0);
  const originalStage = view.stage;
  const enterDecisions = task.getByRole('button', {
    name: 'Continue to Make your decisions',
    exact: true,
  });
  await expect(enterDecisions).toHaveCount(0);
  view.actions = ['chat', 'next'];
  view
    .conversation!.at(-1)!
    .parts.push({ kind: 'tool', id: 'completion', action: 'complete', status: 'succeeded' });
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(enterDecisions).toBeVisible();
  await expect(
    page.getByText(
      'This step is complete. Use the Continue button on the task bar above the message box to move on.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(enterDecisions).toHaveAttribute('data-state', 'ready');
  const readyColor = () => enterDecisions.evaluate((el) => getComputedStyle(el).backgroundColor);
  const greens = ['rgb(11, 122, 82)', 'rgb(59, 240, 164)'];
  expect(greens).toContain(await readyColor());
  const initialColor = await readyColor();
  await page.getByRole('button', { name: 'Switch color theme', exact: true }).click();
  await expect.poll(readyColor).toBe(greens.find((color) => color !== initialColor));
  await page.getByRole('button', { name: 'Switch color theme', exact: true }).click();
  await expect.poll(readyColor).toBe(initialColor);
  await page.getByLabel('Your message', { exact: true }).fill('What should I do next?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(enterDecisions).toBeVisible();
  await enterDecisions.click();
  await expect.poll(() => advances).toBe(1);
  await expect.poll(() => openings).toBe(3);
  await expect(task.getByText('2/7', { exact: true })).toBeVisible();
  await expect(enterDecisions).toHaveCount(0);
  const composerBefore = await page.getByLabel('Your message', { exact: true }).boundingBox();
  await task.getByRole('button', { name: /Current task details/ }).click();
  await expect(details.getByText('Where will tasks live?')).toBeVisible();
  await expect(details.getByRole('listitem')).toHaveCount(0);
  expect((await page.getByLabel('Your message', { exact: true }).boundingBox())?.y).toBe(
    composerBefore?.y,
  );
  await details.getByRole('button', { name: 'Close task details' }).press('Escape');
  await expect(details).toHaveCount(0);
  await expect(task.getByRole('button', { name: /Current task details/ })).toBeFocused();
  // Production uses OpenPBL's current-task header and contextual sections, not repeated goals.
  const originalTask = view.task;
  view.stage = {
    kind: 'produce',
    agent: 'planner',
    writes: 'plan',
    reviewRequired: true,
    studentActions: ['chat', 'edit', 'next'],
  } as LearningView['stage'];
  view.role = 'planner';
  view.state.position.stageIndex = 2;
  view.task = { title: 'Add the first task', goal: 'Add the first task' };
  view.decisions = [];
  view.decisionSummary = [{ id: 'storage', prompt: 'Task storage', choice: 'A Python list' }];
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await task.getByRole('button', { name: /Current task details/ }).click();
  await expect(details.getByRole('heading', { name: 'Current task', exact: true })).toBeVisible();
  await expect(details.getByText('Add the first task', { exact: true })).toHaveCount(0);
  await expect(
    details.getByRole('heading', { name: 'Confirmed decisions', exact: true }),
  ).toBeVisible();
  await expect(details.getByText('A Python list', { exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Plan output', exact: true })).toBeVisible();
  await expect(
    details.getByText('Plan review and approval · Awaiting review', { exact: true }),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Close task details' }).click({ timeout: 7000 });
  await expect(details).toHaveCount(0);
  view.stage = originalStage;
  view.role = 'discussion';
  view.task = originalTask;
  view.decisionSummary = [];
  view.actions = ['chat'];
  view.decisions = [];
  view.state.introCompleted = true;
  view.state.position = { milestoneIndex: 1, milestoneId: 'normalize', stageIndex: 2 };
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(task.getByText('3/6', { exact: true })).toBeVisible();
  view.state.position = { milestoneIndex: 0, milestoneId: 'greeting', stageIndex: 0 };
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(task.getByText('1/7', { exact: true })).toBeVisible();
  const conversation = page.getByRole('log', { name: 'Learning conversation' });
  await expect(conversation.getByText('Discussion', { exact: true })).toBeVisible();
  // Real component behavior: pre-token wait, thinking, ordered tool group, then prose.
  const finished = view.conversation![1]!;
  finished.status = 'running';
  const originalParts = finished.parts;
  finished.parts = [];
  view.busy = true;
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByTestId('workbench-waiting-bar')).toHaveCount(1);
  await expect(conversation.getByTestId('workbench-thinking-bar')).toHaveCount(0);
  finished.parts = [
    {
      kind: 'thinking',
      id: 'thought',
      text: 'Consider the input.\nTrace the returned value.',
      streaming: true,
      startedAt: 1000,
    },
  ];
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  const thinking = conversation.getByTestId('workbench-thinking-bar');
  await expect(conversation.getByTestId('workbench-waiting-bar')).toHaveCount(0);
  await expect(thinking).toHaveAttribute('data-streaming', 'true');
  await expect(thinking.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await thinking.getByRole('button').click();
  await expect(thinking.locator('pre')).toContainText('Consider the input.');
  finished.parts = [
    {
      kind: 'thinking',
      id: 'thought',
      text: 'Consider the input.\nTrace the returned value.',
      streaming: false,
      startedAt: 1000,
      endedAt: 3000,
    },
    {
      kind: 'tool',
      id: 'read',
      action: 'read',
      status: 'running',
      args: { path: 'src/main.py' },
      startedAt: 3000,
    },
    {
      kind: 'tool',
      id: 'write',
      action: 'write',
      status: 'running',
      args: { path: 'src/main.py', text: 'return greeting' },
      startedAt: 4000,
    },
  ];
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(thinking.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(thinking).not.toHaveAttribute('data-streaming', 'true');
  const tools = conversation.getByTestId('workbench-tool-group');
  await expect(tools).toBeVisible();
  await expect(tools.getByTestId('workbench-tool-card')).toHaveCount(2);
  await tools.getByTestId('workbench-tool-card').first().getByRole('button').click();
  await expect(tools.locator('pre').first()).toContainText('src/main.py');
  for (const part of finished.parts)
    if (part.kind === 'tool') {
      part.status = 'succeeded';
      part.endedAt = 5000;
    }
  finished.parts.push(...originalParts);
  finished.status = 'succeeded';
  view.busy = false;
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByTestId('workbench-waiting-bar')).toHaveCount(0);
  await expect(conversation.getByText('Where does the value go?', { exact: true })).toBeVisible();
  // Settled tools auto-fold independently of their card details. Reopen the
  // group before addressing its inert descendants, as a learner would.
  await expect(tools).toHaveAttribute('data-open', 'false');
  const toolGroupToggle = tools.getByRole('button', {
    name: '2 tool calls · Completed',
    exact: true,
  });
  await toolGroupToggle.click();
  await expect(tools).toHaveAttribute('data-open', 'true');
  const firstToolToggle = tools.getByTestId('workbench-tool-card').first().getByRole('button');
  await expect(firstToolToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(tools.locator('pre').first()).toContainText('src/main.py');
  await firstToolToggle.press('Enter');
  await expect(firstToolToggle).toHaveAttribute('aria-expanded', 'false');
  await toolGroupToggle.click();
  await expect(tools).toHaveAttribute('data-open', 'false');
  view.conversation![1]!.parts.push({
    kind: 'text',
    id: 'streaming',
    text: 'A partial explanation',
    streaming: true,
  });
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByText('A partial explanation', { exact: true })).toHaveCount(1);
  const partial = view.conversation![1]!.parts.at(-1)!;
  if (partial.kind === 'text') {
    partial.text = 'A completed explanation';
    partial.streaming = false;
  }
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByText('A completed explanation', { exact: true })).toHaveCount(1);
  await expect(conversation.getByText('A partial explanation', { exact: true })).toHaveCount(0);
  finished.status = 'cancelled';
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByRole('status')).toContainText('This teaching turn was cancelled.');
  await expect(conversation.getByTestId('workbench-waiting-bar')).toHaveCount(0);
  finished.status = 'failed';
  finished.failure = 'timeout';
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(conversation.getByRole('status')).toContainText(
    'The teaching response timed out. You can retry this turn.',
  );
  await expect(conversation.getByText('A completed explanation', { exact: true })).toBeVisible();
  finished.status = 'succeeded';
  delete finished.failure;
  view.activitySequence++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await thinking.getByRole('button').click();
  await expect(thinking.getByRole('button')).toHaveAttribute('aria-expanded', 'false');

  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Greeting plan');
  await page.getByLabel('Your message', { exact: true }).fill('My draft answer');
  await page.getByRole('button', { name: 'Expand project workspace' }).click();
  await expect(page.getByRole('button', { name: 'Return to classroom layout' })).toBeVisible();
  await expect(page.getByLabel('Your message', { exact: true })).toHaveValue('My draft answer');
  await page.getByTestId('pbl-v3-frame').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: 'test-results/pbl-v3-conversation.png' });
  await page.getByRole('button', { name: 'Return to classroom layout' }).click();
  await page.getByTestId('scene-title').filter({ hasText: 'Course overview' }).click();
  await expect(page.getByTestId('pbl-v3-workspace')).toHaveCount(0);
  await page.getByTestId('scene-title').filter({ hasText: 'Practice project' }).click();
  await expect(page.getByText('Return sends a value to the caller.')).toBeVisible();
  await page.reload();
  // The host may select its first scene on reload; select the same installed PBL again.
  await page.getByTestId('scene-title').filter({ hasText: 'Practice project' }).click();
  await expect(page.getByText('Return sends a value to the caller.')).toBeVisible();
  await expect(page.getByTestId('workbench-thinking-bar').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByTestId('workbench-tool-group')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('workbench-waiting-bar')).toHaveCount(0);
  // The test control and verdict stay outside the drawer. Execution is not
  // progression: automatic collection must first save the server verdict.
  view.stage = {
    kind: 'check',
    checker: 'tests',
    studentActions: ['chat', 'evaluate', 'next'],
  } as LearningView['stage'];
  view.state.position.stageIndex = 4;
  view.role = 'mentor';
  view.actions = ['chat', 'evaluate'];
  view.evaluation = null;
  view.state.collected.greeting!.tests = null;
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  const summary = page.getByTestId('pbl-test-summary');
  const runTests = task.getByRole('button', { name: 'Run tests', exact: true });
  await expect(details).toHaveCount(0);
  await expect(summary).toHaveAttribute('data-state', 'idle');
  await expect(runTests).toBeEnabled();
  await page.mouse.move(0, 0);
  await expect
    .poll(async () =>
      greens.includes(await runTests.evaluate((el) => getComputedStyle(el).backgroundColor)),
    )
    .toBe(true);
  await runTests.click();
  await expect(summary).toHaveAttribute('data-state', 'running');
  await expect(summary.locator('.animate-spin')).toHaveCount(1);
  await expect(task.getByRole('button', { name: 'Running tests…', exact: true })).toBeDisabled();
  await expect(details).toHaveCount(0);
  await expect(page.getByText('PRIVATE DRIVER OUTPUT', { exact: true })).toHaveCount(0);
  view.evaluation!.state = 'exited';
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect.poll(() => collections).toBe(1);
  const retryResult = task.getByRole('button', { name: 'Retry getting results', exact: true });
  await expect(retryResult).toBeEnabled();
  await expect(summary).toHaveAttribute('data-state', 'unavailable');
  expect(collections).toBe(1); // Failed collection cannot create an automatic retry loop.
  await retryResult.click();
  await expect(summary).toHaveAttribute('data-state', 'failed');
  await expect(summary).toContainText('1/2 passed');
  await expect(
    task.getByRole('button', { name: 'Continue to Check your understanding', exact: true }),
  ).toHaveCount(0);
  await task.getByRole('button', { name: /Current task details/ }).click();
  await expect(page.getByTestId('pbl-test-details')).toHaveAttribute('data-state', 'failed');
  await expect(
    details.getByText('Add one task: Output did not satisfy the contract', { exact: true }),
  ).toBeVisible();
  await expect(details.getByRole('listitem')).toHaveCount(2);
  await expect(details.getByText('PRIVATE STDERR', { exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: 'Close task details' }).click({ timeout: 7000 });
  await runTests.click();
  await expect(summary).toHaveAttribute('data-state', 'running');
  // Refresh/reopen during a completed run must still collect it automatically.
  view.evaluation!.state = 'exited';
  view.revision++;
  await page.reload();
  await page.getByTestId('scene-title').filter({ hasText: 'Practice project' }).click();
  await expect(summary).toHaveAttribute('data-state', 'passed');
  await expect(summary).toContainText('2/2 passed');
  await expect(details).toHaveCount(0);
  const enterQuiz = task.getByRole('button', {
    name: 'Continue to Check your understanding',
    exact: true,
  });
  await expect(enterQuiz).toBeEnabled();
  await page.mouse.move(0, 0);
  await expect
    .poll(async () =>
      greens.includes(await enterQuiz.evaluate((el) => getComputedStyle(el).backgroundColor)),
    )
    .toBe(true);
  await task.getByRole('button', { name: /Current task details/ }).click();
  await expect(page.getByTestId('pbl-test-details')).toHaveAttribute('data-state', 'passed');
  await expect(details.getByRole('listitem')).toHaveCount(2);
  await details.getByRole('button', { name: 'Close task details' }).click({ timeout: 7000 });
  await enterQuiz.click();
  await expect(task.getByText('6/7', { exact: true })).toBeVisible();
  await expect(summary).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Expand project workspace' }).click();
  await expect(page.getByLabel('Your message', { exact: true })).toBeVisible();
  await page.getByTestId('pbl-v3-frame').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: 'test-results/pbl-v3-conversation-mobile.png' });
  await expect(page.locator('[data-testid="pbl-v3-workspace"]')).toHaveJSProperty(
    'scrollWidth',
    await page.getByTestId('pbl-v3-workspace').evaluate((el) => el.clientWidth),
  );
});
