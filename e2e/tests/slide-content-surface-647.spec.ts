import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * PR3b — slide content surface completion (#647). Verifies the new
 * surface-level affordances render and anchor correctly in Pro edit mode:
 * the slide-background insert item, z-order on the element bar, and the
 * image-type bar (replace/flip). Icon-class selectors keep the
 * assertions locale-independent.
 */
test.describe('Slide content surface (#647)', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.setupGenerationMocks();
  });

  test('background, z-order, and image bar surface in Pro mode', async ({ page }, testInfo) => {
    // Generate a classroom through the mocked pipeline, then enter Pro mode.
    const home = new HomePage(page);
    await home.goto();
    // Dismiss the "What's New" changelog modal that overlays the home page on
    // first load (it intercepts the submit button otherwise).
    await page
      .getByRole('button', { name: /got it|知道了/i })
      .click({ timeout: 5_000 })
      .catch(() => {});
    await home.fillRequirement('讲解光合作用');
    await home.submit();
    await page.waitForURL(/\/generation-preview/);
    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('switch').click();
    await expect(page.getByTestId('slide-nav-rail')).toBeVisible({ timeout: 10_000 });

    // --- Slide background: a PaintBucket insert item opens a solid/image popover.
    const bgInsert = page.locator('button:has(.lucide-paint-bucket)');
    // The insert toolbar may start collapsed — expand it if the item isn't shown.
    if ((await bgInsert.count()) === 0) {
      await page
        .locator('button:has(.lucide-plus), button:has(.lucide-pencil-ruler)')
        .first()
        .click();
    }
    await expect(bgInsert).toBeVisible({ timeout: 10_000 });
    await bgInsert.click();
    // The background popover hosts the solid color picker (react-colorful).
    await expect(page.locator('.color-picker, .react-colorful').first()).toBeVisible();
    await testInfo.attach('slide-background-popover', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');

    // --- Z-order on the text element bar: select the title, expect to-front/to-back.
    await page.locator('.editable-element-text').first().click();
    await expect(page.locator('.lucide-bring-to-front').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.lucide-send-to-back').first()).toBeVisible();
    await testInfo.attach('text-bar-zorder', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // --- Image insert popover hosts the picker (the image-type bar's
    // replace/flip ops are covered by image-actions.test.ts and the
    // image-flip round-trip suite, which don't need a live canvas).
    await page.keyboard.press('Escape');
    await page.locator('button:has(.lucide-image)').first().click();
    await expect(page.getByPlaceholder(/https/i)).toBeVisible({ timeout: 10_000 });
    await testInfo.attach('image-insert-popover', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
