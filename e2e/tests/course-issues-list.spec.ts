import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import type { Page } from '@playwright/test';

/**
 * The course issues list (issue #2329): one place in the editor for every
 * problem in a course, derived from the course itself, so an entry goes away
 * once its cause is fixed.
 */

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
        id: 'scene-summary',
        stageId,
        type: 'slide',
        title: 'Summary',
        order: 2,
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
  // The standalone classroom's Learn | Edit control: a button group since the
  // phone layout work (#2313); the earlier single switch is still accepted so
  // this helper does not depend on which chrome the route renders.
  const edit = page.getByTestId('workbench-mode-editing');
  const legacyEdit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit.or(legacyEdit)).toBeVisible();
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  if (await edit.count()) {
    if ((await edit.getAttribute('aria-pressed')) !== 'true') await edit.click();
  } else if ((await legacyEdit.getAttribute('aria-checked')) !== 'true') {
    await legacyEdit.click();
  }
  await expect(page.getByTestId('edit-course-issues')).toBeVisible();
}

test('the owner sees every issue in one list, goes to its page, and the list clears once fixed', async ({
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
  await expect(page.getByTestId('edit-page-indicator')).toHaveText('2/3');

  // Fixing the causes clears their issues: the list is derived, not recorded.
  await page.goto('about:blank');
  await seedServerDocument(page, course(stageId, { fixed: true }));
  await editCourse(page, stageId);
  await expect(count).toHaveCount(0);
  await page.getByTestId('edit-course-issues').click();
  await expect(page.getByTestId('course-issues-popover')).toContainText(/no issues/i);
});
