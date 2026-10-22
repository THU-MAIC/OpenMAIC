import { test, expect } from '@playwright/test';
import type { LearningView } from '@/lib/pbl/v3/types';

/** Browser interaction contract; backend/runner/Python execution is covered by runtime.pg.test.ts. */
test.setTimeout(120000);

test('installed sample opens in the normal classroom and preserves progress after refresh', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const state = {
    status: 'running',
    introCompleted: false,
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
    environmentId: null as string | null,
    environment: null as LearningView['environment'],
    recovery: null as LearningView['recovery'],
    state,
    stage: {
      kind: 'mentor_say',
      agent: 'mentor',
      say: 'Welcome',
      reads: [],
      studentActions: ['chat', 'next'],
    },
    role: 'mentor',
    actions: ['chat'],
    files: ['PLAN.md', 'greeting.py'],
    busy: false,
    messages: [] as { role: string; text: string }[],
    roleRun: null as LearningView['roleRun'],
    decisions: [],
    questions: [] as LearningView['questions'],
    evaluation: null,
  };
  let failPreparation = false;
  let file = 'Write your plan here.';
  const workCalls: { action: string; path?: string }[] = [];
  let previewOpen = false;
  let workEpoch = 0;
  const calls: { type: string; path?: string; text?: string; expectedHash?: string }[] = [];
  await page.route('**/api/pbl/v3**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (url.searchParams.has('samples')) return route.continue();
    if (body?.action === 'sample') return route.continue(); // actual course creation and persistence
    if (url.pathname === '/api/pbl/v3/report')
      return route.fulfill({
        json: {
          studyId: view.id,
          project: { id: 'greeting-python-lab', version: '1.0.0', title: 'Greeting' },
          revision: view.revision,
          requiredComplete: false,
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
              kind: 'artifact.recorded',
              milestoneId: 'greeting',
              detail: 'Saved plan evidence',
              version: 'saved-version',
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
          conversations: [],
          truncated: false,
        },
      });
    if (url.pathname === '/api/pbl/v3/workspace') {
      if (body?.command) {
        const command = body.command;
        if (['run', 'terminal', 'preview'].includes(command.action))
          expect(command.epoch).toBe(workEpoch);
        workCalls.push(command);
        view.revision++;
        if (command.action === 'create') view.files.push(command.path);
        if (command.action === 'rename')
          view.files = view.files.map((p) => (p === command.path ? command.destination : p));
        if (command.action === 'delete') view.files = view.files.filter((p) => p !== command.path);
        if (command.action === 'preview') {
          previewOpen = true;
          return route.fulfill({ json: { url: 'https://preview.example.test/' } });
        }
        if (command.action === 'stop') {
          previewOpen = false;
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
          ports: [8000],
          commands: [],
          terminals: [],
          checkpoint: null,
        },
      });
    }
    if (req.method() === 'GET' && url.searchParams.has('file'))
      return route.fulfill({ json: { text: file, hash: 'a'.repeat(64) } });
    if (body?.command) {
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
      if (command.type === 'chat') {
        view.messages.push(
          { role: 'user', text: command.text },
          { role: 'assistant', text: 'What should greet(name) return?' },
        );
      }
      if (command.type === 'save') file = command.text;
      if (command.type === 'quiz') {
        const passed = command.answers[0] === 0;
        view.state.collected.greeting.quiz = {
          id: command.id,
          attempt: (view.state.collected.greeting.quiz?.attempt ?? 0) + 1,
          passed,
          score: passed ? 1 : 0,
          total: 1,
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
  await page.goto('/pbl-v3');
  await page.getByRole('button', { name: 'Open selected sample' }).click();
  await expect(page).toHaveURL(/\/classroom\/pbl-/, { timeout: 60000 });
  await expect(page.getByTestId('pbl-v3-workspace')).toBeVisible({ timeout: 60000 });
  const beforeReport = calls.length;
  await page.getByRole('button', { name: 'Learning report', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Learning report' })).toContainText(
    'Learning is still in progress.',
  );
  await page.getByRole('region', { name: 'Learning report' }).locator('summary').click();
  await expect(page.getByText('Saved plan evidence')).toBeVisible();
  await page
    .getByRole('region', { name: 'Learning report' })
    .screenshot({ path: 'test-results/pbl-v3-report.png' });
  expect(calls.length).toBe(beforeReport);
  await page.getByRole('button', { name: 'Return to learning' }).click();
  await page.getByRole('button', { name: 'Prepare project environment' }).click();
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
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await expect(page.getByText('What should greet(name) return?', { exact: true })).toBeVisible();
  expect(calls.filter((c) => c.type === 'prepare')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/pbl-v3-workspace.png', fullPage: true });
  view.roleRun = { status: 'failed', failure: 'authentication', canRetry: true };
  const learningAlert = page.getByTestId('pbl-v3-workspace').getByRole('alert');
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(learningAlert).toContainText('could not authenticate');
  await page.reload();
  await expect(learningAlert).toContainText('could not authenticate');
  await page.screenshot({ path: 'test-results/pbl-v3-failure.png', fullPage: true });
  await page.getByRole('button', { name: 'Retry response' }).click();
  await expect(learningAlert).toHaveCount(0);
  expect(calls.filter((c) => c.type === 'retry')).toHaveLength(1);
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(1);
  await page.getByLabel('Your message').fill('Continue after restoring my environment.');
  view.environment = { state: 'destroyed', ready: false };
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect(page.getByText('The environment is unavailable.', { exact: false })).toBeVisible();
  const blocked = page.getByTestId('pbl-input-blocked');
  await expect(blocked).toContainText('Restore it to send; your draft is kept.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  const submitted = calls.filter((c) => c.type === 'chat').length;
  await page.getByLabel('Your message').press('Enter');
  expect(calls.filter((c) => c.type === 'chat')).toHaveLength(submitted);
  failPreparation = true;
  await blocked.getByRole('button', { name: 'Restore learning environment', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The environment service is temporarily unavailable.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Your message')).toHaveValue(
    'Continue after restoring my environment.',
  );
  await expect(
    blocked.getByRole('button', { name: 'Restore learning environment', exact: true }),
  ).toBeEnabled();
  await blocked.getByRole('button', { name: 'Restore learning environment', exact: true }).click();
  await expect(blocked).toHaveCount(0);
  await expect(page.getByLabel('Your message')).toHaveValue(
    'Continue after restoring my environment.',
  );
  await page.getByLabel('Environment details', { exact: true }).click();
  await expect(page.getByText('The workspace was restored', { exact: false })).toBeVisible();
  await page.getByLabel('Environment details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  // A late read from PLAN.md must not populate or become savable as greeting.py.
  view.actions = ['chat', 'edit'];
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
        text: path === 'PLAN.md' ? 'Late plan response' : 'print("Current code")',
        hash: (path === 'PLAN.md' ? 'b' : 'c').repeat(64),
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
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('print("Saved code")');
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Saved code")');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  expect(calls.at(-1)).toMatchObject({
    type: 'save',
    path: 'greeting.py',
    text: 'print("Saved code")',
    expectedHash: 'c'.repeat(64),
  });
  await page.getByRole('button', { name: 'Manage source files' }).click();
  await page.getByLabel('Project-relative file path').fill('src/new.py');
  await page.getByRole('button', { name: 'Create file', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'new.py', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
  await page.locator('.monaco-editor .view-lines .view-line').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Unsaved learner work');
  await page.getByRole('button', { name: 'Run & output', exact: true }).click();
  await page.getByLabel('Project command', { exact: true }).fill('python3 src/new.py');
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'greeting.py', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  await page.getByRole('tab', { name: 'new.py ●', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  await page.getByRole('button', { name: 'Expand project workspace' }).click();
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
  await page.getByRole('button', { name: 'Return to classroom layout' }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  view.environmentId = '22345678-1234-1234-1234-123456789012';
  await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Unsaved learner work');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  await expect(page.getByText('The environment or file changed.', { exact: false })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard changes and reload' }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toHaveText('print("Current code")');
  await page.getByLabel('Project-relative file path').fill('src/moved.py');
  await page.getByRole('button', { name: 'Rename / move file' }).click();
  await expect(page.getByRole('tab', { name: 'moved.py', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByLabel('Project command', { exact: true }).fill('python3 src/moved.py');
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect.poll(() => workCalls.some((c) => c.action === 'run')).toBe(true);
  await page.getByRole('tab', { name: 'Project application', exact: true }).click();
  await expect(
    page.getByText(
      'Start the project web server in the terminal or Run panel, then connect to a configured port below.',
    ),
  ).toBeVisible();
  await expect(page.locator('iframe[title="Project application"]')).toHaveCount(0);
  await page.route('https://preview.example.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Project application</h1><button onclick="this.textContent=\'Clicked\'">Try</button>',
    }),
  );
  await page.getByRole('button', { name: 'Preview port 8000' }).click();
  const frame = page.frameLocator('iframe[title="Project application"]');
  await expect(frame.getByRole('heading', { name: 'Project application' })).toBeVisible();
  await frame.getByRole('button', { name: 'Try' }).click();
  await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible();
  expect(previewOpen).toBe(true);
  await page.getByRole('button', { name: 'Expand project workspace' }).click();
  await page.getByTestId('pbl-workbench-split').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page
    .getByTestId('pbl-v3-workspace')
    .screenshot({ path: 'test-results/pbl-v3-workbench.png' });
  await page.getByRole('button', { name: 'Return to classroom layout' }).click();
  await page.getByRole('button', { name: 'Stop commands and close terminals' }).click();
  await expect(page.locator('iframe[title="Project application"]')).toHaveCount(0);
  expect(previewOpen).toBe(false);
  // A creation response already in flight cannot reopen a preview after Stop.
  let releasePreview!: () => void, previewEntered!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const previewReady = new Promise<void>((resolve) => {
    previewEntered = resolve;
  });
  await page.route('**/api/pbl/v3/workspace', async (route) => {
    const command =
      route.request().method() === 'POST' ? route.request().postDataJSON()?.command : null;
    if (command?.action !== 'preview') return route.fallback();
    expect(command.epoch).toBe(workEpoch);
    previewEntered();
    await previewGate;
    return route.fulfill({ json: { url: 'https://preview.example.test/late' } });
  });
  await page.getByRole('button', { name: 'Preview port 8000' }).click();
  await previewReady;
  await page.getByRole('button', { name: 'Stop commands and close terminals' }).click();
  await expect.poll(() => workEpoch).toBe(2);
  releasePreview();
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
  await expect(page.locator('iframe[title="Project application"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect.poll(() => calls.some((c) => c.type === 'checkpoint')).toBe(true);
  view.questions = [{ q: 'What does return do?', options: ['Returns a value', 'Prints a value'] }];
  view.actions = ['quiz'];
  view.stage = {
    kind: 'check',
    checker: 'quiz',
    studentActions: ['quiz', 'next'],
  } as LearningView['stage'];
  view.state.position.stageIndex = 5;
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await page.getByRole('button', { name: /Current task details/ }).click();
  await page.getByRole('radio', { name: 'Prints a value' }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(
    page.getByText('0/1 correct. Review your answers and try again.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  // The drawer closes on reload; its recorded quiz result remains available on reopening.
  await page.getByRole('button', { name: /Current task details/ }).click();
  await expect(page.getByRole('region', { name: 'Current task details', exact: true })).toBeVisible(
    { timeout: 15000 },
  );
  await expect(
    page.getByText('0/1 correct. Review your answers and try again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Returns a value' }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(
    page.getByText('Quiz passed: 1/1 correct. You can continue.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
});
