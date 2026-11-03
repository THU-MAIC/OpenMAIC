import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The end of a course is a layer over its last page, not a page: the pager counts only
 * real pages, next on the last page opens the layer, and it stays usable in a stage too
 * short to centre it.
 *
 * Bootstrap: the spec stores a 3-slide course through the server whose outline is marked
 * complete, the same signal generation writes.
 */

const STAGE_ID = uniqueStageId('course-end-e2e');

const CLASSROOM_PAYLOAD = {
  stage: {
    id: STAGE_ID,
    name: 'Course end e2e',
    description: 'Course end spec fixture',
    createdAt: 1785900000000,
    updatedAt: 1785900000000,
    generatedAgentConfigs: [{ id: 'agent-1', name: 'Agent 1', priority: 1 }],
  },
  scenes: [0, 1, 2].map((order) => ({
    id: `${STAGE_ID}-s${order}`,
    stageId: STAGE_ID,
    type: 'slide',
    title: `Page ${order + 1}`,
    order,
    createdAt: 1785899990000,
    updatedAt: 1785900000000,
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${order}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
          fontColor: '#333333',
          fontName: 'Microsoft Yahei',
        },
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
  })),
};

test.describe('Course end', () => {
  test('opens over the last page, counts real pages, and closes back onto it', async ({ page }) => {
    // Not networkidle: with the workbench enabled the home page holds an event stream open.
    await page.goto('/', { waitUntil: 'load' });
    await seedServerDocument(page, {
      ...CLASSROOM_PAYLOAD,
      outline: {
        outlines: [0, 1, 2].map((order) => ({
          id: `o${order}`,
          type: 'slide',
          title: `Page ${order + 1}`,
          description: `Outline ${order + 1}`,
          keyPoints: [],
          order,
        })),
        generationComplete: true,
      },
    });
    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE_ID);
    await classroom.waitForLoaded();
    await expect(page.getByText('1/3', { exact: true })).toBeVisible({ timeout: 10_000 });

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
});
