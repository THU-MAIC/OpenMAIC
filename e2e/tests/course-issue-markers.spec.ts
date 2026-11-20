import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { DEFAULT_MODEL_SETTINGS } from '../fixtures/test-data/model-settings';
import { SETTINGS_KV_KEY, createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page } from '@playwright/test';

/** The markers live on the edit rail, which starts collapsed. */
const openEditRail = (page: Page) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [SETTINGS_KV_KEY, createSettingsStorage({ agentMode: 'auto', sidebarCollapsed: false })],
  );

test('course issue markers appear only in edit mode and clear after narration is fixed', async ({
  page,
  mockApi,
}, testInfo) => {
  test.setTimeout(120_000);
  await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { tts: 'openai-tts' } });
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await openEditRail(page);
  const stageId = uniqueStageId('course-issues');
  const now = Date.now();
  const doc = {
    stage: { id: stageId, name: 'Course issue markers', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 's',
        stageId,
        type: 'slide',
        title: 'Narration',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            elements: [],
          },
        },
        actions: [
          { id: 'a', type: 'speech', text: 'Hello', audioId: undefined as string | undefined },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  };
  await seedServerDocument(page, doc);
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  await edit.click();
  await expect(page.getByTestId('scene-issue-marker')).toHaveAttribute('data-severity', 'warning');
  await expect
    .poll(() =>
      page
        .getByTestId('slide-nav-rail')
        .getByTestId('scene-item')
        .evaluate((element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            if (Number(getComputedStyle(node).opacity) < 1) return false;
          }
          return true;
        }),
    )
    .toBe(true);
  await testInfo.attach('missing-narration', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.goto('about:blank');
  doc.scenes[0].actions[0].audioId = 'allocated-narration';
  await seedServerDocument(page, doc);
  await page.goto(`/classroom/${stageId}`);
  await expect(edit).toBeVisible();
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  await expect(page.getByTestId('slide-nav-rail').getByTestId('scene-item')).toBeVisible();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .getByTestId('slide-nav-rail')
        .getByTestId('scene-item')
        .evaluate((element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            if (Number(getComputedStyle(node).opacity) < 1) return false;
          }
          return true;
        }),
    )
    .toBe(true);
  await testInfo.attach('narration-fixed', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
