import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

test.describe('Full Happy Path', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    // Pre-seed settings in localStorage (all tests do this)
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);

    // Set up generation API mocks BEFORE any navigation —
    // generation auto-starts when generation-preview mounts.
    await mockApi.setupGenerationMocks();
  });

  test('home → generation-preview → classroom with scene navigation', async ({ page }) => {
    // ── Phase 1: Home page ──────────────────────────────────────────────
    const home = new HomePage(page);
    await home.goto();

    // Core UI elements visible
    await expect(home.logo).toBeVisible();
    await expect(home.textarea).toBeVisible();
    await expect(home.enterButton).toBeDisabled();

    // Fill requirement text → submit button activates
    await home.fillRequirement('讲解光合作用');
    await expect(home.enterButton).toBeEnabled();

    // Submit → navigate to generation-preview
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    // ── Phase 2: Generation preview ─────────────────────────────────────
    const preview = new GenerationPreviewPage(page);

    // Generation progress UI should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for mocked generation to complete and auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    // ── Phase 3: Classroom ──────────────────────────────────────────────
    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();

    // At least one scene should be visible in the sidebar
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    // First scene title should match mock data
    await expect(classroom.getSceneTitle(0)).toContainText('光合作用');

    // If more than one scene item is rendered, verify scene switching works
    const sceneCount = await classroom.sidebarScenes.count();
    if (sceneCount > 1) {
      await classroom.clickScene(1);
      // Verify the clicked scene is visible (active)
      await expect(classroom.sidebarScenes.nth(1)).toBeVisible();
    }
  });
});
