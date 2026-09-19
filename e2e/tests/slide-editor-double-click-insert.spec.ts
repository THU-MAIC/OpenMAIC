import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Double-click text insertion on slide canvas (#1310).
 * Verifies that double-clicking on blank canvas area creates a new text element.
 * Regression test to ensure the event-propagation guard works correctly.
 */
test.describe('Slide editor double-click text insertion (#1310)', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.setupGenerationMocks();
  });

  test('double-click on blank canvas area creates a new text element', async ({ page }) => {
    // Generate a classroom through the mocked pipeline
    const home = new HomePage(page);
    await home.goto();
    // Dismiss the "What's New" changelog modal
    await page
      .getByRole('button', { name: /got it|知道了/i })
      .click({ timeout: 5_000 })
      .catch(() => {});
    await home.fillRequirement('Test Canvas Double Click');
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    // Enter Pro edit mode
    await page.getByRole('switch').click();
    await expect(page.getByTestId('slide-nav-rail')).toBeVisible({ timeout: 10_000 });

    // Open slide editor by clicking on first scene
    await classroom.clickScene(0);
    await page.waitForTimeout(1000); // Wait for slide editor to fully render

    // Wait for canvas to be available
    const canvas = page
      .locator('[data-testid="canvas-viewport"], .canvas-viewport, [class*="canvas"]')
      .first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });

    // Get initial count of editable elements
    const initialElementCount = await page.locator('.editable-element').count();

    // Double-click on blank canvas area (center, avoiding existing elements)
    const boundingBox = await canvas.boundingBox();
    if (!boundingBox) throw new Error('Canvas bounding box not found');

    const clickX = boundingBox.x + boundingBox.width * 0.7;
    const clickY = boundingBox.y + boundingBox.height * 0.7;

    await page.mouse.dblclick(clickX, clickY);
    await page.waitForTimeout(500); // Wait for text element creation

    // Verify a new text element was created
    const newElementCount = await page.locator('.editable-element').count();
    expect(newElementCount).toBeGreaterThan(initialElementCount);
  });
});
