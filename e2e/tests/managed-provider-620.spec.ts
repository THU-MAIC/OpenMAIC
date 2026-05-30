import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

/**
 * #620 — server-configured providers are admin-managed and not client-overridable.
 *
 * Managed provider  (openai, present in /api/server-providers): the settings panel
 *   shows the "managed by server" notice and HIDES the API key / base-URL override
 *   inputs.
 * Unmanaged provider (anthropic, absent from /api/server-providers): the panel keeps
 *   the editable API key / base-URL inputs.
 *
 * Playwright Chromium locale is en-US.
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

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

test.describe.configure({ mode: 'serial' });

test.describe('#620 managed providers are read-only', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        // Only openai is server-configured (managed); anthropic is not.
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
        providersConfig: {
          openai: { apiKey: '' },
          anthropic: { apiKey: 'sk-ant-local' },
        },
        autoConfigApplied: true,
      }),
    );
  });

  async function openProviderSettings(page: HomePage['page']) {
    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.textarea).toBeVisible();
    // Header gear button opens the settings dialog (defaults to the Providers section).
    await page.locator('button:has(svg.lucide-settings)').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }

  test('managed provider (openai) hides the key / base-URL override inputs', async ({ page }) => {
    await openProviderSettings(page);

    // openai is the selected provider (store providerId) and is server-managed:
    // the override inputs must be absent.
    await expect(page.locator('input[name="llm-api-key-openai"]')).toHaveCount(0);
    await expect(page.locator('input[name="llm-base-url-openai"]')).toHaveCount(0);
    // The mock pins an allowed model list, so the catalog is locked too:
    // no add/reset affordance, and the pinned models are shown read-only.
    await expect(page.getByRole('button', { name: /new model/i })).toHaveCount(0);
    await expect(page.getByText('gpt-4o', { exact: true })).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/620-managed-openai-readonly.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('unmanaged provider (anthropic) keeps the editable inputs', async ({ page }) => {
    await openProviderSettings(page);

    // anthropic is displayed as "Claude" in the provider list.
    await page
      .getByRole('button', { name: /claude/i })
      .first()
      .click();

    await expect(page.locator('input[name="llm-api-key-anthropic"]')).toBeVisible();
    await expect(page.locator('input[name="llm-base-url-anthropic"]')).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/620-unmanaged-anthropic-editable.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
