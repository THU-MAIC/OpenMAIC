import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';

/**
 * The settings store persists through the `@openmaic/storage` KVStore.
 *
 * Every other spec seeds the bare `settings-storage` key, which is what an
 * install from before the cutover looks like — so between them they cover the
 * one-time adoption well and the steady state not at all. These two cases pin
 * both ends: a store whose data is already in the KV scope must load without a
 * migration in sight, and a store still holding the raw key must end up with
 * its data moved rather than copied.
 *
 * The Playwright Chromium locale is en-US, so UI strings are English.
 */

// fetchServerProviders reads data.tts/asr/pdf/image/video/webSearch via
// Object.keys(); omitting them throws and is silently swallowed by its
// try/catch, so the mock must return the full shape.
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

const SETTINGS = createSettingsStorage({
  modelId: 'gpt-4o',
  providerId: 'openai',
  providersConfig: { openai: { apiKey: 'test-key' } },
  autoConfigApplied: true,
});

test.describe.configure({ mode: 'serial' });

test.describe('settings persistence through the KVStore', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: serverProvidersBody({ openai: { models: ['gpt-4o', 'gpt-4o-mini'] } }),
      }),
    );
  });

  test('loads a store already living in the KV scope, with no raw key present', async ({
    page,
  }) => {
    // The post-migration steady state: nothing under the pre-cutover key.
    await page.addInitScript(
      ({ key, settings }) => {
        localStorage.setItem(key, settings);
      },
      { key: SETTINGS_KV_KEY, settings: SETTINGS },
    );

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    // The seeded provider/model reached the UI, so hydration read the KV scope.
    const modelPill = page.locator('button[aria-label^="OpenAI / "]');
    await expect(modelPill).toBeVisible({ timeout: 15_000 });
    await expect(modelPill).toHaveAttribute('aria-label', /OpenAI \/ gpt-4o/);

    await home.fillRequirement('Explain how photosynthesis works');
    await expect(home.enterButton).toBeEnabled();

    // No migration ran, so nothing was written back under the raw key.
    expect(await page.evaluate(() => localStorage.getItem('settings-storage'))).toBeNull();
  });

  test('moves a pre-cutover raw key into the KV scope on first load', async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS);

    const home = new HomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.textarea).toBeVisible();

    const modelPill = page.locator('button[aria-label^="OpenAI / "]');
    await expect(modelPill).toBeVisible({ timeout: 15_000 });

    // A move, not a copy: the value is in the KV scope and the raw key is gone.
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw).state.providerId : undefined;
          }, SETTINGS_KV_KEY),
        { timeout: 15_000 },
      )
      .toBe('openai');
    expect(await page.evaluate(() => localStorage.getItem('settings-storage'))).toBeNull();
  });
});
