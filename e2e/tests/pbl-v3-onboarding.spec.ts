import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';

const COMPACT_WORKBENCH_WIDTH = 768;

test.describe.configure({ mode: 'parallel' });

async function project(
  page: Page,
  learningEvents: (read: () => LearningSnapshot) => Promise<() => void>,
  {
    started = false,
    completed = false,
    failOpen,
    failFirstPrepare = false,
    secondScene = false,
    guideCompleted = started,
    application = true,
    locale = 'en-US',
    environmentReady = true,
    prepareGate,
    lagPreparationWorkbench = false,
    beginGate,
    opening = false,
    openingText = '',
    finishedWork,
    explanationBoard = false,
  }: {
    started?: boolean;
    completed?: boolean;
    failOpen?: () => boolean;
    failFirstPrepare?: boolean;
    secondScene?: boolean;
    guideCompleted?: boolean | null;
    application?: boolean;
    locale?: string;
    environmentReady?: boolean;
    prepareGate?: Promise<void>;
    lagPreparationWorkbench?: boolean;
    beginGate?: Promise<void>;
    opening?: boolean;
    openingText?: string;
    finishedWork?: string;
    explanationBoard?: boolean;
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
    completedFilesAvailable: completed,
    environmentId: 'fixture-environment',
    ...(explanationBoard ? { explainBoard: { whiteboard: null, lastSeq: null, pages: [] } } : {}),
    environment: { state: environmentReady ? 'running' : 'creating', ready: environmentReady },
    recovery: null,
    state: {
      status: completed ? 'completed' : 'running',
      position: {
        milestoneIndex: 0,
        milestoneId: 'greeting',
        stageIndex: 0,
      },
      milestones: [{ milestoneId: 'greeting', status: 'active' }],
      collected: { greeting: { decisions: [] } },
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
    milestones: [
      {
        id: 'greeting',
        title: 'Greeting',
        stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
      },
    ],
    role: 'discussion',
    actions: ['chat'],
    needsOpening: opening,
    files: ['PLAN.md'],
    busy: false,
    messages: openingText ? [{ role: 'assistant', text: openingText }] : [],
    roleRun: null,
    decisions: [],
    questions: [],
    evaluation: null,
    ...(application
      ? { application: { title: 'Guide preview', description: 'A synthetic application.' } }
      : {}),
  } as unknown as LearningView;
  const workbench = {
    environmentId: view.environmentId!,
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
      body: `<!doctype html><label>Preview task<input aria-label="Preview task"></label>
        <button style="position:fixed;bottom:16px;right:16px;padding:8px 16px">Send message</button>`,
    }),
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
          companions: explanationBoard,
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
    if (body?.action === 'open' && failOpen?.()) {
      return route.fulfill({ status: 503, json: { error: 'Study unavailable' } });
    }
    if (url.pathname.endsWith('/onboarding')) {
      view.onboardingCompleted = true;
      return route.fulfill({ json: { onboardingCompleted: true } });
    }
    if (url.pathname.endsWith('/workspace')) return route.fulfill({ json: workbench });
    if (url.searchParams.has('file'))
      return route.fulfill({ json: { text: 'A saved plan.', hash: 'a'.repeat(64) } });
    if (body?.command) {
      commands.push(body.command.type);
      if (body.command.type === 'prepare') {
        if (failFirstPrepare && commands.filter((command) => command === 'prepare').length === 1) {
          return route.fulfill({ status: 503, json: { error: 'Preparation failed' } });
        }
        await prepareGate;
        view.environment = { state: 'running', ready: true };
        view.revision++;
        if (!lagPreparationWorkbench) workbench.revision = view.revision;
      }
      if (body.command.type === 'begin') {
        await beginGate;
        view.needsOpening = false;
        view.busy = true;
        view.roleRun = { status: 'running', failure: null, canRetry: false };
        view.revision++;
        workbench.revision = view.revision;
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
  return { view, workbench, commands, calls, applicationCalls, publish, publishRaw, stageId };
}

for (const scenario of ['cold start', 'restore', 'retry prepare', 'retry open'] as const) {
  test(`application launch overlay allows ${scenario} to finish`, async ({
    page,
    learningEvents,
  }) => {
    let release!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = scenario === 'restore';
    let openBlocked = scenario === 'retry open';
    const fixture = await project(page, learningEvents, {
      started: true,
      completed,
      explanationBoard: true,
      environmentReady: false,
      prepareGate,
      failOpen: () => openBlocked,
      failFirstPrepare: scenario === 'retry prepare',
    });
    const openCount = () => fixture.calls.filter((call) => call === 'POST /api/pbl/v3 open').length;
    let beforeRetry = 0;
    const overlay = page.getByTestId('pbl-application-launching');
    try {
      if (scenario === 'retry open') {
        await expect(page.getByRole('alert').filter({ hasText: 'Request failed.' })).toBeVisible();
        await expect(overlay).toBeHidden();
        beforeRetry = openCount();
        openBlocked = false;
        await page.getByRole('button', { name: 'Refresh progress', exact: true }).click();
      } else if (completed || scenario === 'retry prepare') {
        const setup = page.getByTestId('pbl-environment-setup');
        const action = setup.getByRole('button');
        if (scenario === 'retry prepare')
          await expect(
            page.getByRole('alert').filter({ hasText: 'Request failed.' }),
          ).toBeVisible();
        await expect(action).toBeEnabled();
        await expect(overlay).toBeHidden();
        expect(fixture.commands).toEqual(completed ? [] : ['prepare']);
        await action.click();
      }
      await expect.poll(() => fixture.commands.length).toBe(scenario === 'retry prepare' ? 2 : 1);
      await expect(overlay).toBeVisible();
    } finally {
      release();
    }
    await expect.poll(() => fixture.view.environment?.ready).toBe(true);
    await fixture.publish();
    await expect.poll(() => fixture.applicationCalls).toContain('open');
    await expect(overlay).toBeHidden();
    expect(fixture.applicationCalls.filter((action) => action === 'open')).toHaveLength(1);
    expect(fixture.commands).toEqual(
      scenario === 'retry prepare' ? ['prepare', 'prepare'] : ['prepare'],
    );
    if (scenario === 'retry open') expect(openCount()).toBe(beforeRetry + 1);
  });
}

const assistantModes = ['bubble', 'window', 'docked'] as const;

async function useAssistantMode(page: Page, mode: (typeof assistantModes)[number]) {
  if (mode === 'bubble') return;
  await page.getByTestId('pbl-companion-avatar').click();
  if (mode === 'docked') await page.getByTestId('pbl-assistant-dock').click();
}

for (const layout of [...assistantModes, 'scrolled dock', 'open history'] as const) {
  test(`project completion hands focus to the available report in the ${layout} layout`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const mode = layout === 'scrolled dock' || layout === 'open history' ? 'docked' : layout;
    if (mode === 'bubble') await page.emulateMedia({ reducedMotion: 'reduce' });
    const { view, publish, calls } = await project(page, learningEvents, {
      started: true,
      explanationBoard: true,
    });
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await useAssistantMode(page, mode);
    view.state.position.stageIndex = 6;
    view.role = 'mentor';
    view.stage = {
      kind: 'mentor_say',
      agent: 'mentor',
      say: 'Recap',
      reads: [],
      studentActions: [],
    };
    view.actions = [];
    view.conversation = [
      {
        id: 'closing-recap',
        speaker: 'mentor',
        currentStage: true,
        status: 'running',
        parts: [
          { kind: 'text', id: 'reflection', text: 'You tested your greeting.', streaming: true },
        ],
      },
    ];
    view.busy = true;
    view.revision++;
    await publish();
    const turn = view.conversation[0]!;
    if (layout === 'scrolled dock') {
      view.conversation.unshift({
        id: 'previous-reply',
        speaker: 'discussion',
        status: 'succeeded',
        parts: [{ kind: 'text', id: 'earlier-text', text: readingParagraphs() }],
      });
      view.revision++;
      await publish();
      await readPassage(page, 60);
    }
    if (layout === 'open history') {
      view.conversationHistory = [{ sessionId: 'discussion', role: 'discussion', through: 8 }];
      await page.route('**/api/pbl/v3/history?**', (route) =>
        route.fulfill({ json: { through: 8, nextBefore: null, conversation: [] } }),
      );
      view.revision++;
      await publish();
      await page.getByRole('button', { name: 'Conversation history' }).click();
      await expect(page.getByRole('dialog', { name: 'Conversation history' })).toBeVisible();
    }
    const dialog = page.locator('[data-pbl-completion-dialog]');
    const header = page.locator('[data-pbl-tour="report"]');
    const chat = page.locator('.pbl-conversation-scroll [data-pbl-report-handoff]');
    await expect(dialog).toHaveCount(0);
    view.state.status = 'completed';
    view.reportAvailable = true;
    view.revision++;
    await publish();
    await expect(header).toBeDisabled();
    await expect(dialog).toHaveCount(0);

    turn.parts = [
      { kind: 'text', id: 'reflection', text: 'You tested your greeting.' },
      {
        kind: 'tool',
        id: 'finish',
        action: 'complete',
        status: 'succeeded',
        projectCompleted: true,
      },
    ];
    turn.status = 'succeeded';
    view.busy = false;
    view.revision++;
    await publish();
    if (layout === 'open history') {
      await expect(chat).toBeAttached();
      const history = page.getByRole('dialog', { name: 'Conversation history' });
      await expect(dialog).toHaveCount(0);
      await page.keyboard.press('Tab');
      await expect
        .poll(() => history.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press('Escape');
      await expect(history).toHaveCount(0);
    }
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByRole('button', { name: /report/i })).toBeFocused();
    expect(calls.some((call) => call.includes('/report'))).toBe(false);
    if (mode === 'window')
      await page.screenshot({ path: testInfo.outputPath('completion-dialog.png') });
    if (mode === 'window')
      await dialog.getByRole('button', { name: 'Stay in the workbench' }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const target = mode === 'bubble' || layout === 'scrolled dock' ? header : chat;
    await expect(target).toBeFocused();
    if (mode === 'window')
      await page.screenshot({ path: testInfo.outputPath('returned-to-report.png') });
    view.revision++;
    await publish();
    await expect(target).toBeFocused();
    await expect(dialog).toHaveCount(0);
    if (mode === 'bubble') {
      await page.reload();
      await page.getByTestId('pbl-v3-entry').getByRole('button').first().click();
      await expect(header).toBeEnabled();
      await expect(dialog).toHaveCount(0);
    }
  });
}

async function expectGuideTarget(page: Page, step: string, selector: string) {
  await expect(page.getByTestId('workspace-tour')).toHaveAttribute('data-step', step);
  const target = page.locator(selector);
  await expect(target).toBeInViewport();
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const hole = document.querySelector('[data-testid="workspace-tour-hole"]');
        if (!hole || hole.classList.contains('ws-tour-hole-none')) return false;
        const r = element.getBoundingClientRect();
        const light = hole.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return light.left < x && x < light.right && light.top < y && y < light.bottom;
      }),
    )
    .toBe(true);
}

for (const mode of assistantModes) {
  for (const waitingToStart of [true, false]) {
    test(`companion guide follows the ${mode} layout ${waitingToStart ? 'before start' : 'during study'}`, async ({
      page,
      learningEvents,
    }) => {
      const automatic = mode === 'bubble' && waitingToStart;
      const { commands } = await project(page, learningEvents, {
        started: !automatic,
        guideCompleted: !automatic,
        explanationBoard: true,
        opening: waitingToStart,
      });
      await useAssistantMode(page, mode);
      const paneOpen = mode !== 'bubble';
      const surface = paneOpen ? '[data-pbl-tour="conversation"]' : '[data-testid="pbl-companion"]';
      const draft = page.locator(surface).getByRole('textbox');
      if (!waitingToStart) await draft.fill('Keep my draft.');
      const replay = page.locator('[data-pbl-tour="replay"]');
      if (!automatic) await replay.click();
      const next = page.getByTestId('workspace-tour-next');
      await expect(page.getByTestId('workspace-tour')).toHaveAttribute('data-step', 'welcome');
      await next.click();
      await expectGuideTarget(page, 'preview', '[data-testid="pbl-application-panel"]');
      await next.click();
      const avatar = '[data-testid="pbl-companion-avatar"]';
      await expectGuideTarget(
        page,
        paneOpen ? 'conversationPane' : 'companion',
        paneOpen ? surface + ' > header' : avatar,
      );
      await next.click();
      await expectGuideTarget(
        page,
        paneOpen ? 'learningPath' : 'progress',
        paneOpen ? '[data-pbl-tour="learning-path"]' : avatar,
      );
      await next.click();
      if (paneOpen && waitingToStart) {
        await expectGuideTarget(page, 'collapsePane', '[data-testid="pbl-assistant-close"]');
      } else if (paneOpen) {
        await expectGuideTarget(page, 'reply', '[data-pbl-tour="composer"]');
      } else {
        await expectGuideTarget(page, 'controls', '[data-testid="pbl-companion-mute"]');
      }
      await next.click();
      await expectGuideTarget(page, 'layout', '[data-testid="pbl-board-toggle"]');
      await next.click();
      if (waitingToStart)
        await expectGuideTarget(page, 'start', surface + ' [data-pbl-tour="start"]');
      else await expectGuideTarget(page, 'replay', '[data-pbl-tour="replay"]');
      await page.getByTestId('workspace-tour-done').click();
      await expect(page.getByTestId('workspace-tour')).toHaveCount(0);
      await expect(page.locator(surface)).toBeVisible();
      if (mode === 'window') await expect(page.getByTestId('pbl-assistant-window')).toBeVisible();
      if (mode === 'docked') await expect(page.getByTestId('pbl-companion-avatar')).toHaveCount(0);
      if (waitingToStart)
        await expect(page.locator(surface + ' [data-pbl-tour="start"]')).toBeEnabled();
      else await expect(draft).toHaveValue('Keep my draft.');
      expect(commands).toEqual([]);
    });
  }
}

test('keeps one draft across companion layouts and closes the last file from its tab', async ({
  page,
  learningEvents,
}) => {
  await project(page, learningEvents, { started: true, explanationBoard: true });
  const draft = 'Compare the implementation with the plan.';
  const bubble = page.getByTestId('pbl-companion-input');
  await bubble.getByRole('textbox').fill(draft);
  await page.getByTestId('pbl-companion-avatar').click();
  const assistant = page.getByTestId('pbl-assistant');
  await expect(assistant.getByRole('textbox')).toHaveValue(draft);
  await page.getByTestId('pbl-assistant-dock').click();
  await expect(assistant.getByRole('textbox')).toHaveValue(draft);
  const toggle = page.getByRole('button', { name: 'Toggle code workspace', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
  const ide = page.getByTestId('pbl-ide');
  const tabs = ide.getByRole('tablist', { name: 'Open files' });
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect
    .poll(() =>
      assistant
        .locator('header')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    )
    .toBe(36);
  await expect
    .poll(() => tabs.evaluate((el) => el.parentElement!.getBoundingClientRect().height))
    .toBe(36);
  await tabs.getByRole('button', { name: 'Close PLAN.md', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(assistant.getByRole('textbox')).toHaveValue(draft);
  await toggle.click();
  await expect(tabs.getByRole('tab', { name: 'PLAN.md', exact: true })).toBeVisible();
  await page.getByTestId('pbl-assistant-close').click();
  await expect(bubble.getByRole('textbox')).toHaveValue(draft);
});

for (const closeWith of ['last file', 'workspace toggle'] as const) {
  test(`preserves a returning learner's drafts after closing the ${closeWith} and reloading`, async ({
    page,
    learningEvents,
  }) => {
    const { view } = await project(page, learningEvents, { started: true, explanationBoard: true });
    const key = `maic:pbl-draft:v1:${view.id}:ui`;
    const draft = {
      text: 'Compare the plan',
      textRevision: 7,
      quizAnswers: { key: 'greeting:5', values: [null, 1] },
      decisionDrafts: {
        'greeting:direction': { chosen: 'North', rationale: 'It matches the goal' },
      },
      showWorkspace: true,
      showAssistant: false,
    };
    await page.evaluate(({ key, draft }) => sessionStorage.setItem(key, JSON.stringify(draft)), {
      key,
      draft,
    });
    const reopen = async () => {
      await page.reload();
      await page.locator('[data-testid="pbl-v3-entry"] button').first().click();
    };
    await reopen();
    const composer = page.getByTestId('pbl-companion-input').getByRole('textbox');
    const toggle = page.getByRole('button', { name: 'Toggle code workspace', exact: true });
    await expect(composer).toHaveValue(draft.text);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    if (closeWith === 'last file') {
      await page.getByRole('button', { name: 'Close PLAN.md', exact: true }).click();
    } else {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(composer).toHaveValue(draft.text);
    await composer.press('End');
    await composer.press('!');
    await reopen();
    await expect(composer).toHaveValue(draft.text + '!');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), key)).toEqual({
      ...draft,
      text: draft.text + '!',
      textRevision: draft.textRevision + 1,
      showWorkspace: false,
      showAssistant: true,
    });
  });
}

for (const mode of assistantModes) {
  test(`decision controls in the ${mode} match the tutor's named action`, async ({
    page,
    learningEvents,
  }) => {
    let begin!: () => void;
    const fixture = await project(page, learningEvents, {
      started: true,
      explanationBoard: true,
      beginGate: new Promise<void>((resolve) => {
        begin = resolve;
      }),
    });
    const { view } = fixture;
    await useAssistantMode(page, mode);
    view.needsOpening = true;
    view.state.position.stageIndex = 1;
    view.stage = {
      kind: 'dialogue',
      agent: 'discussion',
      reads: [],
      collects: 'decisions',
      studentActions: ['chat', 'decide'],
    };
    view.actions = ['chat', 'decide'];
    view.decisions = [
      {
        id: 'direction',
        prompt: 'Choose a direction',
        requiresRationale: true,
        options: [{ id: 'a', label: 'North' }],
      },
    ];
    view.revision++;
    await fixture.publish();
    await expect.poll(() => fixture.commands.includes('begin')).toBe(true);
    const bubbleTask = page.getByTestId('pbl-companion-task');
    if (mode === 'bubble') {
      await expect(bubbleTask).toHaveCount(0);
      await expect(page.getByTestId('pbl-companion-speech')).toContainText('Opening this step');
    } else {
      await page.getByRole('button', { name: 'Current task', exact: true }).click();
      await expect(page.getByTestId('pbl-decision-response')).toBeVisible();
    }
    begin();
    await expect.poll(() => view.busy).toBe(true);
    const introduction = 'Choose a direction and explain your choice.';
    view.conversation = [
      {
        id: 'decision-opening',
        currentStage: true,
        speaker: 'discussion',
        status: 'running',
        parts: [{ id: 'opening-text', kind: 'text', text: introduction }],
      },
    ];
    view.revision++;
    await fixture.publish();
    if (mode === 'bubble') {
      await expect(page.getByTestId('pbl-companion-speech')).toContainText('Choose');
      await expect(bubbleTask).toHaveCount(0);
    }
    view.busy = false;
    view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
    view.conversation[0].status = 'succeeded';
    view.revision++;
    await fixture.publish();
    const form = page.getByTestId('pbl-decision-response').filter({ visible: true });
    await form.getByRole('button', { name: 'North' }).click();
    await form.getByRole('textbox').fill('It matches the goal.');
    await form.getByRole('button', { name: 'Submit decision', exact: true }).click();
    await expect.poll(() => fixture.commands.filter((c) => c === 'decide').length).toBe(1);
  });
}

for (const mode of assistantModes) {
  test(`quiz in the ${mode} marks only the last submitted option`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents, { started: true, explanationBoard: true });
    const { view } = fixture;
    const publish = async () => {
      view.revision++;
      await fixture.publish();
    };
    view.state.position.stageIndex = 5;
    view.stage = { kind: 'check', checker: 'quiz' };
    view.role = 'mentor';
    view.actions = ['quiz'];
    const question: LearningView['questions'][number] = {
      q: 'Which direction?',
      options: ['East', 'West'],
    };
    view.questions = [question];
    await publish();
    await useAssistantMode(page, mode);
    if (mode !== 'bubble')
      await page.getByRole('button', { name: 'Current task', exact: true }).click();
    const form =
      mode === 'bubble'
        ? page.getByTestId('pbl-companion-quiz')
        : page.getByRole('region', { name: 'Current task details' });
    const east = form.getByRole('radio', { name: /East/ });
    const west = form.getByRole('radio', { name: /West/ });
    const correct = form.getByRole('radio', { name: /Last submission: correct/ });
    const incorrect = form.getByRole('radio', { name: /Last submission: review this answer/ });
    await east.check();
    await expect(correct).toHaveCount(0);
    await expect(incorrect).toHaveCount(0);
    await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect.poll(() => fixture.commands.filter((c) => c === 'quiz').length).toBe(1);
    const collected = view.state.collected.greeting!;
    collected.quiz = {
      id: 'first',
      attempt: 1,
      answers: [0],
      passed: false,
      score: 0,
      total: 1,
      wrong: [0],
    };
    question.feedback = { selectedAnswer: 0, passed: false };
    await publish();
    await expect(incorrect).toBeChecked();
    await west.check();
    await expect(west).toBeChecked();
    await expect(incorrect).not.toBeChecked();
    await expect(east).toHaveAccessibleName(/Last submission: review this answer/);
    await expect(correct).toHaveCount(0);
    await expect(
      form.getByText('Selection changed. Submit again to update feedback.'),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Submit changes', exact: true }).click();
    await expect.poll(() => fixture.commands.filter((c) => c === 'quiz').length).toBe(2);
    collected.quiz = {
      id: 'second',
      attempt: 2,
      answers: [1],
      passed: true,
      score: 1,
      total: 1,
      wrong: [],
    };
    question.feedback = { selectedAnswer: 1, passed: true };
    await publish();
    await expect(west).toHaveAccessibleName(/Last submission: correct/);
    await expect(correct).toBeChecked();
    await expect(incorrect).toHaveCount(0);

    // Older attempts can have a question verdict without a recorded option index.
    delete collected.quiz.answers;
    delete question.feedback.selectedAnswer;
    await publish();
    await expect(form.getByTestId('pbl-quiz-feedback')).toContainText('Last submission: correct');
    await expect(correct).toHaveCount(0);
  });
}

for (const previous of ['tests', 'quiz'] as const) {
  test(`retires companion instructions when leaving ${previous} without removing history`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents, { started: true, explanationBoard: true });
    const view = fixture.view;
    const publish = async () => {
      view.revision++;
      view.activitySequence = (view.activitySequence ?? 0) + 1;
      await fixture.publish();
    };
    const oldText = previous === 'tests' ? 'Run the checks again.' : 'Submit the answers.';
    const old: NonNullable<LearningView['conversation']>[number] = {
      id: 'previous-turn',
      currentStage: true,
      speaker: previous === 'tests' ? 'coder' : 'mentor',
      status: 'succeeded',
      parts: [
        { kind: 'text', id: 'old-text', text: oldText },
        {
          kind: 'tool',
          id: 'old-cue',
          name: 'cue_user',
          action: 'tool',
          status: 'succeeded',
          args: { options: ['Show me how', 'I am ready'] },
        },
      ],
    };
    const questions = [1, 2, 3].map((i) => ({ q: `Question ${i}?`, options: ['Yes', 'No'] }));
    view.conversation = [old];
    view.questions = previous === 'quiz' ? questions : [];
    view.actions = previous === 'quiz' ? ['quiz', 'next'] : ['chat', 'next'];
    view.state.position.stageIndex = previous === 'tests' ? 4 : 5;
    view.stage = { kind: 'check', checker: previous };
    view.role = previous === 'tests' ? 'coder' : 'mentor';
    await publish();
    const bubble = page.getByTestId('pbl-companion-speech');
    const suggestions = page.getByTestId('pbl-companion-suggestions');
    await expect(bubble).toContainText(oldText);
    if (previous === 'tests') await expect(suggestions).toContainText('Show me how');

    delete old.currentStage;
    view.state.position.stageIndex++;
    view.stage =
      previous === 'tests'
        ? { kind: 'check', checker: 'quiz' }
        : {
            kind: 'mentor_say',
            agent: 'mentor',
            say: 'Recap',
            reads: [],
            studentActions: ['chat'],
          };
    view.role = 'mentor';
    view.questions = previous === 'tests' ? questions : [];
    view.actions = previous === 'tests' ? ['quiz'] : ['chat'];
    await publish();
    const quiz = page.getByTestId('pbl-companion-quiz');
    if (previous === 'tests') await expect(quiz).toContainText('Question 3?');
    else await expect(quiz).toBeHidden();
    await expect(bubble).not.toContainText(oldText);
    await expect(suggestions).toBeHidden();
    const newText = previous === 'tests' ? 'Choose an answer.' : 'Explain your result.';
    view.conversation.push({
      id: 'next-turn',
      currentStage: true,
      speaker: 'mentor',
      status: 'succeeded',
      parts: [{ kind: 'text', id: 'next-text', text: newText }],
    });
    await publish();
    await expect(bubble).toContainText(newText);
    await page.getByTestId('pbl-companion-avatar').click();
    await expect(
      page.getByTestId('pbl-assistant').getByText(oldText, { exact: true }),
    ).toBeVisible();
  });
}

test('the tutor companion opens a board and moves its conversation between window and dock', async ({
  page,
  learningEvents,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await project(page, learningEvents, {
    started: true,
    explanationBoard: true,
    openingText: 'We will design a greeting before writing it.',
  });
  const avatar = page.getByTestId('pbl-companion-avatar');
  await expect(avatar).toBeVisible();
  const boardToggle = page.getByTestId('pbl-board-toggle');
  await boardToggle.click();
  await expect(page.getByTestId('pbl-explain-board')).toBeVisible();
  await testInfo.attach('tutor-and-board', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await boardToggle.click();
  await expect(page.getByTestId('pbl-explain-board')).toBeHidden();
  await avatar.click();
  const conversation = page.getByTestId('pbl-assistant');
  await expect(conversation).toBeVisible();
  await expect(conversation.locator('[data-window-drag]')).toHaveCount(1);
  await page.getByTestId('pbl-assistant-dock').click();
  await expect(conversation).toBeVisible();
  await expect(conversation.locator('[data-window-drag]')).toHaveCount(0);
  await page.getByTestId('pbl-assistant-close').click();
  await expect(avatar).toBeVisible();
});

test('keeps the preview footer reachable while the companion conversation follows the workbench', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await project(page, learningEvents, { started: true, explanationBoard: true });
  const avatar = page.getByTestId('pbl-companion-avatar');
  await expect(avatar).toBeVisible();
  const preview = page.getByTestId('pbl-application-open');
  if ((await preview.getAttribute('aria-expanded')) !== 'true') await preview.click();
  await expect(preview).toHaveAttribute('aria-expanded', 'true');
  const send = page
    .frameLocator('[data-testid="pbl-application-panel"] iframe')
    .getByRole('button', { name: 'Send message' });
  await send.click({ trial: true });
  await avatar.click();
  const workspace = page.locator('[data-pbl-tour-legacy="workspace-toggle"]');
  if ((await workspace.getAttribute('aria-pressed')) !== 'true') await workspace.click();
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1180, height: 730 },
    { width: 1280, height: 560 },
  ]) {
    await page.setViewportSize(size);
    await send.click({ trial: true });
    await avatar.click({ trial: true });
  }

  const win = page.getByTestId('pbl-assistant-window');
  const original = (await win.boundingBox())!;
  const header = (await win.locator('[data-window-drag]').boundingBox())!;
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + header.width / 2 - 160, header.y + header.height / 2 + 20, {
    steps: 5,
  });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;
  expect(moved.x).toBeLessThan(original.x - 100);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await win.boundingBox())?.x).toBe(moved.x);
  await expect.poll(async () => (await win.boundingBox())?.height).toBe(moved.height);
});

test('folds adjacent failed tools after the final call settles and keeps the errors inspectable', async ({
  page,
  learningEvents,
}) => {
  const fixture = await project(page, learningEvents, { started: true, application: false });
  const read = (id: string, status: 'failed' | 'running') => ({
    kind: 'tool' as const,
    id,
    action: 'read' as const,
    status,
    args: { path: id },
    result: 'Could not read ' + id,
  });
  const first = read('a.txt', 'failed'),
    second = read('b.txt', 'running');
  fixture.view.conversation = [
    { id: 'inspection', speaker: 'coder', status: 'running', parts: [first, second] },
  ];
  const publish = async () => {
    fixture.view.activitySequence++;
    await fixture.publish();
  };
  await publish();
  const group = page.getByTestId('workbench-tool-group');
  await expect(group).toHaveAttribute('data-open', 'true');
  second.status = 'failed';
  await publish();
  await expect(group).toHaveAttribute('data-open', 'false');
  const header = group.getByRole('button', { name: '2 tool calls · 2 failed' });
  await header.click();
  await group.getByRole('button', { name: /a.txt/ }).click();
  await expect(group.getByText('Could not read a.txt')).toBeVisible();
  await publish();
  await expect(group).toHaveAttribute('data-open', 'true');
  fixture.view.conversation[0]!.parts = [
    first,
    { id: 'note', kind: 'text', text: 'Inspect the second path.' },
    second,
  ];
  await publish();
  await expect(group).toHaveCount(0);
  await expect(page.getByTestId('workbench-tool-card')).toHaveCount(2);
});

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

for (const [width, guideCompleted] of [[1365, false]] as const) {
  test(`first entry waits for Start learning, then follows normally at ${width}px (tour completed: ${guideCompleted})`, async ({
    page,
    learningEvents,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const beginGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await project(page, learningEvents, {
      application: false,
      guideCompleted,
      opening: true,
      beginGate,
    });
    if (!guideCompleted) {
      await expect(tour(page)).toBeVisible();
      await expect(page.locator('#pbl-start-blocked-project')).toHaveText(
        'Finish or close the workspace guide to start learning.',
      );
      expect(fixture.commands).toEqual([]);
      await page.keyboard.press('Escape');
    }
    const start = page.getByRole('button', { name: 'Start learning', exact: true });
    await expect(start).toBeEnabled();
    await expect(page.getByTestId('pbl-agent-turn')).toHaveCount(0);
    await expect(page.locator('.pbl-conversation-scroll')).toHaveCount(0);
    await page.locator('#pbl-project-overview summary').click();
    await fixture.publish();
    expect(fixture.commands).toEqual([]);
    await start.click();
    // Feedback must precede the HTTP acknowledgment, not wait for stream output.
    await expect(page.getByTestId('pbl-agent-turn')).toBeVisible();
    await expect(start).toHaveCount(0);
    await expect(page.getByTestId('pbl-assistant')).toBeFocused();
    await expect(page.getByTestId('pbl-assistant')).toHaveCSS('outline-style', 'none');
    await expect(page.getByTestId('pbl-assistant').locator(':scope > header')).toHaveCSS(
      'box-shadow',
      'none',
    );
    expect(fixture.commands).toEqual(['begin']);
    release();
    await expect.poll(() => fixture.view.needsOpening).toBe(false);
    const viewport = page.locator('.pbl-conversation-scroll');
    const distance = () =>
      viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    for (let chunk = 0; chunk < 3; chunk++) {
      fixture.view.messages = [
        { role: 'assistant', text: `Welcome chunk ${chunk}.\n\n`.repeat(60 + chunk * 10) },
      ];
      fixture.view.revision++;
      await fixture.publish();
      await expect(viewport).toContainText(`Welcome chunk ${chunk}.`);
      await expect.poll(distance).toBeLessThanOrEqual(8);
    }
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -250);
    const latest = page.getByTestId('pbl-conversation-scroll-button');
    await expect(latest).toBeVisible();
    const reading = await viewport.evaluate((el) => el.scrollTop);
    fixture.view.messages[0].text += 'While reading earlier text.\n\n'.repeat(20);
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('While reading earlier text.');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(reading, 0);
    await latest.click();
    await expect.poll(distance).toBeLessThanOrEqual(8);
    fixture.view.busy = false;
    fixture.view.roleRun = { status: 'succeeded', failure: null, canRetry: false };
    await fixture.publish();
    await page.mouse.wheel(0, -250);
    await expect(latest).toBeVisible();
    await page.getByLabel('Your message', { exact: true }).fill('I am ready.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(distance).toBeLessThanOrEqual(8);
    expect(fixture.commands).toEqual(['begin', 'chat']);
  });
}

for (const [target, key] of [['overview summary', 'PageDown']] as const) {
  test(`keyboard scrolling from the ${target} preserves reading during normal replies`, async ({
    page,
    learningEvents,
  }) => {
    const fixture = await project(page, learningEvents, {
      application: false,
      guideCompleted: true,
      openingText: 'Opening background.\n\n'.repeat(60),
    });
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    const viewport = page.locator('.pbl-conversation-scroll');
    // Read earlier material using the normal scroll mechanism, with no opening hold.
    await viewport.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
    const control = page.locator('#pbl-project-overview summary');
    // Isolate the native scrolling key from focus's optional automatic scroll.
    // PageDown/Space moves one page, so wait for scrollend and retain that passage.
    await control.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await expect(control).toBeFocused();
    await viewport.evaluate((el) =>
      el.addEventListener(
        'scrollend',
        () => el.setAttribute('data-keyboard-scroll-ended', 'true'),
        { once: true },
      ),
    );
    await page.keyboard.press(key);
    await expect(viewport).toHaveAttribute('data-keyboard-scroll-ended', 'true');
    const reading = await viewport.evaluate((el) => el.scrollTop);
    expect(reading).toBeGreaterThan(0);
    const distance = () =>
      viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(distance).toBeGreaterThan(8);
    fixture.view.messages[0].text += '\n\nMore text after keyboard navigation.\n\n'.repeat(20);
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('More text after keyboard navigation.');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(reading, 0);
    await page.getByTestId('pbl-conversation-scroll-button').click();
    await expect.poll(distance).toBeLessThanOrEqual(8);
    fixture.view.messages[0].text += '\n\nFollowing after keyboard reading.';
    fixture.view.revision++;
    await fixture.publish();
    await expect(viewport).toContainText('Following after keyboard reading.');
    await expect.poll(distance).toBeLessThanOrEqual(8);
  });
}

test('highlights the existing next action only when progression is available', async ({
  page,
  learningEvents,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  await expect(advance).toHaveCSS('animation-name', 'none');
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
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const anchors = document.querySelectorAll(selector);
        const spotlight = '[data-pbl-onboarding="spotlight"]';
        if (!anchors.length) return !document.querySelector(spotlight);

        // The browser accounts for clipping by nested scroll containers.
        return new Promise<boolean>((resolve) => {
          const observer = new IntersectionObserver((entries) => {
            observer.disconnect();
            const boxes = Array.from(document.querySelectorAll(spotlight), (el) =>
              el.getBoundingClientRect(),
            );
            if (!boxes.length) {
              resolve(
                entries.every(
                  ({ intersectionRect }) => !intersectionRect.width || !intersectionRect.height,
                ),
              );
              return;
            }
            const bounds = Array.from(anchors, (anchor) => anchor.getBoundingClientRect());
            resolve(
              boxes.every((box) =>
                bounds.some(
                  (anchor) =>
                    Math.min(box.right, anchor.right) > Math.max(box.left, anchor.left) &&
                    Math.min(box.bottom, anchor.bottom) > Math.max(box.top, anchor.top),
                ),
              ),
            );
          });
          anchors.forEach((anchor) => observer.observe(anchor));
        });
      }, selector),
    )
    .toBe(true);
}

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
    await loading.click({ position: { x: 10, y: 10 } });
    await expect(loading).toBeVisible();
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
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
      await expect(
        page.getByRole('heading', {
          name: 'Workspace guide',
          exact: true,
          level: 2,
          includeHidden: true,
        }),
      ).toHaveText('Workspace guide');
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

for (const event of ['online']) {
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
  fixture.view.state.position.stageIndex = 1;
  fixture.view.revision++;
  await fixture.publish();
  await expect(page.locator('[data-pbl-tour="progress"]')).toContainText('2/7');
  await correctSpotlight(page, '[data-pbl-tour="task"]');
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
  const workspaceToggle = 'button[aria-label="Toggle code workspace"]';
  await page.locator(workspaceToggle).click();
  await expect(page.locator(workspaceToggle)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-pbl-tour="replay"]').click();
  await next(page).click();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'code');
  await correctSpotlight(page, workspaceToggle);
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('[data-pbl-tour="replay"]')).toBeFocused();
});

test('narrow conversation jump control stays centered without widening either message gutter', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: COMPACT_WORKBENCH_WIDTH, height: 844 });
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
  [1365, 900, 'en-US', false],
  [COMPACT_WORKBENCH_WIDTH, 480, 'ar-SA', false],
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
    await expect
      .poll(() => page.getByTestId('pbl-v3-workspace').evaluate((owner) => owner.scrollTop))
      .toBe(0);
    const selectors = [
      '[data-pbl-tour="task"]',
      '[data-pbl-tour="conversation"]',
      '[data-testid="pbl-ide"]',
      '[data-testid="pbl-application-panel"], [data-testid="pbl-application-open"]',
      '[data-pbl-tour="replay"]',
    ];
    const steps = ['progress', 'discussion', 'code', 'application', 'replay'];
    for (let i = 0; i < 5; i++) {
      await expect(tour(page)).toHaveAttribute('data-step', steps[i]);
      await correctSpotlight(page, selectors[i]);
      if (i === 0 && width === 1365) {
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
        expect(lit.x + lit.width).toBeGreaterThanOrEqual(
          Math.min(visibleRight, task.x + task.width),
        );
        expect(lit.height).toBeGreaterThanOrEqual(task.height);
        expect(
          Math.max(
            0,
            Math.min(card.x + card.width, task.x + task.width) - Math.max(card.x, task.x),
          ) *
            Math.max(
              0,
              Math.min(card.y + card.height, task.y + task.height) - Math.max(card.y, task.y),
            ),
        ).toBe(0);
      }
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

for (const success of [false]) {
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
    await expect(
      page.getByRole('heading', {
        name: 'Workspace guide',
        exact: true,
        level: 2,
        includeHidden: true,
      }),
    ).toHaveText('Workspace guide');
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

test('compact short desktop docked assistant spotlight stays within its scroll viewport while scrolling', async ({
  page,
  learningEvents,
}) => {
  await page.setViewportSize({ width: COMPACT_WORKBENCH_WIDTH, height: 480 });
  await project(page, learningEvents);
  await expect(tour(page)).toBeVisible();
  await finish(page);
  await page.getByRole('button', { name: 'Exit fullscreen workspace', exact: true }).click();
  await page.locator('[data-pbl-tour="replay"]').click();
  await next(page).click();
  await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
  const split = page.getByTestId('pbl-workbench-split');
  await expect
    .poll(() =>
      split.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const lit = document
          .querySelector('[data-pbl-onboarding="spotlight"]')
          ?.getBoundingClientRect();
        return (
          !!lit &&
          lit.width > 0 &&
          lit.height > 0 &&
          lit.left >= viewport.left - 1 &&
          lit.top >= viewport.top - 1 &&
          lit.right <= viewport.right + 1 &&
          lit.bottom <= viewport.bottom + 1
        );
      }),
    )
    .toBe(true);
  await split.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-pbl-onboarding="spotlight"]')).toHaveCount(0);
});

for (const [width, height] of [[1365, 480]] as const) {
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
    expect(
      card.x + card.width <= viewport.x + 1 ||
        card.x >= viewport.x + viewport.width - 1 ||
        card.y + card.height <= viewport.y + 1 ||
        card.y >= viewport.y + viewport.height - 1,
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('assistant-visible.png') });
  });
}

for (const [width, height] of [[1365, 900]] as const) {
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
    // Opening and later replies follow normally. Read upward, then resume with Latest.
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    await viewport.hover();
    await page.mouse.wheel(0, -250);
    await expect(latest).toBeVisible();
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

for (const [width, height, gesture] of [[1365, 480, 'touch']] as const) {
  test(`the guide allows reading a growing multi-paragraph welcome and its closing question at ${width}x${height} with ${gesture} and wheel`, async ({
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
    if (height <= 568) {
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
      if (revision === 1) {
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
            (card.x + card.width <= reading.x + 1 ||
              card.x >= reading.x + reading.width - 1 ||
              card.y + card.height <= reading.y + 1 ||
              card.y >= reading.y + reading.height - 1)
          );
        })
        .toBe(true);
      await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    }
    if (height === 480) {
      // A smaller card must still let the learner read its full instructions.
      const instructions = tour(page).locator(':scope > div');
      const needsScroll = await instructions.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      );
      if (needsScroll) {
        await instructions.hover();
        await page.mouse.wheel(0, 6000);
      } else {
        await expect(instructions).toBeInViewport({ ratio: 1 });
      }
      await expect
        .poll(() =>
          instructions.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    const latest = page.getByTestId('pbl-conversation-scroll-button');
    const readingBox = (await viewport.boundingBox())!;
    await page.mouse.move(
      readingBox.x + readingBox.width / 2,
      readingBox.y + readingBox.height / 2,
    );
    await page.mouse.wheel(0, -180);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeGreaterThan(8);
    await expect(latest).toHaveCount(0);
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
    await expect(page.locator('#pbl-project-overview details')).not.toHaveAttribute('open');
    await expect(latest).toBeVisible();
    const readingHeight = await viewport.evaluate((el) => el.clientHeight);
    await latest.click();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(8);
    expect(await viewport.evaluate((el) => el.clientHeight)).toBe(readingHeight);
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

test.describe('compact touch reading', () => {
  test.use({
    viewport: { width: COMPACT_WORKBENCH_WIDTH, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('touch reading survives task details and resumes after returning to the tail', async ({
    page,
    learningEvents,
  }) => {
    await page.setViewportSize({ width: COMPACT_WORKBENCH_WIDTH, height: 844 });
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
    // Keep the finger inside the short conversation viewport. Dispatch
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

for (const checker of ['quiz'] as const) {
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
    fixture.view.state.position.stageIndex = 5;
    fixture.view.actions = ['quiz'];
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
  const f = await project(page, learningEvents, { started: true });
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
    files: (await ide
      .getByRole('navigation', { name: 'Project files', exact: true })
      .boundingBox())!,
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
    page.getByRole('separator', { name: 'Resize file explorer', exact: true }),
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
  const dividers = page.getByRole('separator', {
    name: 'Resize workspace and assistant',
    exact: true,
  });
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

for (const width of [COMPACT_WORKBENCH_WIDTH]) {
  test(`first-entry barrier hands off to a populated guide after a delayed snapshot at ${width}px`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await project(page, learningEvents, {
      environmentReady: false,
      prepareGate,
      lagPreparationWorkbench: true,
      opening: true,
      finishedWork: 'A complete application that preserves its saved records. '.repeat(45),
    });
    const loading = page.getByTestId('pbl-workbench-loading');
    await expect(loading).toBeVisible();
    release();
    await expect.poll(() => fixture.view.environment?.ready).toBe(true);
    // The prepare response has arrived, but the stream still has the prior revision.
    await expect(page.locator('[data-pbl-tour="replay"]')).toBeDisabled();
    await expect(loading).toBeVisible();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.locator('#pbl-project-overview')).toBeVisible();
    await expect(page.locator('#pbl-project-overview button').last()).toBeDisabled();
    // An HTTP view already exists; neither clicks nor Tab may reach the workspace
    // while its independently delivered matching snapshot is still missing.
    await loading.click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    );
    expect(fixture.commands).toEqual(['prepare']);
    fixture.workbench.environmentId = fixture.view.environmentId!;
    await fixture.publish();
    await expect(loading).toHaveCount(0);
    await expect(tour(page)).toHaveAttribute('data-step', 'progress');
    await next(page).click();
    await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    await expect(page.locator('#pbl-project-overview')).toBeVisible();
    await expect(page.locator('#pbl-project-overview button').last()).toBeDisabled();
    await correctSpotlight(page, '[data-testid="pbl-assistant"]');
    if (width === COMPACT_WORKBENCH_WIDTH) {
      const reading = page.getByTestId('pbl-project-start');
      const bounds = (await reading.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 25);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => reading.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(tour(page)).toHaveAttribute('data-step', 'discussion');
    }
    await page.screenshot({ path: testInfo.outputPath('overview-during-guide.png') });
    expect(fixture.commands).toEqual(['prepare']);
    await finish(page);
    await expect(page.getByRole('button', { name: 'Start learning', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start learning', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pbl-assistant')).toBeFocused();
    await expect(page.getByTestId('pbl-assistant').locator(':scope > header')).not.toHaveCSS(
      'box-shadow',
      'none',
    );
    await expect.poll(() => fixture.commands).toEqual(['prepare', 'begin']);
  });
}
