import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page } from '@playwright/test';

// Inject settings with modelId so the "enter classroom" button works
const SETTINGS_STORAGE = createSettingsStorage();

interface BodySpacing {
  paddingRight: string;
  marginRight: string;
}

async function readBodySpacing(page: Page): Promise<BodySpacing> {
  return page.evaluate(() => {
    const styles = getComputedStyle(document.body);
    return {
      paddingRight: styles.paddingRight,
      marginRight: styles.marginRight,
    };
  });
}

async function expectBodyScrollState(page: Page, initialSpacing: BodySpacing, locked: boolean) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        locked: document.body.hasAttribute('data-scroll-locked'),
        paddingRight: getComputedStyle(document.body).paddingRight,
        marginRight: getComputedStyle(document.body).marginRight,
      })),
    )
    .toEqual({
      locked,
      paddingRight: initialSpacing.paddingRight,
      marginRight: initialSpacing.marginRight,
    });
}

test.describe('Home → Generation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    }, SETTINGS_STORAGE);
  });

  test('home page separates learning tasks from dedicated course creation', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    await expect(home.logo).toBeVisible();
    await expect(page.getByTestId('learning-task-center')).toBeVisible();
    await expect(home.textarea).toHaveCount(0);
    await expect(page.getByTestId('nav-my-courses')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('nav-create-course').click();
    await page.waitForURL(/\/create$/);
    await expect(home.textarea).toBeVisible();
  });

  test('dedicated create route reuses the course composer and submits requirement', async ({
    page,
  }) => {
    const home = new HomePage(page);
    await home.goto('/create');

    await expect(home.logo).toBeVisible();
    await expect(home.textarea).toBeVisible();
    await expect(home.textarea).toBeFocused();
    await expect(page.getByTestId('nav-create-course')).toHaveAttribute('aria-current', 'page');
    const flow = page.getByTestId('creation-flow-create');
    await expect(flow).toBeVisible();
    await expect(flow.getByText('From idea to classroom')).toBeVisible();

    await home.fillRequirement('创建一堂关于牛顿运动定律的互动课程');
    await expect(home.enterButton).toBeEnabled();
    await expect(flow.getByText('Brief ready')).toBeVisible();
    await home.submit();

    await page.waitForURL(/\/generation-preview/);
  });

  test('keeps body spacing stable when the settings dialog opens', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(home.logo).toBeVisible();

    const initialBodySpacing = await readBodySpacing(page);

    await page.locator('button:has(svg.lucide-settings)').first().click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expectBodyScrollState(page, initialBodySpacing, true);
  });
});
