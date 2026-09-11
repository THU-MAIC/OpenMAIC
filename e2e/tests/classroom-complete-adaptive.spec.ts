import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';

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
 * Bootstrap: the spec POSTs a 3-slide classroom through the file-backed
 * /api/classroom route, then marks the document's outline record complete in
 * IndexedDB (the same signal generation writes), so the playback pager offers
 * the completion slot.
 */

const STAGE_ID = 'classroom-complete-adaptive-e2e';

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
    // Persist the classroom server-side (file store), then load it once so
    // the document lands in IndexedDB…
    const response = await page.request.post('/api/classroom', { data: CLASSROOM_PAYLOAD });
    expect(response.ok()).toBe(true);
    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE_ID);
    await classroom.waitForLoaded();
    await expect(page.getByRole('heading', { name: 'Page 1' })).toBeVisible();

    // The fallback apply schedules an async full-aggregate save; that save
    // carries no outline and would DELETE an outline row written before it
    // commits ("a full-aggregate save with no outline means no outline").
    // Wait for the document to land first…
    await expect
      .poll(() =>
        page.evaluate(
          ({ stageId }) =>
            new Promise<number>((resolve) => {
              const req = indexedDB.open('maic-documents');
              req.onsuccess = () => {
                const tx = req.result.transaction(['stages'], 'readonly');
                const get = tx.objectStore('stages').get(stageId);
                get.onsuccess = () => resolve(get.result ? 1 : 0);
                get.onerror = () => resolve(-1);
              };
              req.onerror = () => resolve(-1);
            }),
          { stageId: STAGE_ID },
        ),
      )
      .toBe(1, { timeout: 15_000 });
    await page.waitForTimeout(500); // let the aggregate save transaction settle

    // …then mark the outline record complete the way the generator would.
    // Row shape mirrors splitDocument: { stageId, outline: AppDocumentOutline }.
    await page.evaluate(
      ({ stageId }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('maic-documents');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['outlines'], 'readwrite');
            tx.objectStore('outlines').put({
              stageId,
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
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }),
      { stageId: STAGE_ID },
    );

    // Reload: the completed document now offers the completion slot (N/N + 1).
    await classroom.goto(STAGE_ID);
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
