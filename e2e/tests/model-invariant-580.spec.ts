import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';

/**
 * #580 — "usable provider ⇒ a concrete model is always selected".
 *
 * The course model is the workspace's `llm` slot, read from the server
 * (`/api/model-config`); the browser keeps no provider state.
 *
 * State A: the workspace has no language model → generate button disabled,
 *          the toolbar shows the single "Set up model" affordance. NO
 *          modelNotConfigured toast, NO forced settings dialog.
 * State B: the llm slot names a model → the toolbar shows provider / model
 *          (never "Select Model"), and generation is enabled.
 *
 * The Playwright Chromium locale is en-US, so UI strings are English
 * ("Set up model" = settings.configureProvider, "Enter Classroom").
 */

const SCREENSHOT_DIR = 'e2e/screenshots';
const SETUP_CTA = 'Set up model';

test.describe.configure({ mode: 'serial' });

test.describe('#580 model-selection invariant', () => {
  test('State A: no language model → disabled generate + single Set-up affordance, no toast', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockModelSettings({ providers: {} });

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/model-config'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    // Single affordance is the toolbar "Set up model" CTA.
    await expect(page.getByText(SETUP_CTA, { exact: true })).toBeVisible();
    // No model pill (its aria-label would contain " / ").
    await expect(page.locator('button[aria-label*=" / "]')).toHaveCount(0);

    // Even with a requirement typed, generation stays disabled — and
    // crucially NO toast / forced dialog.
    await home.fillRequirement('Explain how photosynthesis works');
    await expect(home.enterButton).toBeDisabled();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/580-state-a-no-provider.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('State B: the llm slot names a model → model pill, generation enabled', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockModelSettings({
      providers: { openai: ['gpt-4o', 'gpt-4o-mini'] },
      llm: 'openai:gpt-4o',
    });

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/model-config'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    // The toolbar shows the model pill, never "Set up model"/"Select Model".
    const modelPill = page.locator('button[aria-label^="OpenAI / "]');
    await expect(modelPill).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SETUP_CTA, { exact: true })).toHaveCount(0);
    await expect(modelPill).toHaveAttribute('aria-label', /OpenAI \/ gpt-4o/);

    await home.fillRequirement('Explain how photosynthesis works');
    await expect(home.enterButton).toBeEnabled();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/580-state-b-usable-provider.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
