import { expect } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningReport } from '@/lib/pbl/v3/report';

test('completed project reports stay discoverable, show facts before analysis, and reopen a read-only workbench', async ({
  page,
  learningEvents,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('locale', 'en-US');
      localStorage.setItem('maic:account:settings-storage', settings);
    },
    createSettingsStorage({ sidebarCollapsed: false }),
  );
  const stageId = uniqueStageId('pbl-report');
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Report acceptance', createdAt: Date.now(), updatedAt: Date.now() },
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
            id: 'intro-slide',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            elements: [],
          },
        },
      },
      {
        id: 'project',
        stageId,
        type: 'pbl',
        title: 'Todo project',
        order: 1,
        content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.2.0' } },
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
  const steps = ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'];
  const view = {
    id: 'report-study',
    revision: 19,
    activitySequence: 20,
    title: 'Build a small todo application',
    reportAvailable: true,
    environmentId: 'report-environment',
    environment: { state: 'destroyed', ready: false },
    completedFilesAvailable: true,
    recovery: null,
    state: {
      status: 'completed',
      position: { milestoneIndex: 0, milestoneId: 'todo', stageIndex: 6 },
      milestones: [
        { milestoneId: 'todo', status: 'completed', completedStageIndexes: [0, 1, 2, 3, 4, 5, 6] },
      ],
      collected: { todo: { decisions: [], recapCompleted: true } },
      decisionRevisions: {},
      lastSequence: 40,
    },
    stage: {
      kind: 'mentor_say',
      agent: 'mentor',
      say: 'Reflect',
      skill: 'recap',
      studentActions: [],
    },
    milestones: [{ id: 'todo', title: 'A working todo list', optional: false, stages: steps }],
    role: 'mentor',
    actions: [],
    files: ['PLAN.md', 'src/todo.py'],
    busy: false,
    messages: [],
    roleRun: null,
    decisions: [],
    questions: [],
    evaluation: null,
    conversation: [],
  } as unknown as LearningView;
  const base: LearningReport = {
    formatVersion: 2,
    studyId: view.id,
    project: { id: 'todo', version: '1.4.2', title: view.title },
    revision: 19,
    requiredComplete: true,
    milestones: [
      {
        id: 'todo',
        title: 'A working todo list',
        optional: false,
        status: 'completed',
        stages: steps,
      },
    ],
    outcomes: [
      {
        milestoneId: 'todo',
        tests: 'passed',
        quiz: { score: 4, total: 4, attempt: 1 },
        reflected: true,
      },
    ],
    counts: {},
    facts: {
      learnerTurns: 14,
      assistantTurns: 18,
      decisions: 2,
      decisionChanges: 1,
      testRuns: 2,
      quizAttempts: 1,
      fileEdits: 5,
      interruptedRuns: 0,
    },
    summary: {
      completedMilestones: 1,
      totalMilestones: 1,
      completedSteps: 7,
      totalSteps: 7,
      concepts: ['Lists', 'Numbering', 'Input validation', 'Return values'],
      skills: [
        { id: 'decisions', milestoneIds: ['todo'] },
        { id: 'planReview', milestoneIds: ['todo'] },
        { id: 'codeReview', milestoneIds: ['todo'] },
        { id: 'verification', milestoneIds: ['todo'] },
        { id: 'reflection', milestoneIds: ['todo'] },
      ],
    },
    evidence: [
      {
        sequence: 9,
        at: 2,
        milestoneId: 'todo',
        kind: 'evaluation.recorded',
        detail: 'All nine behavior checks passed.',
      },
    ],
    conversations: [
      {
        role: 'mentor',
        milestone: 'todo',
        messages: [
          { sequence: 2, at: 1, role: 'user', text: 'I checked the number before deleting.' },
        ],
        truncated: false,
      },
    ],
    truncated: false,
    analysis: { status: 'not_generated', findings: [], omitted: false, canRetry: true },
  };
  let generated = false,
    generations = 0,
    opens = 0;
  const commands: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = {
    ...base,
    analysis: {
      status: 'ready' as const,
      findings: [
        {
          category: 'strength' as const,
          title: 'You connected a boundary to behavior',
          detail: 'Your validation decision preserved the list for invalid numbers.',
          evidence: ['turn:0:2'],
          quote: 'I checked the number before deleting.',
        },
      ],
      omitted: false,
      canRetry: false,
    },
  };
  await page.route('**/api/pbl/v3**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('project') === '1')
      return route.fulfill({
        json: {
          hero: {
            title: view.title,
            description: 'Review your saved project.',
            gains: ['Make decisions', 'Verify behavior'],
            instructorName: 'Project tutor',
            milestoneCount: 1,
            taskCount: 7,
          },
          started: true,
          studyId: view.id,
          reportAvailable: true,
        },
      });
    if (url.pathname.endsWith('/report')) {
      if (route.request().method() === 'POST') {
        generations++;
        await gate;
        generated = true;
        return route.fulfill({ json: ready });
      }
      return route.fulfill({ json: generated ? ready : base });
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      if (body.action === 'open') opens++;
      if (body.command) {
        commands.push(body.command.type);
        throw Error('A completed report must not execute or advance a project');
      }
    }
    if (url.searchParams.has('file'))
      return route.fulfill({
        json: { text: '# Saved plan\nCheck the number, then delete.', hash: 'a'.repeat(64) },
      });
    return route.fulfill({ json: view });
  });
  await learningEvents(() => ({
    view,
    workbench: {
      environmentId: view.environmentId!,
      revision: view.revision,
      epoch: 0,
      canEdit: false,
      canManageFiles: false,
      canRun: false,
      planning: false,
      commands: [],
      terminals: [],
    },
  }));
  await page.goto(`/classroom/${stageId}`);
  await page.getByTestId('scene-title').filter({ hasText: 'Todo project' }).click();
  const heroReport = page.getByRole('button', {
    name: 'Project completed · Learning report',
    exact: true,
  });
  await expect(heroReport).toBeVisible();
  await heroReport.click();
  const report = page.getByTestId('pbl-project-report');
  await expect(report.getByText('7/7', { exact: true })).toBeVisible();
  await expect(report.getByText('Concepts practiced', { exact: true }).first()).toBeVisible();
  await expect(report.getByText('Reviewing a plan', { exact: true })).toBeVisible();
  await expect.poll(() => generations).toBe(1);
  expect(opens).toBe(0);
  expect(commands).toEqual([]);
  finish();
  await expect(
    report.getByText('You connected a boundary to behavior', { exact: true }),
  ).toBeVisible();
  await report.screenshot({ path: 'test-results/pbl-v3-report-desktop.png' });
  await report.getByRole('button', { name: 'Evidence 1', exact: true }).click();
  await expect(report.locator('details[open]')).toContainText(
    'I checked the number before deleting.',
  );
  await report.getByRole('button', { name: 'View read-only workbench', exact: true }).click();
  const workspace = page.getByTestId('pbl-v3-workspace');
  await expect(workspace.getByTestId('pbl-project-completed')).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Saved plan');
  await expect(page.locator('.monaco-editor textarea').first()).not.toBeEditable();
  await workspace
    .getByTestId('pbl-project-completed')
    .getByRole('button', { name: 'Learning report', exact: true })
    .click();
  await expect(
    report.getByText('You connected a boundary to behavior', { exact: true }),
  ).toBeVisible();
  expect(generations).toBe(1);
  await report.getByRole('button', { name: 'Close report', exact: true }).click();
  await workspace.getByRole('button', { name: 'Back to project overview', exact: true }).click();
  await page.getByTestId('scene-title').filter({ hasText: 'Course overview' }).click();
  await page.getByTestId('scene-title').filter({ hasText: 'Todo project' }).click();
  await expect(heroReport).toBeVisible();
  await heroReport.click();
  await expect(report.getByText('7/7', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 520, height: 850 });
  await expect(report).toBeVisible();
  expect(await report.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await report.screenshot({ path: 'test-results/pbl-v3-report-mobile.png' });
  expect(generations).toBe(1);
  expect(commands).toEqual([]);
});
