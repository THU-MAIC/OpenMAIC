import { createHash } from 'node:crypto';
import { expect, type Request } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import type { LearningView } from '@/lib/pbl/v3/types';

/** Browser interaction contract; backend/runner/Python execution is covered by runtime.pg.test.ts. */
test.setTimeout(120000);

function isPreparationRequest(request: Request) {
  return (
    request.method() === 'POST' &&
    new URL(request.url()).pathname === '/api/pbl/v3' &&
    request.postDataJSON()?.command?.type === 'prepare'
  );
}

test('installed sample opens in the normal classroom and preserves progress after refresh', async ({
  page,
  learningEvents,
}) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const state = {
    status: 'running',
    position: { milestoneIndex: 0, milestoneId: 'greeting', stageIndex: 0 },
    milestones: [],
    collected: {
      greeting: {
        decisions: [],
        decisionRecordIds: {},
        plan: null,
        code: null,
        tests: null,
        quiz: null as LearningView['state']['collected'][string]['quiz'],
        remediation: null,
      },
    },
    decisionRevisions: {},
    lastSequence: 1,
  };
  const view = {
    id: 'learning-browser',
    revision: 0,
    title: 'A friendly greeting',
    reportAvailable: false,
    environmentId: null as string | null,
    environment: null as LearningView['environment'],
    recovery: null as LearningView['recovery'],
    state,
    milestones: [
      {
        id: 'greeting',
        title: 'Greeting',
        stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
      },
    ],
    stage: {
      kind: 'mentor_say',
      agent: 'discussion',
      say: 'Welcome',
      reads: [],
      studentActions: ['chat', 'next'],
    },
    role: 'discussion',
    needsOpening: true,
    actions: ['chat'],
    files: ['PLAN.md', 'greeting.py'],
    busy: false,
    messages: [] as { role: string; text: string }[],
    roleRun: null as LearningView['roleRun'],
    decisions: [],
    questions: [] as LearningView['questions'],
    evaluation: null as LearningView['evaluation'],
  };
  let failPreparation = false;
  let file = 'Write your plan here.';
  const savedFiles = new Map<string, { text: string; hash: string }>();
  let rejectAutosave = false;
  let unavailableAutosave = false;
  let conflictAutosaveProgress = false;
  const saveAttempts: { id: string; revision: number; text: string; expectedHash: string }[] = [];
  let readGate: Promise<void> | null = null,
    chatGate: Promise<void> | null = null,
    createGate: Promise<void> | null = null;
  let readEntered = () => {},
    chatEntered = () => {},
    createEntered = () => {};

  const workCalls: { action: string; path?: string }[] = [];
  let workEpoch = 0;
  const calls: { type: string; path?: string; text?: string; expectedHash?: string }[] = [];
  await page.route('**/api/pbl/v3**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (url.searchParams.get('project') === '1') {
      expect(req.headers()['x-openmaic-sandbox']).toBe('1');
      return route.fulfill({
        json: {
          hero: {
            title: view.title,
            description: 'Build a greeting application with your project tutor.',
            gains: ['Review plans and code', 'Run tests'],
            instructorName: 'Project tutor',
            milestoneCount: 2,
            taskCount: 14,
          },
          started: calls.length > 0,
        },
      });
    }
    if (body?.command?.type === 'chat' && chatGate) {
      const gate = chatGate;
      chatGate = null;
      chatEntered();
      await gate;
    }
    if (url.searchParams.has('samples')) return route.continue();
    if (body?.action === 'sample') return route.continue(); // actual course creation and persistence
    if (url.pathname === '/api/pbl/v3/activity') return route.fulfill({ json: { recorded: true } });
    if (url.pathname === '/api/pbl/v3/report') {
      if (req.method() === 'POST') expect(req.headers()['content-type']).toBe('application/json');
      return route.fulfill({
        json: {
          studyId: view.id,
          project: { id: 'greeting-python-lab', version: '1.1.0', title: 'Greeting' },
          analysis: {
            status: 'ready',
            omitted: true,
            findings: [
              {
                category: 'journey',
                title: 'A saved learning journey',
                detail: 'The plan records your implementation choices.',
                evidence: ['event:7'],
              },
            ],
          },
          facts: {
            learnerTurns: 3,
            assistantTurns: 3,
            decisions: 1,
            decisionChanges: 0,
            testRuns: 1,
            quizAttempts: 2,
            fileEdits: 1,
            interruptedRuns: 0,
          },
          revision: view.revision,
          requiredComplete: true,
          milestones: [
            {
              id: 'greeting',
              title: 'Greeting',
              optional: false,
              status: 'active',
              stages: ['plan'],
            },
          ],
          evidence: [
            {
              sequence: 7,
              at: 30,
              kind: 'artifact.recorded',
              milestoneId: 'greeting',
              detail: 'Saved plan evidence',
              version: 'v1',
            },
          ],
          outcomes: [
            {
              milestoneId: 'greeting',
              tests: 'passed',
              quiz: { score: 1, total: 1, attempt: 1 },
              reflected: false,
            },
          ],
          counts: { 'artifact.recorded': 1 },
          conversations: [
            {
              role: 'mentor',
              milestone: 'project',
              truncated: false,
              messages: [
                { sequence: 1, at: 10, role: 'assistant', text: 'Report timeline opening' },
                { sequence: 2, at: 60, role: 'assistant', text: 'Report timeline reflection' },
              ],
            },
            {
              role: 'coder',
              milestone: 'greeting',
              truncated: false,
              messages: [{ sequence: 1, at: 40, role: 'user', text: 'Report timeline correction' }],
            },
            {
              role: 'planner',
              milestone: 'greeting',
              truncated: false,
              messages: [{ sequence: 1, at: 20, role: 'user', text: 'Report timeline plan' }],
            },
          ],
          truncated: true,
        },
      });
    }
    if (url.pathname === '/api/pbl/v3/workspace') {
      if (body?.command) {
        const command = body.command;
        if (command.action === 'create' && createGate) {
          const gate = createGate;
          createGate = null;
          createEntered();
          await gate;
        }
        if (['run', 'terminal'].includes(command.action)) expect(command.epoch).toBe(workEpoch);
        workCalls.push(command);
        view.revision++;
        if (command.action === 'create') view.files.push(command.path);
        if (command.action === 'rename')
          view.files = view.files.map((p) => (p === command.path ? command.destination : p));
        if (command.action === 'delete') view.files = view.files.filter((p) => p !== command.path);
        if (command.action === 'stop') {
          workEpoch++;
        }
        return route.fulfill({ json: { accepted: true } });
      }
      return route.fulfill({
        json: {
          environmentId: view.environmentId,
          revision: view.revision,
          epoch: workEpoch,
          canEdit: view.actions.includes('edit'),
          planning: false,
          canManageFiles: view.actions.includes('edit'),
          canRun: view.actions.includes('edit'),
          commands: [],
          terminals: [],
        },
      });
    }
    if (req.method() === 'GET' && url.searchParams.has('file')) {
      if (readGate && url.searchParams.get('file') === 'greeting.py') {
        const gate = readGate;
        readGate = null;
        readEntered();
        await gate;
      }
      return route.fulfill({
        json: savedFiles.get(url.searchParams.get('file')!) ?? {
          text: url.searchParams.get('file') === 'PLAN.md' ? file : 'print("Starter")',
          hash: 'a'.repeat(64),
        },
      });
    }
    if (body?.command) {
      if (body.command.type === 'save') {
        saveAttempts.push(body.command);
        if (unavailableAutosave) {
          unavailableAutosave = false;
          view.environment = { state: 'destroyed', ready: false };
          view.revision++;
          return route.fulfill({
            status: 409,
            json: { error: { code: 'SANDBOX_CONFLICT', reason: 'ENVIRONMENT_UNAVAILABLE' } },
          });
        }
        if (conflictAutosaveProgress) {
          conflictAutosaveProgress = false;
          view.revision++;
          return route.fulfill({
            status: 409,
            json: { error: { code: 'SANDBOX_CONFLICT', reason: 'PROGRESS_CHANGED' } },
          });
        }
      }
      if (body.command.type === 'save' && rejectAutosave)
        return route.fulfill({ status: 503, json: { error: { code: 'SANDBOX_UNAVAILABLE' } } });
      expect(body.command.revision).toBe(view.revision);
      calls.push(body.command);
      const command = body.command;
      if (command.type === 'prepare' && failPreparation) {
        failPreparation = false;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SANDBOX_UNAVAILABLE', message: 'Private provider diagnostic' } },
        });
      }
      view.revision++;
      if (command.type === 'prepare') {
        if (view.environmentId) view.recovery = { checkpointRevision: 1, progressReset: true };
        view.environmentId = '12345678-1234-1234-1234-123456789012';
        view.environment = { state: 'running', ready: true };
      }
      if (command.type === 'begin') {
        view.needsOpening = false;
        view.messages.push({
          role: 'assistant',
          text: 'Welcome to your greeting project.\n\n### The project\nBuild a small greeting application.\n\n### This milestone\nMake the greeting return a value.\n\n### How learning works\n- **Seven steps:** Teaching, decisions, planning, coding, tests, quiz and reflection.\n- **Agents guide you:** Discuss, ask questions, and review the plan and code together.\n\nAny questions about the project or process? If not, are you ready to begin?',
        });
      }
      if (command.type === 'chat') {
        view.messages.push(
          { role: 'user', text: command.text },
          { role: 'assistant', text: 'What should greet(name) return?' },
        );
      }
      if (command.type === 'save') {
        file = command.text;
        savedFiles.set(command.path, {
          text: command.text,
          hash: createHash('sha256').update(command.text).digest('hex'),
        });
      }
      if (command.type === 'quiz') {
        const passed =
          command.answers.length === 2 && command.answers.every((answer: number) => answer === 0);
        view.state.collected.greeting.quiz = {
          id: command.id,
          attempt: (view.state.collected.greeting.quiz?.attempt ?? 0) + 1,
          passed,
          score: passed ? 2 : 1,
          total: 2,
          wrong: passed ? [] : [0],
        };
        view.actions = passed ? ['quiz', 'next'] : ['quiz'];
      }
      if (command.type === 'retry')
        view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
      return route.fulfill({ json: { result: { accepted: true }, view } });
    }
    return route.fulfill({ json: view });
  });
  await learningEvents(() => ({
    view: view as unknown as LearningView,
    workbench: view.environmentId
      ? {
          environmentId: view.environmentId,
          revision: view.revision,
          epoch: workEpoch,
          canEdit: view.actions.includes('edit'),
          canManageFiles: view.actions.includes('edit'),
          canRun: view.actions.includes('edit'),
          planning: false,
          commands: [],
          terminals: [],
        }
      : null,
  }));
  await page.goto('/pbl-v3');
  await page.getByRole('button', { name: 'Open selected sample' }).click();
  await expect(page).toHaveURL(/\/classroom\/pbl-/, { timeout: 60000 });
  await expect(page.getByRole('heading', { name: view.title, exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: /^(?:Start Project|Continue Project)$/ }).click();
  await expect(page.getByTestId('pbl-v3-workspace')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Learning report', exact: true })).toHaveCount(0);
  await expect(page.getByText('1/7', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Welcome to your greeting project.', { exact: true })).toBeVisible();
  for (const name of ['The project', 'This milestone', 'How learning works'])
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Seven steps:', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Any questions about the project or process? If not, are you ready to begin?', {
      exact: true,
    }),
  ).toBeVisible();
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'begin')).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to project overview', exact: true }).click();
  await expect(page.getByTestId('pbl-v3-workspace')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue Project', exact: true }).click();
  await expect(page.getByTestId('pbl-workspace-frame')).toHaveAttribute('data-expanded', 'true');
  expect(calls.filter((c) => c.type === 'begin')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(1);

  expect(calls.filter((c) => c.type === 'chat' || c.type === 'next')).toHaveLength(0);
  expect(view.state.position).toEqual({
    milestoneIndex: 0,
    milestoneId: 'greeting',
    stageIndex: 0,
  });
  await expect(page.getByRole('button', { name: 'Retry project setup', exact: true })).toHaveCount(
    0,
  );
  // Read-only Monaco model switches and server value refreshes are not learner edits.
  await expect(page.getByRole('button', { name: 'Reload file', exact: true })).toBeEnabled();
  let releaseRead!: () => void;
  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fileReadStarted = new Promise<void>((resolve) => {
    readEntered = resolve;
  });
  await page.getByRole('button', { name: 'greeting.py', exact: true }).click();
  await fileReadStarted;
  await expect(page.getByRole('tab', { name: 'greeting.py', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByTestId('pbl-pending-action').filter({ hasText: 'Reading file…' }),
  ).toBeVisible();
  releaseRead();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Starter")');
  await page.getByRole('tab', { name: 'PLAN.md', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Write your plan here.');
  await page.getByRole('tab', { name: 'greeting.py', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Starter")');
  await page.getByRole('tab', { name: 'PLAN.md', exact: true }).click();
  await expect(page.getByRole('tab', { name: /●/ })).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'save')).toHaveLength(0);
  await expect(page.getByRole('tab', { name: 'Project application' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Project application', exact: true })).toHaveCount(
    0,
  );
  // Hold an old progress GET until after a teaching command installs a newer revision.
  let releaseView!: () => void, viewStarted!: () => void;
  const viewGate = new Promise<void>((resolve) => {
    releaseView = resolve;
  });
  const viewSeen = new Promise<void>((resolve) => {
    viewStarted = resolve;
  });
  let holdView = true;
  await page.route('**/api/pbl/v3?**', async (route) => {
    if (!holdView || new URL(route.request().url()).searchParams.has('file'))
      return route.fallback();
    holdView = false;
    const stale = structuredClone(view);
    viewStarted();
    await viewGate;
    await route.fulfill({ json: stale, headers: { 'x-pbl-stale-fixture': '1' } });
  });
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await viewSeen;
  await page.getByLabel('Your message').fill('Please introduce the project.');
  let releaseChat!: () => void;
  chatGate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  const chatStarted = new Promise<void>((resolve) => {
    chatEntered = resolve;
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await chatStarted;
  await expect(
    page.getByTestId('pbl-pending-action').filter({ hasText: 'Sending message…' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.getByTestId('workbench-waiting-bar')).toHaveCount(1);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(0);
  releaseChat();

  await expect(page.getByText('What should greet(name) return?', { exact: true })).toBeVisible();
  const staleViewResponse = page.waitForResponse(
    (response) => response.headers()['x-pbl-stale-fixture'] === '1',
  );
  releaseView();
  await (await staleViewResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText('What should greet(name) return?', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^(?:Start Project|Continue Project)$/ }).click();
  await expect(page.getByText('What should greet(name) return?', { exact: true })).toBeVisible();
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(1);
  await expect(page.getByRole('button', { name: /^Continue(?: to|$)/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/pbl-v3-workspace.png', fullPage: true });
  view.roleRun = { status: 'failed', failure: 'authentication', canRetry: true };
  const learningAlert = page.getByTestId('pbl-v3-workspace').getByRole('alert');
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(learningAlert).toContainText('could not authenticate');
  await page.reload();
  await page.getByRole('button', { name: /^(?:Start Project|Continue Project)$/ }).click();
  await expect(learningAlert).toContainText('could not authenticate');
  await page.screenshot({ path: 'test-results/pbl-v3-failure.png', fullPage: true });
  await page.getByRole('button', { name: 'Retry response' }).click();
  await expect(learningAlert).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'retry')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(1);
  await page.getByLabel('Your message').fill('Continue after restoring my environment.');
  const preparationsBeforeDisconnect = calls.filter((c) => c.type === 'prepare').length;
  view.environment = { state: 'destroyed', ready: false };
  failPreparation = true;
  const beforeRecovery = calls.filter((c) => c.type === 'prepare').length;
  // Observe expiry without trusted input: passive refreshes must not allocate compute.
  await page.getByRole('button', { name: 'Refresh progress' }).dispatchEvent('click');
  await expect(page.getByTestId('pbl-environment-setup')).toContainText('environment is inactive');
  await expect(page.getByTestId('pbl-environment-setup')).toContainText(
    'Click in the workbench to restore automatically',
  );
  await expect(page.getByTestId('pbl-editor-readonly')).toContainText('read-only');
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeRecovery);
  // Classroom navigation is only reachable outside the shared fullscreen overlay.
  if (
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).isVisible()
  )
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  // A navigation pointer-down can precede its click by an arbitrary interval. It must
  // not wake this inactive workspace, even if the learner cancels the navigation gesture.
  await page.waitForTimeout(1100);
  const navigationRestore = page.waitForRequest(isPreparationRequest, { timeout: 1000 }).then(
    () => true,
    () => false,
  );
  await page.getByRole('button', { name: 'Back to Home', exact: true }).hover();
  await page.mouse.down();
  try {
    expect(await navigationRestore).toBe(false);
  } finally {
    await page.mouse.move(1, 1);
    await page.mouse.up();
  }
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeRecovery);
  // Exercise trusted input beyond the activity wake-up coalescing interval.
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: 'Restore project files', exact: true }).click();
  await expect(page.getByTestId('pbl-environment-setup')).toContainText('could not be prepared');
  const blocked = page.getByTestId('pbl-input-blocked');
  await expect(blocked).toContainText('retry above; your draft is kept.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  const submitted = calls.filter((c) => c.type === 'chat').length;
  await page.waitForTimeout(1100);
  const automaticRetry = page.waitForRequest(isPreparationRequest, { timeout: 1500 }).then(
    () => true,
    () => false,
  );
  await page.getByLabel('Your message').press('Enter');
  expect(await automaticRetry).toBe(false);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(submitted);
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeRecovery + 1);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The environment service is temporarily unavailable.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Your message')).toHaveValue(
    'Continue after restoring my environment.',
  );
  const attempts = calls.filter((c) => c.type === 'prepare').length;
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(attempts);
  await page.getByRole('button', { name: 'Retry project setup', exact: true }).click();
  await expect(blocked).toHaveCount(0);
  await expect(page.getByLabel('Your message')).toHaveValue(
    'Continue after restoring my environment.',
  );
  await page.getByLabel('Environment details', { exact: true }).click();
  await expect(page.getByText('The workspace was restored', { exact: false })).toBeVisible();
  await page.getByLabel('Environment details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const beforeContentRestore = calls.filter((c) => c.type === 'prepare').length;
  view.environment = { state: 'destroyed', ready: false };
  await page.getByRole('button', { name: 'Refresh progress' }).dispatchEvent('click');
  await expect(page.getByTestId('pbl-environment-setup')).toContainText('environment is inactive');
  await expect(page.getByTestId('pbl-environment-setup')).toContainText(
    'Click in the workbench to restore automatically',
  );
  await expect(page.getByTestId('pbl-editor-readonly')).toContainText('read-only');
  await page.waitForTimeout(1100);
  // Trusted input in the PBL content still restores automatically, without changing the draft.
  await page.getByLabel('Your message').press('ArrowLeft');
  await expect(page.getByTestId('pbl-environment-setup')).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeContentRestore + 1);
  // A late read from PLAN.md must not populate or become savable as greeting.py.
  view.actions = ['chat', 'edit'];
  view.state.position.stageIndex = 3;
  view.stage = {
    kind: 'produce',
    agent: 'coder',
    writes: 'code',
    reviewRequired: true,
    reads: [],
    studentActions: ['chat', 'edit', 'next'],
  } as LearningView['stage'];
  view.role = 'coder';
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  let releasePlan!: () => void, planStarted!: () => void;
  const planGate = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  const planSeen = new Promise<void>((resolve) => {
    planStarted = resolve;
  });
  await page.route('**/api/pbl/v3?**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('file');
    if (!path) return route.fallback();
    if (path === 'PLAN.md') {
      planStarted();
      await planGate;
    }
    await route.fulfill({
      json: {
        ...(savedFiles.get(path) ?? {
          text: path === 'PLAN.md' ? 'Late plan response' : 'print("Current code")',
          hash: (path === 'PLAN.md' ? 'b' : 'c').repeat(64),
        }),
      },
    });
  });
  await page.getByRole('button', { name: 'Reload file' }).click();
  await planSeen;
  await page.getByRole('button', { name: 'greeting.py', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  const lateResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('file') === 'PLAN.md',
  );
  releasePlan();
  await lateResponse;
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('print("Saved code")');
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Saved code")');
  await expect.poll(() => calls.some((c) => c.type === 'save')).toBe(true);
  expect(calls.at(-1)).toMatchObject({
    type: 'save',
    path: 'greeting.py',
    text: 'print("Saved code")',
    expectedHash: 'c'.repeat(64),
  });
  const saved = page
    .getByTestId('pbl-ide')
    .getByRole('status')
    .filter({ hasText: /^Saved$/ });
  await expect(saved).toBeVisible();
  conflictAutosaveProgress = true;
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('print("A retained draft")');
  const retrySave = page.getByRole('button', { name: 'Save failed · Retry', exact: true });
  await expect(retrySave).toBeVisible();
  const rejectedSave = saveAttempts.at(-1)!;
  expect(rejectedSave.revision).toBe(view.revision - 1);
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('print("Saved code after retry")');
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
    'print("Saved code after retry")',
  );
  await retrySave.click();
  await expect(saved).toBeVisible();
  expect(saveAttempts.at(-1)).toMatchObject({
    revision: rejectedSave.revision + 1,
    text: 'print("Saved code after retry")',
    expectedHash: rejectedSave.expectedHash,
  });
  expect(saveAttempts.at(-1)!.id).not.toBe(rejectedSave.id);
  const savesBeforeSwitching = calls.filter((c) => c.type === 'save').length;
  for (let i = 0; i < 2; i++) {
    await page.getByRole('tab', { name: 'PLAN.md', exact: true }).click();
    await page.locator('.monaco-editor .view-lines .view-line').first().click();
    await page.keyboard.press('Backspace');
    await expect(page.locator('.monaco-editor-overlaymessage')).toContainText(
      'PLAN.md is approved',
    );
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'greeting.py', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
      'print("Saved code after retry")',
    );
  }
  await expect(page.getByRole('tab', { name: /●/ })).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'save')).toHaveLength(savesBeforeSwitching);
  // Testing locks remain visible even with a clean, saved editor buffer.
  const codingStage = view.stage;
  view.stage = { kind: 'check', checker: 'tests' } as LearningView['stage'];
  view.state.position.stageIndex = 4;
  view.evaluation = { id: 'running-test', state: 'running', stdout: '', stderr: '' };
  view.actions = [];
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.getByTestId('pbl-editor-readonly')).toContainText('Tests are running');
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.type('blocked');
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
    'print("Saved code after retry")',
  );
  expect(calls.filter((c) => c.type === 'save')).toHaveLength(savesBeforeSwitching);
  view.stage = codingStage;
  view.state.position.stageIndex = 3;
  view.evaluation = null;
  view.actions = ['chat', 'edit'];
  view.busy = true;
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.type('x');
  await expect(page.locator('.monaco-editor-overlaymessage')).toContainText(
    'The assistant is working',
  );
  await expect(page.getByTestId('pbl-editor-readonly')).toContainText('The assistant is working');
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
    'print("Saved code after retry")',
  );
  const lockMessage = page.locator('.monaco-editor-overlaymessage');
  await expect.poll(() => lockMessage.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(lockMessage).toBeInViewport();
  expect(
    await lockMessage.locator('.message').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 3));
    }),
  ).toBe(true); // The first-line hint must not be clipped by the resizable panel.
  await page
    .getByTestId('pbl-v3-workspace')
    .screenshot({ path: 'test-results/pbl-v3-readonly.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.monaco-editor-overlaymessage')).not.toBeVisible();
  await page.keyboard.type('y');
  await expect(page.locator('.monaco-editor-overlaymessage')).toContainText(
    'The assistant is working',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.monaco-editor textarea').first()).not.toBeEditable();
  view.busy = false;
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
  const hideFiles = page.getByRole('button', { name: 'Hide file tree', exact: true });
  const fileHeader = hideFiles.locator('..');
  await expect(fileHeader).toContainText('Project files');
  const editorWidth = (await page.locator('.monaco-editor').boundingBox())!.width;
  await hideFiles.click();
  const showFiles = page.getByRole('button', { name: 'Toggle file explorer', exact: true });
  await expect(showFiles).toBeVisible();
  await expect
    .poll(async () => (await page.locator('.monaco-editor').boundingBox())!.width)
    .toBeGreaterThan(editorWidth);
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
    'print("Saved code after retry")',
  );
  await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
  await showFiles.click();
  await expect(hideFiles).toBeVisible();
  await expect(showFiles).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'save')).toHaveLength(savesBeforeSwitching);
  await page.getByRole('button', { name: 'Manage source files' }).click();
  await page.getByLabel('Project-relative file path').fill('src/new.py');
  let releaseCreate!: () => void;
  createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const createStarted = new Promise<void>((resolve) => {
    createEntered = resolve;
  });
  await page.getByRole('button', { name: 'Create file', exact: true }).click();
  await createStarted;
  await expect(
    page.getByTestId('pbl-pending-action').filter({ hasText: 'Creating file…' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'new.py', exact: true })).toHaveCount(0);
  releaseCreate();

  await expect(page.getByRole('tab', { name: 'new.py', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
  rejectAutosave = true;
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Unsaved learner work');
  await expect(page.getByRole('button', { name: 'Run & output', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Project command', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'greeting.py', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText(
    'print("Saved code after retry")',
  );
  await page.getByRole('tab', { name: 'new.py ●', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  if (
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).isVisible()
  )
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Expand to fullscreen workspace', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  const ideBox = (await page.getByTestId('pbl-ide').boundingBox())!;
  const agentBox = (await page.getByTestId('pbl-assistant').boundingBox())!;
  expect(ideBox.x + ideBox.width).toBeLessThanOrEqual(agentBox.x + 1);
  const divider = page.getByRole('separator', { name: 'Resize workspace and assistant' });
  await divider.focus();
  await divider.press('ArrowLeft');
  await expect
    .poll(async () => (await page.getByTestId('pbl-ide').boundingBox())!.width)
    .toBeLessThan(ideBox.width);
  await page.getByRole('button', { name: 'Exit fullscreen workspace' }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  // A genuinely different recovered base must remain protected. Changing only
  // the environment ID with an unchanged base now correctly resumes editing.
  const savesBeforeConflictingRestore = saveAttempts.length;
  savedFiles.set('src/new.py', { text: 'print("Recovered code")', hash: 'd'.repeat(64) });
  view.environmentId = '22345678-1234-1234-1234-123456789012';
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  await expect(page.locator('.monaco-editor textarea').first()).not.toBeEditable();
  await expect(page.getByRole('alert').filter({ hasText: 'recovered file differs' })).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy retained draft', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Unsaved learner work');
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.type('x');
  await expect(page.locator('.monaco-editor-overlaymessage')).toContainText(
    'The environment or file changed.',
  );
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  await page.keyboard.press('Escape');
  expect(saveAttempts).toHaveLength(savesBeforeConflictingRestore);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard changes and reload' }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Recovered code")');
  rejectAutosave = false;
  // Real workbench/Monaco recovery: the rejected draft survives restore and
  // saves against its verified base with a new request, without discarding it.
  unavailableAutosave = true;
  const restoredEditor = page.locator('.monaco-editor textarea').first();
  await expect(restoredEditor).toBeEditable();
  await restoredEditor.focus();
  await restoredEditor.press('ControlOrMeta+A');
  await page.keyboard.insertText('print("Draft after idle")');
  await expect(retrySave).toBeVisible();
  await expect(page.getByTestId('pbl-environment-setup')).toContainText('environment is inactive');
  await expect(page.getByTestId('pbl-environment-setup')).toContainText(
    'Click in the workbench to restore automatically',
  );
  await expect(page.getByTestId('pbl-editor-readonly')).toContainText('read-only');
  const unavailableRequest = saveAttempts.at(-1)!;
  const beforeDraftRestore = calls.filter((c) => c.type === 'prepare').length;
  await page.getByRole('button', { name: 'Restore project files', exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Draft after idle")');
  expect(saveAttempts.at(-1)!.id).not.toBe(unavailableRequest.id);
  expect(saveAttempts.at(-1)!.expectedHash).toBe(unavailableRequest.expectedHash);
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeDraftRestore + 1);
  await expect(page.getByRole('button', { name: 'Copy retained draft', exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('Project-relative file path').fill('src/moved.py');
  await page.getByRole('button', { name: 'Rename / move file' }).click();
  await expect(page.getByRole('tab', { name: 'moved.py', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Build output uses the task drawer; only the explicit read-only notice takes editor space.
  const editorHeight = (await page.locator('.monaco-editor').first().boundingBox())!.height;
  view.actions.push('compile');
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Build output', exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId('pbl-ide').getByRole('button', { name: 'Build / check syntax', exact: true }),
  ).toHaveCount(0);
  const taskDetails = page.getByRole('region', { name: 'Current task details', exact: true });
  if (!(await taskDetails.isVisible()))
    await page.getByRole('button', { name: /Current task details/ }).click();
  await expect(
    taskDetails.getByRole('button', { name: 'Build / check syntax', exact: true }),
  ).toBeVisible();
  view.evaluation = {
    id: 'course-build',
    purpose: 'compile',
    state: 'running',
    stdout: '',
    stderr: '',
  };
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.getByTestId('pbl-build-status').locator('.animate-spin')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(page.locator('.pbl-task-dock [data-action="compile"] .animate-spin')).toHaveCount(1);
  expect(
    (await page.locator('.monaco-editor').first().boundingBox())!.height +
      ((await page.getByTestId('pbl-editor-readonly').boundingBox())?.height ?? 0),
  ).toBeGreaterThanOrEqual(editorHeight - 1);
  view.evaluation.state = 'exited';
  view.evaluation.stderr = 'greeting.py:1: SyntaxError: expected a colon';
  view.revision++;
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await page.getByRole('button', { name: /Current task details/ }).click();
  await expect(taskDetails.getByText('greeting.py:1: SyntaxError: expected a colon')).toBeVisible();
  await expect(page.getByTestId('pbl-build-status')).toHaveCount(0);
  await expect(page.locator('.pbl-task-dock [data-action="compile"]')).toHaveCount(0);
  await expect(
    taskDetails.getByRole('button', { name: 'Collect test result', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  view.evaluation = null;
  // The current activity exposes no shell or arbitrary-command controls.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop commands and close terminals' })).toHaveCount(
    0,
  );
  expect(workCalls.some((c) => ['run', 'terminal', 'stop'].includes(c.action))).toBe(false);
  await expect(page.getByRole('button', { name: 'Project application', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('iframe[title="Project application"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save checkpoint', exact: true })).toHaveCount(0);
  await page
    .getByTestId('pbl-v3-workspace')
    .screenshot({ path: 'test-results/pbl-v3-workbench.png' });
  view.questions = [
    { q: 'What does return do?', options: ['Returns a value', 'Prints a value'] },
    {
      q: 'When do editor changes reach the workspace?',
      options: ['After saving', 'While typing only'],
    },
  ];
  view.actions = ['quiz'];
  view.stage = {
    kind: 'check',
    checker: 'quiz',
    studentActions: ['quiz', 'next'],
  } as LearningView['stage'];
  view.state.position.stageIndex = 5;
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await page.getByRole('button', { name: /Current task details/ }).click();
  // Selecting the last question first must not count sparse array slots as answers.
  await page.getByRole('radio', { name: 'After saving' }).check();
  await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /^(?:Start Project|Continue Project)$/ }).click();
  await page.getByRole('button', { name: /Current task details/ }).click();
  await expect(page.getByRole('radio', { name: 'After saving' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Prints a value' }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(
    page.getByText('1/2 correct. Review your answers and try again.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^(?:Start Project|Continue Project)$/ }).click();
  // The drawer closes on reload; its recorded quiz result remains available on reopening.
  await page.getByRole('button', { name: /Current task details/ }).click();
  await expect(page.getByRole('region', { name: 'Current task details', exact: true })).toBeVisible(
    { timeout: 15000 },
  );
  await expect(
    page.getByText('1/2 correct. Review your answers and try again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue(?: to|$)/ })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Returns a value' }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(
    page.getByText('Quiz passed: 2/2 correct. You can continue.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue(?: to|$)/ })).toBeEnabled();
  const beforeCompletedProject = calls.filter((c) => c.type === 'prepare').length;
  view.state.status = 'completed';
  view.reportAvailable = true;
  view.environment = { state: 'destroyed', ready: false };
  view.stage = {
    kind: 'mentor_say',
    agent: 'mentor',
    skill: 'recap',
    reads: [],
    studentActions: [],
  } as LearningView['stage'];
  view.role = 'mentor';
  view.actions = [];
  view.state.position.stageIndex = 6;
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  const workspace = page.getByTestId('pbl-v3-workspace');
  const toolbarReport = workspace
    .locator(':scope > header')
    .getByRole('button', { name: 'Learning report', exact: true });
  const completionReport = workspace
    .getByTestId('pbl-project-completed')
    .getByRole('button', { name: 'Learning report', exact: true });
  await expect(toolbarReport).toBeVisible();
  await expect(completionReport).toBeVisible();
  // Completed projects can restore source files explicitly; opening the report needs no compute.
  await expect(
    page.getByRole('button', { name: 'Restore project files', exact: true }),
  ).toBeVisible();
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeCompletedProject);
  if (
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).isVisible()
  )
    await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Expand to fullscreen workspace', exact: true }).click();
  await toolbarReport.click();
  const report = page.getByRole('dialog', { name: 'Learning report', exact: true });
  await expect(report.getByText('A saved learning journey', { exact: true })).toBeVisible();
  await expect(
    report.getByText(
      'Some records were shortened or omitted from this analysis. The saved evidence below remains available.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    report.getByText('Only the most recent records are shown here. Earlier records remain saved.', {
      exact: true,
    }),
  ).toBeVisible();
  await report.getByRole('button', { name: 'Evidence 7', exact: true }).click();
  await expect(report.getByText('Saved plan evidence')).toBeVisible();
  expect(
    await report
      .locator(`details[id^="report-source-${view.id}-turn-"]`)
      .evaluateAll((items) => items.map((item) => item.id)),
  ).toEqual([
    `report-source-${view.id}-turn-0-1`,
    `report-source-${view.id}-turn-2-1`,
    `report-source-${view.id}-turn-1-1`,
    `report-source-${view.id}-turn-0-2`,
  ]);
  await report.evaluate((el) => {
    el.scrollTop = 0;
  });
  await report.screenshot({ path: 'test-results/pbl-v3-report.png' });
  await report.getByRole('button', { name: 'View read-only workbench', exact: true }).click();
  await expect(report).toHaveCount(0);
  await completionReport.click();
  await expect(report.getByText('A saved learning journey', { exact: true })).toBeVisible();
  await report.getByRole('button', { name: 'Close report', exact: true }).click();
  await expect(report).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(beforeCompletedProject);
});
