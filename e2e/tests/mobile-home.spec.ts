import { expect, test } from '@playwright/test';

test('mobile home keeps generation compact and opens the shared library in a drawer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const home = page.getByTestId('home-page');
  await expect(home).toHaveAttribute('data-mobile', 'true');
  const input = page.getByTestId('home-requirement');
  await expect(input).toBeVisible();
  await expect(input).toHaveCSS('font-size', '16px');
  const speech = page.locator('.home-speech');
  await expect(speech).toBeEnabled();
  expect(await speech.evaluate((element) => getComputedStyle(element).color)).toBe(
    await page
      .getByTestId('home-options-open')
      .evaluate((element) => getComputedStyle(element).color),
  );
  await input.fill('Learn Python from scratch');
  await page.getByTestId('home-options-open').click();
  await expect(page.getByTestId('home-mobile-options')).toBeVisible();
  expect(
    await page
      .getByTestId('home-mobile-options')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  const optionsBefore = await page.getByTestId('home-mobile-options').boundingBox();
  await page
    .locator('.home-mobile-teaching-options > div')
    .first()
    .locator('.cursor-pointer')
    .first()
    .click();
  await expect
    .poll(async () => (await page.getByTestId('home-mobile-options').boundingBox())!.height)
    .toBeCloseTo(optionsBefore!.height, 0);
  expect((await page.getByTestId('home-mobile-options').boundingBox())!.y).toBeCloseTo(
    optionsBefore!.y,
    0,
  );
  await expect(input).toHaveValue('Learn Python from scratch');
  await page.keyboard.press('Escape');
  await page.getByTestId('home-history-open').click();
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  await expect(page.getByTestId('home-mobile-search')).toBeVisible();
  await expect(page.getByTestId('home-course-import')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home-library-drawer')).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 430 });
  await input.focus();
  await expect
    .poll(async () => {
      const box = await input.boundingBox();
      return box!.y + box!.height;
    })
    .toBeLessThanOrEqual(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('desktop retains the inline course library and import action', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('home-page')).toHaveAttribute('data-mobile', 'false');
  await expect(page.getByTestId('home-history-open')).not.toBeVisible();
  await expect(page.getByTestId('home-course-import')).toBeVisible();
  await expect(page.getByTestId('home-library-inline')).toBeVisible();
});

test('mobile library searches shared courses and keeps course actions separate from opening', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/stages', (route) =>
    route.fulfill({
      json: {
        stages: [
          {
            id: 'mobile-home-python',
            name: 'Python basics',
            sceneCount: 3,
            createdAt: 1,
            updatedAt: 2,
          },
          { id: 'mobile-home-fourier', name: 'Fourier', sceneCount: 2, createdAt: 1, updatedAt: 1 },
        ],
      },
    }),
  );
  await page.route('**/classroom/mobile-home-python*', (route) => route.abort());
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  await page.getByTestId('home-mobile-search').fill('Python');
  await expect(page.getByRole('link', { name: 'Python basics', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fourier', exact: true })).not.toBeVisible();
  await page.locator('.home-course-more').click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  const navigation = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/classroom/mobile-home-python',
  );
  await page.getByRole('link', { name: 'Python basics', exact: true }).click();
  await navigation;
  await expect(page.getByTestId('home-library-drawer')).not.toBeVisible();
});

test('mobile language and theme reuse the desktop choices', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('.home-top-tools > button').click();
  await expect(page.getByRole('menuitem')).toHaveCount(12);
  await page.getByRole('menuitem', { name: 'English', exact: true }).click();
  await expect(page.locator('.home-mobile-heading')).toHaveText('What would you like to learn?');
  await page.locator('.home-top-tools > .relative > button').first().click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('mobile course rename receives focus and delete confirmation fits the card', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/stages', (route) =>
    route.fulfill({
      json: {
        stages: [
          {
            id: 'mobile-home-actions',
            name: 'Python basics',
            sceneCount: 3,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  await page.locator('.home-course-more').click();
  await page.getByRole('menuitem').first().click();
  const rename = page.locator('.home-course-meta input');
  await expect(rename).toBeFocused();
  await rename.press('Escape');
  await page.locator('.home-course-more').click();
  await page.getByRole('menuitem').last().click();
  const confirmation = page.locator('.home-mobile-delete-confirm');
  await expect(confirmation).toBeVisible();
  const card = await page.locator('.home-course-card').boundingBox();
  for (const button of await confirmation.getByRole('button').all()) {
    const rect = await button.boundingBox();
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(card!.y + card!.height);
    expect(rect!.x).toBeGreaterThanOrEqual(card!.x);
  }
  await confirmation.getByRole('button').first().click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Python basics', exact: true })).toBeVisible();
});

test('phone dialogs stay inside the visible viewport, including nested folder and settings panels', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/');
  const assertBounds = async (selector: string, height = 780) => {
    const panel = page.locator(selector).last();
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => panel.evaluate((e) => e.scrollWidth - e.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect.poll(async () => (await panel.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    const rect = await panel.boundingBox();
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(321);
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box!.y + box!.height;
      })
      .toBeLessThanOrEqual(height + 1);
  };
  await page.getByTestId('home-history-open').click();
  await page.locator('.home-library-scroll > button').click();
  await assertBounds('[data-slot="dialog-content"]:not(.home-library-drawer)');
  await expect(
    page.locator('[data-slot="dialog-content"]:not(.home-library-drawer) input'),
  ).toHaveCSS('font-size', '16px');
  await page.setViewportSize({ width: 320, height: 430 });
  await assertBounds('[data-slot="dialog-content"]:not(.home-library-drawer)', 430);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByTestId('home-options-open').click();
  await page
    .locator('.home-mobile-options button')
    .filter({ has: page.locator('svg.lucide-settings') })
    .click();
  await assertBounds('.home-settings-dialog');
  for (const item of await page.locator('[data-testid^="settings-nav-"]').all()) {
    await item.click();
    await assertBounds('.home-settings-dialog');
  }
});
