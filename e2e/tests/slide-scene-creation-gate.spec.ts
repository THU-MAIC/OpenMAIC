import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * MVP gate: the slide editor must not expose scene-creation (blank insert +
 * duplicate) because editor-created scenes have no playback actions and get
 * skipped during playback. Reorder / delete / rename stay. This test fails if
 * SCENE_CREATION_ENABLED is flipped back on without removing the gate.
 */
test.describe('Slide editor — scene-creation gate (MVP)', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.setupGenerationMocks();
  });

  test('Pro mode rail hides insert + duplicate, keeps rename/delete', async ({
    page,
  }, testInfo) => {
    // Generate a classroom through the mocked pipeline.
    const home = new HomePage(page);
    await home.goto();
    await home.fillRequirement('讲解光合作用');
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    // Enter Pro mode via the header Pro Switch.
    await page.getByRole('switch').click();

    // The slide nav rail replaces the playback sidebar in Pro mode.
    const rail = page.getByTestId('slide-nav-rail');
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // Gate 1: no inter-thumb "+" insertion zones.
    await expect(page.getByTestId('slide-nav-insert')).toHaveCount(0);

    // Gate 2: the per-slide overflow menu has exactly Rename + Delete
    // (Duplicate removed). Counting menuitems keeps the assertion
    // locale-independent.
    await page.getByTestId('slide-nav-more').first().click();
    await expect(page.getByRole('menuitem')).toHaveCount(2);

    // Visual evidence of the gated rail, attached to the Playwright report.
    await testInfo.attach('pro-rail-gated', {
      body: await rail.screenshot(),
      contentType: 'image/png',
    });
  });
});
