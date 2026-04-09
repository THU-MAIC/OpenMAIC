import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

// Inject settings with modelId so the "enter classroom" button works
const SETTINGS_STORAGE = createSettingsStorage();
const OUTLINE_REVIEW_SETTINGS_STORAGE = createSettingsStorage({ reviewOutlineEnabled: true });

test.describe('Home → Generation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
  });

  test('home page loads with core UI elements and submits requirement', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    // Core elements visible
    await expect(home.logo).toBeVisible();
    await expect(home.textarea).toBeVisible();
    await expect(home.enterButton).toBeDisabled();

    // Type requirement → button activates
    await home.fillRequirement('讲解光合作用');
    await expect(home.enterButton).toBeEnabled();

    // Submit → navigate to generation-preview
    await home.submit();
    await page.waitForURL(/\/generation-preview/);
    expect(page.url()).toContain('/generation-preview');
  });

  test('media popover shows localized outline review copy', async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, OUTLINE_REVIEW_SETTINGS_STORAGE);

    const home = new HomePage(page);
    await home.goto();

    await home.openMediaPopover();
    await home.outlineTab.click();

    await expect(home.outlineReviewLabel).toBeVisible();
    await expect(home.outlineReviewHint).toBeVisible();
    await expect(page.getByText('media.reviewOutline')).toHaveCount(0);
    await expect(page.getByText('media.reviewOutlineHint')).toHaveCount(0);
  });
});
