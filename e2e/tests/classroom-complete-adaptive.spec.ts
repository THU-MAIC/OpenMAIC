import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The classroom-complete page must adapt to short stage viewports instead of
 * relying on its centered-flex scroll: content taller than the viewport clips
 * beyond the scroll origin at the TOP, so the trophy became unreachable — the
 * user could scroll down but never back up to it. These specs pin both halves
 * of the fix:
 *   - the adaptive `compact` token (below FULL_MIN the layout shrinks to fit,
 *     above FULL_SAFE it re-expands — hysteresis both ways), and
 *   - the trophy stays reachable (its top never clips above the section).
 *
 * Bootstrap: the spec stores a 3-slide course through the server whose
 * outline is marked complete (the same signal generation writes), so the
 * playback pager offers the completion slot.
 */

const STAGE_ID = uniqueStageId('classroom-complete-adaptive-e2e');

const CLASSROOM_PAYLOAD = {
  stage: {
    id: STAGE_ID,
    name: 'Adaptive layout e2e',
    description: 'Complete-page viewport adaptation spec fixture',
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
            content: `Page ${order + 1}: adaptive layout`,
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

/** Trophy container inline width: 120 in compact, 200 in full layout. */
function trophyWidth(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Course complete"]');
    const trophy = [...(section?.querySelectorAll<HTMLElement>('div[style]') ?? [])].find((el) =>
      /^\s*(120|200)px\s*$/.test(el.style.width),
    );
    return trophy ? parseInt(trophy.style.width, 10) : -1;
  });
}

test.describe('Classroom complete adaptive layout', () => {
  test('shrinks on short viewports, re-expands on tall ones, never clips the trophy', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
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
    const classroomId = STAGE_ID;

    // The completed document offers the completion slot (N/N + 1).
    await classroom.goto(classroomId);
    await classroom.waitForLoaded();
    await expect(page.getByText('1/4', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Advance past the last (3rd) scene into the completion slot.
    const nextScene = page.getByRole('button', { name: 'Next scene' });
    for (const pageNumber of ['2/4', '3/4', '4/4']) {
      await nextScene.click();
      await expect(page.getByText(pageNumber, { exact: true })).toBeVisible();
    }
    const complete = page.locator('section[aria-label="Course complete"]');
    await expect(complete).toBeVisible();

    // Short viewport: compact layout engages and the trophy is fully inside
    // the section — its top must not clip above the section's scroll origin.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => trophyWidth(page)).toBeLessThanOrEqual(120);
    const trophyTopOk = await page.evaluate(() => {
      const section = document.querySelector('section[aria-label="Course complete"]');
      const trophy = [...(section?.querySelectorAll<HTMLElement>('div[style]') ?? [])].find((el) =>
        /^\s*(120|200)px\s*$/.test(el.style.width),
      );
      if (!section || !trophy) return false;
      return trophy.getBoundingClientRect().top >= section.getBoundingClientRect().top - 1;
    });
    expect(trophyTopOk).toBe(true);

    // Tall viewport: the full layout comes back (hysteresis re-expand).
    await page.setViewportSize({ width: 1280, height: 1300 });
    await expect.poll(() => trophyWidth(page)).toBeGreaterThanOrEqual(200);

    // And back to short: compact re-engages (hysteresis the other way).
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => trophyWidth(page)).toBeLessThanOrEqual(120);
  });
});
