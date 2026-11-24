import { expect } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { MockApi } from '../fixtures/mock-api';
import type { LearningView } from '@/lib/pbl/v3/types';

for (const fullscreen of [false, true]) {
  test(`PBL v3 completion preserves the expanded workspace (${fullscreen ? 'fullscreen' : 'windowed'})`, async ({
    page,
    learningEvents,
  }) => {
    test.setTimeout(60000);
    await new MockApi(page).mockModelSettings();
    await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
    const view = {
      onboardingCompleted: true,
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
          stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
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

    const workbench = {
      environmentId: view.environmentId!,
      revision: view.revision,
      epoch: 0,
      canEdit: false,
      canManageFiles: false,
      canRun: false,
      planning: false,
      commands: [],
      terminals: [],
    };
    await page.route('**/api/pbl/v3**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('project') === '1')
        return route.fulfill({
          json: {
            hero: {
              title: view.title,
              description: 'Practice a greeting.',
              gains: [],
              instructorName: 'Tutor',
              milestoneCount: 2,
              taskCount: 14,
            },
            started: true,
          },
        });
      if (url.pathname.endsWith('/workspace')) return route.fulfill({ json: workbench });
      if (url.pathname.endsWith('/activity')) return route.fulfill({ json: { recorded: true } });
      if (url.searchParams.has('file'))
        return route.fulfill({ json: { text: 'My plan', hash: 'a'.repeat(64) } });
      return route.fulfill({ json: view });
    });
    await learningEvents(() => ({ view, workbench }));
    const stageId = uniqueStageId('pbl-course-end');
    await seedServerDocument(page, {
      stage: { id: stageId, name: 'Project course', createdAt: Date.now(), updatedAt: Date.now() },
      scenes: [
        {
          id: 'overview',
          stageId,
          type: 'slide',
          title: 'Overview',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'intro',
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
          title: 'Project',
          order: 1,
          content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.2.0' } },
          actions: [],
        },
      ],
      outline: { outlines: [], generationComplete: true },
    });
    await page.goto(`/classroom/${stageId}`);
    const next = page.getByRole('button', { name: 'Next scene' });
    await expect(next).toBeVisible();
    if (fullscreen) {
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await expect(page.locator('[data-playback-stage]:fullscreen')).toHaveCount(1);
    }
    await next.click();
    await page.getByRole('button', { name: 'Continue Project', exact: true }).click();
    const workspace = page.getByTestId('pbl-workspace-frame');
    await expect(workspace).toHaveAttribute('data-expanded', 'true');
    const draft = page.getByLabel('Your message', { exact: true });
    await draft.fill('Keep this unsent project question');
    const originalWorkspace = await workspace.evaluateHandle((node) => node);
    // The expanded workspace covers the toolbar visually. Activate the real
    // classroom Next button by keyboard, as a keyboard user can after tabbing to it.
    await next.press('Enter');
    const end = page.getByTestId('course-end');
    await expect(end).toHaveAttribute('data-skip', 'true');
    await test.info().attach('expanded-completion', {
      body: await page.screenshot({ path: test.info().outputPath('completion.png') }),
      contentType: 'image/png',
    });
    await page.getByTestId('course-end-close').click({ timeout: 5000 });
    await expect(end).toHaveCount(0);
    await expect(draft).toHaveValue('Keep this unsent project question');
    expect(await workspace.evaluate((node, original) => node === original, originalWorkspace)).toBe(
      true,
    );
    await expect(workspace).toHaveAttribute('data-expanded', 'true');

    await next.press('Enter');
    await expect(end).toHaveAttribute('data-skip', 'true');
    const originalCard = await end.evaluateHandle((node) => node);
    await page.keyboard.press('F11');
    await expect(page.locator('[data-playback-stage]:fullscreen')).toHaveCount(fullscreen ? 0 : 1);
    expect(await end.evaluate((node, original) => node === original, originalCard)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(end).toHaveCount(0);
    await expect(draft).toHaveValue('Keep this unsent project question');
    expect(await workspace.evaluate((node, original) => node === original, originalWorkspace)).toBe(
      true,
    );
    await expect(workspace).toHaveAttribute('data-expanded', 'true');
    await expect(page.locator('[data-playback-stage]:fullscreen')).toHaveCount(fullscreen ? 0 : 1);
    await originalCard.dispose();
    await next.press('Enter');
    await page.getByTestId('course-end-restart').click({ timeout: 5000 });
    await expect(page.getByText('1/2', { exact: true })).toBeVisible();
    await expect(workspace).toHaveCount(0);
    await originalWorkspace.dispose();
  });
}
