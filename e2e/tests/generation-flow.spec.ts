import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { HomePage } from '../pages/home.page';
import { MockApi } from '../fixtures/mock-api';
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

  test('starts a run that confirms its own outline and follows it to the classroom', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);
    expect(run.input.outlineReview).toBe('auto');

    const preview = new GenerationPreviewPage(page);
    await expect(preview.stepTitle).toBeVisible();
    // The outline streams read-only: there is nothing to review.
    await expect(preview.alwaysReviewCheckbox).toBeVisible();
    await expect(preview.reviewOutlineButton).toHaveCount(0);

    await preview.waitForRedirectToClassroom();
    expect(page.url()).toContain(`/classroom/${run.stageId}`);
    expect(run.confirmations).toHaveLength(0);
  });

  test('persists always review preference from the preview, for the next runs', async ({
    page,
    mockApi,
  }) => {
    // Slow enough to toggle the setting while the outline streams.
    const run = await mockApi.setupGenerationMocks({ stepMs: 1_000 });
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
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

    // This run was started without the review: it goes on by itself.
    await preview.waitForRedirectToClassroom();
    expect(run.confirmations).toHaveLength(0);
  });
});

test.describe('Generation Flow with outline review', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, REVIEW_SETTINGS_STORAGE);
  });

  test('waits for the outline review when always review is enabled', async ({ page, mockApi }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);
    expect(run.input.outlineReview).toBe('wait');

    const preview = new GenerationPreviewPage(page);
    await preview.waitForEditor();
    await expect(preview.confirmOutlinesButton).toBeEnabled({ timeout: 15_000 });
    // The review holds the run, with no countdown: nothing is confirmed until the learner does.
    await page.waitForTimeout(3_000);
    expect(run.confirmations).toHaveLength(0);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(run.confirmations).toHaveLength(1);
    expect(run.confirmations[0]).toMatchObject({ outlineRevision: 1 });
  });

  test('opens outline editor while the outline streams and resumes generation', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
    expect(run.confirmations).toHaveLength(1);
  });

  test('a reload during outline review shows the same review, which confirms the run', async ({
    page,
    mockApi,
  }) => {
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

  test('a confirmation that lost to another tab keeps the edits and says so', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);
    const preview = new GenerationPreviewPage(page);
    await preview.waitForEditor();
    await expect(preview.confirmOutlinesButton).toBeEnabled({ timeout: 15_000 });
    const title = page.locator('textarea').first();
    await title.fill('Edited here');
    run.confirmElsewhere();
    await preview.confirmOutlines();
    await expect(page.getByText(/already confirmed elsewhere|已在其他地方确认/i)).toBeVisible();
    await expect(page.locator('textarea').first()).toHaveValue('Edited here');
  });

  test('every tab on a waiting run shows the review, and none confirms on a timer', async ({
    page,
    mockApi,
    context,
  }) => {
    const run = await mockApi.setupGenerationMocks({ stepMs: 400 });
    await startFromHome(page);
    // A second tab on the same run, attached while the outline streams.
    const second = await context.newPage();
    await new MockApi(second).mockModelSettings();
    await run.attach(second);
    await second.goto(page.url());
    const secondPreview = new GenerationPreviewPage(second);
    await secondPreview.waitForEditor();
    const firstPreview = new GenerationPreviewPage(page);
    await firstPreview.waitForEditor();
    await expect(secondPreview.confirmOutlinesButton).toBeEnabled({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    expect(run.confirmations).toHaveLength(0);
    // Confirmed in the second tab: the first follows the run.
    await secondPreview.confirmOutlines();
    await firstPreview.waitForRedirectToClassroom();
    expect(run.confirmations).toHaveLength(1);
    await second.close();
  });
});

test.describe('Generation runs', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (settings) => {
        localStorage.setItem('maic:account:settings-storage', settings);
      },
      createSettingsStorage({ sidebarCollapsed: false }),
    );
  });

  test('the classroom follows the run: scenes arrive, and the course is read-only until it completes', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks();
    await startFromHome(page);
    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();
    const scenes = page.locator('[data-testid="scene-item"]');
    await expect(scenes.first()).toBeVisible({ timeout: 15_000 });
    // Generating: the Pro switch shows, disabled.
    await expect(page.getByRole('switch')).toBeDisabled();
    // The second scene arrives while the classroom is open.
    await expect(scenes).toHaveCount(2, { timeout: 15_000 });
    // Completed: editable.
    await expect(page.getByRole('switch')).toBeEnabled({ timeout: 15_000 });
    expect(page.url()).toContain(run.stageId);
  });

  test('a failed first scene pauses with Retry, and Retry resumes the run', async ({
    page,
    mockApi,
  }) => {
    const run = await mockApi.setupGenerationMocks({ failFirstScene: true });
    await startFromHome(page);
    const retry = page.getByTestId('generation-retry');
    await expect(retry).toBeVisible({ timeout: 15_000 });
    // The classic sentence for a provider that is unavailable.
    await expect(page.getByText(/temporarily unavailable|暂时不可用/i)).toBeVisible();
    await retry.click();
    await new GenerationPreviewPage(page).waitForRedirectToClassroom();
    expect(run.retries).toHaveLength(1);
  });

  test('a start over the active-run limit says so', async ({ page, mockApi }) => {
    await mockApi.setupGenerationMocks({ atRunLimit: true });
    const home = new HomePage(page);
    await home.goto();
    await home.fillRequirement('讲解光合作用');
    await home.submit();
    await expect(page.getByText(/maximum number of courses|同时生成的课程已达上限/i)).toBeVisible();
    expect(page.url()).not.toContain('/generation-preview');
  });
});
