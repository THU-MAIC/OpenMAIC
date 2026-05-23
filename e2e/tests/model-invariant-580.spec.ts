import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

/**
 * #580 — "usable provider ⇒ a concrete model is always selected".
 *
 * State A: no usable provider (keyless ollama/lemonade no longer count until
 *          the user sets an explicit baseUrl) → generate button disabled, the
 *          toolbar shows the single "Set up model" affordance. NO
 *          modelNotConfigured toast, NO forced settings dialog.
 * State B: a server-configured provider → a concrete model is auto-resolved,
 *          the toolbar shows provider / model (never "Select Model"), and
 *          generation is enabled.
 *
 * The Playwright Chromium locale is en-US, so UI strings are English
 * ("Set up model" = settings.configureProvider, "Enter Classroom").
 */

const SCREENSHOT_DIR = 'e2e/screenshots';
const SETUP_CTA = 'Set up model';

// fetchServerProviders reads data.tts/asr/pdf/image/video/webSearch via
// Object.keys(); omitting them throws and is silently swallowed by its
// try/catch, so the mock must return the full shape (like the unit helper).
function serverProvidersBody(providers: Record<string, { models?: string[] }>) {
  return JSON.stringify({
    providers,
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
  });
}

// Run serially with one worker: a single shared dev server + async
// server-provider reconcile makes parallel runs flaky.
test.describe.configure({ mode: 'serial' });

test.describe('#580 model-selection invariant', () => {
  test('State A: no usable provider → disabled generate + single Set-up affordance, no toast', async ({
    page,
  }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: serverProvidersBody({}),
      }),
    );
    await page.addInitScript(
      (settings) => {
        localStorage.setItem('settings-storage', settings);
      },
      createSettingsStorage({
        modelId: '',
        providerId: 'openai',
        providersConfig: { openai: { apiKey: '' } },
        autoConfigApplied: true,
      }),
    );

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    // Single affordance is the toolbar "Set up model" CTA.
    await expect(page.getByText(SETUP_CTA, { exact: true })).toBeVisible();
    // No model pill (its aria-label would contain " / ").
    await expect(page.locator('button[aria-label*=" / "]')).toHaveCount(0);

    // Even with a requirement typed, generation stays disabled (gate is
    // hasUsableProvider, not modelId) — and crucially NO toast / forced dialog.
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

  test('State B: server-configured provider → concrete model auto-selected, generation enabled', async ({
    page,
  }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: serverProvidersBody({ openai: { models: ['gpt-4o', 'gpt-4o-mini'] } }),
      }),
    );
    await page.addInitScript(
      (settings) => {
        localStorage.setItem('settings-storage', settings);
      },
      createSettingsStorage({
        modelId: '',
        providerId: 'openai',
        providersConfig: { openai: { apiKey: '' } },
        autoConfigApplied: true,
      }),
    );

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    // Reconcile resolves (openai, '' → first server model 'gpt-4o'); the
    // toolbar shows the model pill, never "Set up model"/"Select Model".
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
