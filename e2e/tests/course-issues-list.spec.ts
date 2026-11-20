import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import type { Page } from '@playwright/test';

/**
 * The course issues list (issue #2329): one place in the editor for every
 * problem in a course, derived from the course itself, and an interactive
 * page's runtime error shown to its owner as a plain notice with the raw error
 * folded away, and to everyone else as a neutral notice.
 */

const THROWING_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif">
  <h1>Projectile motion</h1>
  <script>var y = graphY(200);</script>
</body></html>`;

const REPAIRED_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif">
  <h1>Projectile motion</h1>
  <p id="out"></p>
  <script>
    var graphY = function (x) { return x / 2; };
    document.getElementById('out').textContent = 'y = ' + graphY(200);
  </script>
</body></html>`;

function course(stageId: string, { fixed }: { fixed: boolean }) {
  const now = Date.now();
  const canvas = (id: string, elementId: string) => ({
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: defaultTheme,
    elements: [
      {
        id: elementId,
        type: 'text',
        left: 80,
        top: 80,
        width: 600,
        height: 90,
        rotate: 0,
        content: '<p>Hello</p>',
        defaultFontName: 'Microsoft Yahei',
        defaultColor: '#333333',
      },
    ],
  });
  const narration = (id: string) => ({ id, type: 'speech', text: 'Hello', audioId: 'allocated' });
  return {
    stage: { id: stageId, name: 'Course issues list', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-intro',
        stageId,
        type: 'slide',
        title: 'Introduction',
        order: 0,
        content: { type: 'slide', canvas: canvas('c-intro', 'el-intro') },
        actions: [narration('speech-intro')],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'scene-cue',
        stageId,
        type: 'slide',
        title: 'Forces',
        order: 1,
        content: { type: 'slide', canvas: canvas('c-cue', 'el-forces') },
        actions: [
          narration('speech-cue'),
          { id: 'cue', type: 'spotlight', elementId: fixed ? 'el-forces' : 'el-deleted' },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'scene-graph',
        stageId,
        type: 'interactive',
        title: 'Graph',
        order: 2,
        content: { type: 'interactive', url: '', html: fixed ? REPAIRED_HTML : THROWING_HTML },
        actions: [narration('speech-graph')],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'scene-summary',
        stageId,
        type: 'slide',
        title: 'Summary',
        order: 3,
        content: { type: 'slide', canvas: canvas('c-summary', 'el-summary') },
        actions: fixed ? [narration('speech-summary')] : [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  };
}

async function editCourse(page: Page, stageId: string) {
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  await expect(page.getByTestId('edit-course-issues')).toBeVisible();
}

test('the owner sees every issue in one list, the runtime error folded away, and the list clears once fixed', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const stageId = uniqueStageId('course-issues-list');
  await seedServerDocument(page, course(stageId, { fixed: false }));
  await editCourse(page, stageId);

  const count = page.getByTestId('edit-course-issues-count');
  await expect(count).toHaveText('2');
  await expect(count).toHaveAttribute('data-severity', 'warning');

  await page.getByTestId('edit-course-issues').click();
  const popover = page.getByTestId('course-issues-popover');
  await expect(popover.getByTestId('course-issue-item')).toHaveCount(2);
  await expect(popover.locator('[data-kind="dangling-cue"]')).toContainText(/no longer exists/i);
  await expect(popover.locator('[data-kind="empty-actions"]')).toBeVisible();
  await testInfo.attach('issues-list', { body: await page.screenshot(), contentType: 'image/png' });

  // "Go to" takes the editor to the page the issue is on.
  await popover.getByTestId('course-issue-goto-scene-cue').click();
  await expect(popover).toBeHidden();
  await expect(page.getByTestId('edit-page-indicator')).toHaveText('2/4');

  // The interactive page has no problem in its document; running it does. Its
  // runtime error joins the list as an error, and the owner's notice keeps the
  // raw text folded away.
  await page.getByTestId('edit-canvas-next').click();
  await expect(page.getByTestId('edit-page-indicator')).toHaveText('3/4');
  const notice = page.getByTestId('interactive-runtime-error');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute('data-repairable', 'true');
  await expect(notice).not.toContainText('graphY');
  await expect(count).toHaveText('3');
  await expect(count).toHaveAttribute('data-severity', 'error');
  await notice.getByTestId('interactive-runtime-error-details-toggle').click();
  await expect(notice.getByTestId('interactive-runtime-error-details')).toContainText(
    'graphY is not defined',
  );
  await testInfo.attach('owner-runtime-notice', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // Fixing the causes clears their issues: the list is derived, not recorded.
  // The editor reopens on the interactive page the owner was on, and the
  // repaired page runs to its end without an error.
  await page.goto('about:blank');
  await seedServerDocument(page, course(stageId, { fixed: true }));
  await editCourse(page, stageId);
  await expect(
    page.frameLocator('iframe[title="Interactive Scene scene-graph"]').getByText('y = 100'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(count).toHaveCount(0);
  await expect(page.getByTestId('interactive-runtime-error')).toHaveCount(0);
  await page.getByTestId('edit-course-issues').click();
  await expect(page.getByTestId('course-issues-popover')).toContainText(/no issues/i);
});

test('a viewer who does not own the course sees a neutral notice, never the raw error or repair', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const stageId = uniqueStageId('course-issues-viewer');
  await seedServerDocument(page, course(stageId, { fixed: false }));

  // Another browser: another owner, viewing the course from its link.
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const viewer = await context.newPage();
  await viewer.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await viewer.goto(`/classroom/${stageId}`);
  const next = viewer.getByRole('button', { name: 'Next scene' });
  await expect(next).toBeVisible({ timeout: 30_000 });
  await next.click();
  await next.click();

  const notice = viewer.getByTestId('interactive-runtime-error');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute('data-repairable', 'false');
  await expect(viewer.getByText(/graphY/)).toHaveCount(0);
  await expect(viewer.getByTestId('interactive-runtime-error-details-toggle')).toHaveCount(0);
  await expect(viewer.getByTestId('interactive-runtime-error-fix')).toHaveCount(0);
  await testInfo.attach('viewer-runtime-notice', {
    body: await viewer.screenshot(),
    contentType: 'image/png',
  });
  await context.close();
});
