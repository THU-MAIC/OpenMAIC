import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';
import type { Page } from '@playwright/test';

const SETTINGS_STORAGE = createSettingsStorage();
const REVIEW_SETTINGS_STORAGE = createSettingsStorage({ reviewOutlineEnabled: true });

async function startFromHome(page: Page) {
  const home = new HomePage(page);
  await home.goto();
  await home.fillRequirement('讲解光合作用');
  await home.submit();
  await page.waitForURL(/\/generation-preview\?run=/);
}

test.describe('Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, SETTINGS_STORAGE);
  });

  test('starts a run and follows it to the classroom', async ({ page, mockApi }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
    await expect(preview.stepTitle).toBeVisible();

    // The outline auto-continues after its 2.5 s beat; the run takes it from there.
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toContain(`/classroom/${run.stageId}`);
    expect(run.confirmations).toHaveLength(1);
    expect(run.confirmations[0]).toMatchObject({ outlineRevision: 1 });
    expect(run.confirmations[0]).not.toHaveProperty('outlines');
  });

  test('opens outline editor from preview review opportunity and resumes generation', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await expect(preview.editorTitle).toBeVisible();
    // The review holds the run: nothing is confirmed until the learner does.
    await page.waitForTimeout(3_000);
    expect(run.confirmations).toHaveLength(0);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
    expect(run.confirmations).toHaveLength(1);
  });

  test('persists always review preference from the outline editor', async ({ page, mockApi }) => {
    await mockApi.setupGenerationMocks();
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await preview.enableAlwaysReview();

    // The persist write goes through the KVStore and is asynchronous, so poll
    // rather than reading once straight after the toggle.
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw).state.reviewOutlineEnabled : undefined;
        }, SETTINGS_KV_KEY),
      )
      .toBe(true);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });

  test('automatically opens outline editor when always review is enabled', async ({
    page,
    mockApi,
  }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, REVIEW_SETTINGS_STORAGE);

    await mockApi.setupGenerationMocks();
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForEditor();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });
});

test('a reload during outline review shows the same review, which confirms the run', async ({
  page,
  mockApi,
}) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);

  const run = await mockApi.setupGenerationMocks();
  await startFromHome(page);

  const preview = new GenerationPreviewPage(page);
  await preview.waitForReviewOpportunity();
  await preview.openOutlineReview();
  await page.reload();

  // The run is still waiting: the page attaches to it in review.
  await preview.waitForEditor();
  await preview.confirmOutlines();
  await preview.waitForRedirectToClassroom();
  expect(run.confirmations).toHaveLength(1);
});
