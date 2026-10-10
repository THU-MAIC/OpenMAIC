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

  test('home page loads with core UI elements and submits requirement', async ({
    page,
    mockApi,
  }) => {
    // Submitting starts a generation run (mocked: no provider is called).
    const run = await mockApi.setupGenerationMocks();
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
    expect(page.url()).toContain(`/generation-preview?run=${run.id}`);
    expect(run.started).toBe(true);
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

test.describe('Course materials in the composer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    }, SETTINGS_STORAGE);
  });

  async function attach(page: Page, name: string, body: string) {
    await page.locator('button:has(svg.lucide-paperclip)').first().click();
    await page
      .locator('input[type="file"][multiple]')
      .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
  }

  test('uploads and parses an attached file before Generate, then starts from it', async ({
    page,
    mockApi,
  }) => {
    const library = await mockApi.mockMaterials({ pollsUntilReady: 2 });
    const run = await mockApi.setupGenerationMocks();
    const home = new HomePage(page);
    await home.goto();
    await home.fillRequirement('Teach from my notes');
    await expect(home.enterButton).toBeEnabled();

    await attach(page, 'notes.txt', 'Photosynthesis turns light into sugar.');
    const chip = page.getByTestId('course-material-chip');
    // Parsing: Generate waits for it.
    await expect(chip).toHaveAttribute('data-status', 'extracting');
    await expect(chip).toContainText('Parsing');
    await expect(home.enterButton).toBeDisabled();
    // Ready: Generate starts the run from the uploaded material.
    await expect(chip).toHaveAttribute('data-status', 'ready', { timeout: 10_000 });
    await expect(chip).toContainText('Ready');
    await page.keyboard.press('Escape');
    await expect(home.enterButton).toBeEnabled();
    await home.submit();
    await page.waitForURL(/\/generation-preview/);
    expect(run.input.materialIds).toEqual([...library.materials.keys()]);
    expect(run.input.releaseMaterials).toBe(true);
    // Nothing was left to parse: the preview shows no analysis step.
    await expect(page.getByText('Analyzing documents')).toHaveCount(0);
    // The material is the run's now: leaving the composer did not delete it.
    expect(library.deleted).toEqual([]);
  });

  test('shows a failed parse with its reason, and removing it deletes it', async ({
    page,
    mockApi,
  }) => {
    const library = await mockApi.mockMaterials({
      pollsUntilReady: 1,
      failWith: 'document extraction failed (unpdf: no text)',
    });
    await mockApi.setupGenerationMocks();
    const home = new HomePage(page);
    await home.goto();
    await home.fillRequirement('Teach from my notes');
    await attach(page, 'broken.txt', 'x');
    const chip = page.getByTestId('course-material-chip');
    await expect(chip).toHaveAttribute('data-status', 'failed', { timeout: 10_000 });
    await expect(chip).toContainText('document extraction failed (unpdf: no text)');
    await expect(chip.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(home.enterButton).toBeDisabled();

    const [id] = [...library.materials.keys()];
    await chip.getByRole('button', { name: 'Remove file' }).click();
    await expect(chip).toHaveCount(0);
    await expect.poll(() => library.deleted).toEqual([id]);
    await page.keyboard.press('Escape');
    await expect(home.enterButton).toBeEnabled();
  });
});
