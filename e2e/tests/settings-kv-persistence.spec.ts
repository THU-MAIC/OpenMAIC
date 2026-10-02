import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage, SETTINGS_KV_KEY } from '../fixtures/test-data/settings';

/**
 * The settings store persists through the `@openmaic/storage` KVStore, and does
 * not migrate pre-cutover data. These two cases pin both facts: a store whose
 * data is already in the KV scope loads it, and a store still holding the old
 * raw `settings-storage` blob has it ignored and purged rather than migrated.
 *
 * The Playwright Chromium locale is en-US, so UI strings are English.
 */

const SETTINGS = createSettingsStorage({ reviewOutlineEnabled: true, playbackSpeed: 1.5 });

test.describe.configure({ mode: 'serial' });

test.describe('settings persistence through the KVStore', () => {
  test('loads a store already living in the KV scope, with no raw key present', async ({
    page,
  }) => {
    // The steady state: the value is in the KV scope, nothing under the raw key.
    await page.addInitScript(
      ({ key, settings }) => {
        localStorage.setItem(key, settings);
      },
      { key: SETTINGS_KV_KEY, settings: SETTINGS },
    );

    const home = new HomePage(page);
    await home.goto();
    await expect(home.textarea).toBeVisible();

    // The store reads the KV scope and leaves the value there.
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw)?.state?.playbackSpeed : undefined;
          }, SETTINGS_KV_KEY),
        { timeout: 15_000 },
      )
      .toBe(1.5);

    // Nothing was written under the raw key.
    expect(await page.evaluate(() => localStorage.getItem('settings-storage'))).toBeNull();
  });

  test('ignores a pre-cutover raw key and purges it on first load', async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS);

    const home = new HomePage(page);
    await home.goto();
    await expect(home.textarea).toBeVisible();

    // No migration: the raw blob is not read, and it is best-effort purged
    // (in earlier builds it held plaintext provider API keys).
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('settings-storage')), {
        timeout: 15_000,
      })
      .toBeNull();

    // And the seeded value never reached the KV scope.
    const leaked = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw)?.state?.playbackSpeed : undefined;
    }, SETTINGS_KV_KEY);
    expect(leaked).not.toBe(1.5);
  });
});
