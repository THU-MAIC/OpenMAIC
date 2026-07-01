import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Scene creation is enabled in the slide editor: the inter-thumb "+" insertion
 * zones and the per-slide Duplicate menu item are exposed alongside reorder /
 * delete / rename. (Duplicated slides carry their actions; a blank inserted
 * slide is authored via the script timeline / MAIC Agent.) This test guards
 * that the entry points stay available — flip SCENE_CREATION_ENABLED off and it
 * fails.
 */
test.describe('Slide editor — scene creation (enabled)', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.setupGenerationMocks();
  });

  test('Pro mode rail exposes insert + duplicate alongside rename/delete', async ({
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

    // Insertion zones are present between thumbs.
    await expect(page.getByTestId('slide-nav-insert')).not.toHaveCount(0);

    // The per-slide overflow menu now has Rename + Duplicate + Delete (3 items).
    // Counting menuitems keeps the assertion locale-independent.
    await page.getByTestId('slide-nav-more').first().click();
    await expect(page.getByRole('menuitem')).toHaveCount(3);

    // Visual evidence, attached to the Playwright report.
    await testInfo.attach('pro-rail-scene-creation', {
      body: await rail.screenshot(),
      contentType: 'image/png',
    });
  });
});
