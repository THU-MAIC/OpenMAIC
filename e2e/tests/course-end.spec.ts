import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The end of a course is a layer over its last page, not a page: the pager counts only
 * real pages, next on the last page opens the layer, and it stays usable in a stage too
 * short to centre it.
 *
 * Bootstrap: the spec stores a 3-page course through the server whose outline is marked
 * complete, the same signal generation writes.
 */

const COUNTER_HTML = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh">
  <div><button id="increment">Increment</button> <output id="count">0</output></div>
  <script>
    let count = 0;
    document.getElementById('increment').onclick = () => {
      document.getElementById('count').textContent = String(++count);
    };
  </script>
</body></html>`;

const pblProject: PBLProjectV2 = {
  uiPhase: 'workspace',
  title: 'Completion practice',
  description: 'Practice writing a plan.',
  proficiency: 'intermediate',
  language: 'en-US',
  tags: [],
  status: 'active',
  roles: [{ id: 'instructor', type: 'instructor', name: 'Tutor' }],
  milestones: [
    {
      id: 'm1',
      title: 'Write a plan',
      status: 'active',
      order: 0,
      microtasks: [
        {
          id: 't1',
          title: 'Draft the plan',
          status: 'in_progress',
          assignee: 'user',
          hints: [],
          order: 0,
        },
      ],
    },
  ],
  submissions: [],
  evaluations: [],
  engagementEvents: [],
  runtimeEvents: [],
  threads: [
    {
      agentId: 'instructor',
      messages: [
        {
          id: 'hello',
          agentId: 'instructor',
          roleType: 'instructor',
          content: 'Write your project question here.',
          ts: '2026-07-14T00:00:00.000Z',
        },
      ],
    },
  ],
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

async function openCourse(page: Page, lastPage: 'slide' | 'interactive' | 'pbl' | 'quiz') {
  const stageId = uniqueStageId('course-end-e2e');
  const scenes = [0, 1, 2].map((order) => {
    const type = order === 2 ? lastPage : 'slide';
    return {
      id: `${stageId}-s${order}`,
      stageId,
      type,
      title: `Page ${order + 1}`,
      order,
      createdAt: 1785899990000,
      updatedAt: 1785900000000,
      content:
        type === 'interactive'
          ? { type, url: '', html: COUNTER_HTML }
          : type === 'pbl'
            ? { type, projectV2: pblProject }
            : type === 'quiz'
              ? {
                  type,
                  questions: [
                    {
                      id: 'q1',
                      type: 'single',
                      question: 'Choose one',
                      options: [
                        { value: 'A', label: 'A' },
                        { value: 'B', label: 'B' },
                      ],
                      answer: ['A'],
                      hasAnswer: true,
                    },
                  ],
                }
              : {
                  type,
                  canvas: {
                    id: `slide-${order}`,
                    viewportSize: 1000,
                    viewportRatio: 0.5625,
                    theme: defaultTheme,
                    elements: [
                      {
                        type: 'text',
                        id: `title-el-${order}`,
                        content: `Page ${order + 1}: course end`,
                        left: 50,
                        top: 50,
                        width: 900,
                        height: 100,
                      },
                    ],
                  },
                },
    };
  });
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Course end e2e',
      description: 'Course end spec fixture',
      createdAt: 1785900000000,
      updatedAt: 1785900000000,
      generatedAgentConfigs: [{ id: 'agent-1', name: 'Agent 1', priority: 1 }],
    },
    scenes,
    outline: {
      outlines: scenes.map(({ type, title, order }) => ({
        id: `o${order}`,
        type,
        title,
        description: `Outline ${order + 1}`,
        keyPoints: [],
        order,
      })),
      generationComplete: true,
    },
  });
  const classroom = new ClassroomPage(page);
  await classroom.goto(stageId);
  await classroom.waitForLoaded();
  await expect(page.getByText('1/3', { exact: true })).toBeVisible({ timeout: 10_000 });
  return { lastSceneId: scenes[2].id };
}

test.describe('Course end', () => {
  test('opens over the last page, counts real pages, and closes back onto it', async ({ page }) => {
    await openCourse(page, 'slide');

    const nextScene = page.getByRole('button', { name: 'Next scene' });
    for (const pageNumber of ['2/3', '3/3']) {
      await nextScene.click();
      await expect(page.getByText(pageNumber, { exact: true })).toBeVisible();
    }
    const end = page.getByTestId('course-end');
    await expect(end).toHaveCount(0);

    await nextScene.click();
    await expect(end).toBeVisible();
    await expect(end).toHaveAttribute('data-badge', 'seedling');
    await expect(page.getByText('3/3', { exact: true })).toBeVisible();

    // Too short to centre: the whole card, medal included, can still be reached.
    await page.setViewportSize({ width: 1280, height: 480 });
    const card = page.getByTestId('course-end-card');
    await expect(card).toBeVisible();
    const medalInside = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="course-end"]');
      const medal = document.querySelector('.ce-medal');
      if (!root || !medal) return false;
      root.scrollTop = 0;
      return medal.getBoundingClientRect().top >= root.getBoundingClientRect().top - 1;
    });
    expect(medalInside).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Esc skips the sequence, and once settled closes, back on the last page.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(end).toHaveCount(0);
    await expect(page.getByText('3/3', { exact: true })).toBeVisible();

    // Reopening by hand, then starting over.
    await nextScene.click();
    await page.getByTestId('course-end-restart').click();
    await expect(page.getByText('1/3', { exact: true })).toBeVisible();
  });

  test('one Escape closes a settled interactive completion card after toggling fullscreen', async ({
    page,
  }) => {
    await openCourse(page, 'interactive');
    const next = page.getByRole('button', { name: 'Next scene' });
    await next.click();
    await next.click();
    await expect(page.getByText('3/3', { exact: true })).toBeVisible();
    const end = page.getByTestId('course-end');
    const fullscreenStage = page.locator('[data-playback-stage]:fullscreen');
    for (const entering of [true, false]) {
      await next.click();
      await expect(end).toHaveAttribute('data-skip', 'true');
      const originalCard = await end.evaluateHandle((node) => node);
      await page.keyboard.press('F11');
      await expect(fullscreenStage).toHaveCount(entering ? 1 : 0);
      await expect
        .poll(() => end.evaluate((node) => Boolean(node.closest('[data-playback-stage]'))))
        .toBe(entering);
      expect(await end.evaluate((node, original) => node === original, originalCard)).toBe(true);
      await originalCard.dispose();
      await page.keyboard.press('Escape');
      await expect(end).toHaveCount(0);
      await expect(page.getByText('3/3', { exact: true })).toBeVisible();
      await expect(fullscreenStage).toHaveCount(entering ? 1 : 0);
    }
  });

  test('closes the interactive completion card after rotating the phone classroom', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined });
    });
    const { lastSceneId } = await openCourse(page, 'interactive');
    await page.setViewportSize({ width: 390, height: 844 });
    const next = page.locator('[data-mobile-toolbar]').getByRole('button', { name: 'Next scene' });
    await next.click();
    await next.click();
    const frame = page.frameLocator(`iframe[title="Interactive Scene ${lastSceneId}"]`);
    await frame.getByRole('button', { name: 'Increment' }).click();
    await page.locator('.mobile-canvas-menu').click();
    await page.locator('.mobile-canvas-footer button').last().click();
    await expect(page.locator('[data-playback-stage]')).toHaveAttribute('data-landscape', 'true');
    await next.click();
    await expect(page.locator('[data-classroom-stage]').getByTestId('course-end')).toBeVisible();
    await page.getByTestId('course-end-close').click();
    await expect(page.getByTestId('course-end')).toHaveCount(0);
    await expect(frame.locator('#count')).toHaveText('1');
    await frame.getByRole('button', { name: 'Increment' }).click();
    await expect(frame.locator('#count')).toHaveText('2');
  });

  for (const fullscreen of [false, true]) {
    test(`closes and restarts over an interactive last page (${fullscreen ? 'fullscreen' : 'windowed'})`, async ({
      page,
    }) => {
      const { lastSceneId } = await openCourse(page, 'interactive');
      if (fullscreen) {
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(() => document.fullscreenElement?.hasAttribute('data-playback-stage')),
          )
          .toBe(true);
      }

      const next = page.getByRole('button', { name: 'Next scene' });
      await next.click();
      await next.click();
      const lastPage = page.getByText('3/3', { exact: true });
      await expect(lastPage).toBeVisible();

      const frame = page.frameLocator(`iframe[title="Interactive Scene ${lastSceneId}"]`);
      const increment = frame.getByRole('button', { name: 'Increment' });
      const count = frame.locator('#count');
      await increment.click();
      await expect(count).toHaveText('1');

      const end = page.getByTestId('course-end');
      await next.click();
      await expect(end).toBeVisible();
      await expect(lastPage).toBeVisible();
      await page.getByTestId('course-end-close').click({ timeout: 5_000 });
      await expect(end).toHaveCount(0);
      await expect(lastPage).toBeVisible();
      await expect(count).toHaveText('1');
      await increment.click();
      await expect(count).toHaveText('2');

      await next.click();
      await page.getByTestId('course-end-restart').click({ timeout: 5_000 });
      await expect(end).toHaveCount(0);
      await expect(page.getByText('1/3', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(fullscreen);
    });
  }
});

for (const layout of ['windowed', 'expanded', 'fullscreen'] as const) {
  test(`PBL completion preserves the workspace (${layout})`, async ({ page }) => {
    const fullscreen = layout === 'fullscreen';
    await openCourse(page, 'pbl');
    if (fullscreen) {
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await expect(page.locator('[data-playback-stage]:fullscreen')).toHaveCount(1);
    }
    const next = page.getByRole('button', { name: 'Next scene' });
    await next.click();
    await next.click();
    const workspace = page.getByTestId('pbl-workspace-frame');
    await expect(workspace).toBeVisible();
    const draft = workspace.locator('textarea').first();
    await draft.fill('Keep this unsent project question');
    const originalWorkspace = await workspace.evaluateHandle((node) => node);
    if (layout === 'expanded') {
      await workspace
        .getByRole('button', { name: 'Expand to fullscreen workspace', exact: true })
        .click();
      await expect(workspace).toHaveAttribute('data-expanded', 'true');
    }
    // Keyboard activation reaches Next even when the expanded workspace covers the toolbar.
    const openEnd = () => (layout === 'expanded' ? next.press('Enter') : next.click());
    await openEnd();
    await expect(page.getByTestId('course-end')).toHaveAttribute('data-skip', 'true');
    await test.info().attach('pbl-completion', {
      body: await page.screenshot({ path: test.info().outputPath('completion.png') }),
      contentType: 'image/png',
    });
    await page.getByTestId('course-end-close').click({ timeout: 5000 });
    await expect(page.getByTestId('course-end')).toHaveCount(0);
    expect(await workspace.evaluate((node, original) => node === original, originalWorkspace)).toBe(
      true,
    );
    await expect(draft).toHaveValue('Keep this unsent project question');
    await openEnd();
    await expect(page.getByTestId('course-end')).toHaveAttribute('data-skip', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('course-end')).toHaveCount(0);
    await expect(draft).toHaveValue('Keep this unsent project question');
    await openEnd();
    await page.getByTestId('course-end-restart').click({ timeout: 5000 });
    await expect(page.getByText('1/3', { exact: true })).toBeVisible();
    await expect(workspace).toHaveCount(0);
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(fullscreen);
    await originalWorkspace.dispose();
  });
}

for (const scene of ['slide', 'quiz'] as const) {
  for (const fullscreen of [false, true]) {
    test(`completion closes and restarts on ${scene} (${fullscreen ? 'fullscreen' : 'windowed'})`, async ({
      page,
    }) => {
      await openCourse(page, scene);
      if (fullscreen) {
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        await expect(page.locator('[data-playback-stage]:fullscreen')).toHaveCount(1);
      }
      const next = page.getByRole('button', { name: 'Next scene' });
      await next.click();
      await next.click();
      if (scene === 'quiz') {
        await page.getByRole('button', { name: 'Start Quiz', exact: true }).click();
        await expect(page.getByText('Choose one', { exact: true })).toBeVisible();
      }
      await next.click();
      const end = page.getByTestId('course-end');
      await expect(end).toBeVisible();
      await page.getByTestId('course-end-close').click();
      await expect(end).toHaveCount(0);
      await expect(page.getByText('3/3', { exact: true })).toBeVisible();
      await next.click();
      await page.getByTestId('course-end-restart').click();
      await expect(end).toHaveCount(0);
      await expect(page.getByText('1/3', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(fullscreen);
    });
  }
}
