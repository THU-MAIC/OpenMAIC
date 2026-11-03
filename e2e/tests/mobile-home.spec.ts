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
  await expect
    .poll(async () => {
      const color = await speech.evaluate((element) => getComputedStyle(element).color);
      return (
        color ===
        (await page
          .getByTestId('home-options-open')
          .evaluate((element) => getComputedStyle(element).color))
      );
    })
    .toBe(true);
  await input.fill('Learn Python from scratch');
  await page.getByTestId('home-options-open').click();
  await expect(page.getByTestId('home-mobile-options')).toBeVisible();
  expect(
    await page
      .getByTestId('home-mobile-options')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page
    .getByTestId('home-mobile-options')
    .evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
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
  await expect(page.getByRole('menuitem')).toHaveCount(3);
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
  const initialCard = await page.locator('.home-course-card').boundingBox();
  expect(initialCard!.height).toBeLessThanOrEqual(104);
  await expect(page.locator('.home-mobile-card-actions button')).toHaveCount(1);
  const more = await page.locator('.home-course-more').boundingBox();
  expect(
    Math.abs(more!.y + more!.height / 2 - (initialCard!.y + initialCard!.height / 2)),
  ).toBeLessThan(2);
  await page.locator('.home-course-more').click();
  await page.getByRole('menuitem').first().click();
  const rename = page.locator('.home-course-meta input');
  await expect(rename).toBeFocused();
  await rename.press('Escape');
  await page.locator('.home-course-more').click();
  await page.getByRole('menuitem').last().click();
  const confirmation = page.locator('.home-mobile-delete-confirm');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Python basics');
  const card = await page.locator('.home-course-card').boundingBox();
  expect(card!.height).toBeCloseTo(initialCard!.height, 0);
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
  await page.getByTestId('home-new-folder').click();
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

test('narrow course rows retain long titles and a stable contextual deletion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const name = 'Photosynthesis: how plants turn light into energy';
  await page.route('**/api/stages', (route) =>
    route.fulfill({
      json: {
        stages: [
          { id: 'compact-long', name, sceneCount: 9, createdAt: 1, updatedAt: 2 },
          { id: 'compact-next', name: 'Next course', sceneCount: 3, createdAt: 1, updatedAt: 1 },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  const card = page.getByRole('link', { name, exact: true });
  const next = page.getByRole('link', { name: 'Next course', exact: true });
  await expect(card).toBeVisible();
  await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  const rect = await card.boundingBox();
  expect(rect!.height).toBeLessThanOrEqual(104);
  const title = card.locator('.home-course-meta > p');
  await expect(title).toHaveCSS('-webkit-line-clamp', '2');
  await expect(title).toHaveCSS('font-size', '15px');
  const thumb = await card.locator('.home-course-thumbnail').boundingBox();
  expect(thumb!.width).toBeCloseTo(80, 0);
  expect(thumb!.height).toBeCloseTo(50, 0);
  await card.locator('.home-course-more').click();
  await page.getByRole('menuitem', { name: 'Move to folder', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Back', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Ungrouped', exact: true })).toBeVisible();
  for (const menu of await page.getByRole('menu').all()) {
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  const folderName = page.locator('[data-slot="dialog-content"]:not(.home-library-drawer) input');
  await expect(folderName).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  const nextBefore = await next.boundingBox();
  await card.locator('.home-course-more').click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const confirmation = card.getByRole('alert');
  await expect(confirmation).toContainText(name);
  expect((await next.boundingBox())!.y).toBeCloseTo(nextBefore!.y, 0);
  for (const button of await confirmation.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(rect!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(rect!.x + rect!.width);
  }
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  expect((await next.boundingBox())!.y).toBeCloseTo(nextBefore!.y, 0);
});

test('paused generation rows show a continuation affordance without another action row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const name = 'Create a course about photosynthesis and plant growth';
  await page.route('**/api/stages', (route) => route.fulfill({ json: { stages: [] } }));
  await page.route('**/api/generation-runs?active=1', (route) =>
    route.fulfill({
      json: {
        success: true,
        runs: [
          {
            id: 'compact-paused',
            state: 'paused',
            step: 'outline',
            seq: 1,
            input: { requirement: name },
            outline: null,
            agents: null,
            stageId: null,
            progress: { scenesTotal: 0, scenesCompleted: 0 },
            error: null,
            createdAt: '2026-10-26T05:00:00Z',
            updatedAt: '2026-10-26T05:00:00Z',
          },
        ],
        limits: { maxActive: 2, maxWaiting: 10 },
      },
    }),
  );
  await page.route('**/api/generation-runs/events', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  );
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  const card = page.getByRole('link', { name, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('.home-course-resume')).toHaveText('Continue generation');
  await expect(card.locator('.home-mobile-card-actions button')).toHaveCount(1);
  const rect = await card.boundingBox();
  expect(await card.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(rect!.width);
  expect(rect!.height).toBeLessThanOrEqual(120);
  await card.locator('.home-course-more').click();
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
});

test('phone folders are compact rows with creation in the header and stable management', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      json: {
        folders: [
          { id: 'compact-math', name: 'Mathematics', order: 0, createdAt: 1, updatedAt: 1 },
        ],
      },
    }),
  );
  await page.route('**/api/stages', (route) => route.fulfill({ json: { stages: [] } }));
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  const row = page.getByTestId('home-folder-row');
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(72);
  await expect(row).toContainText('Mathematics');
  await expect(row).toContainText('0');
  await expect(row.locator('canvas')).toHaveCount(0);
  const create = page.getByTestId('home-new-folder');
  await expect(create).toBeVisible();
  const createBox = (await create.boundingBox())!;
  expect(createBox.y).toBeLessThan(box!.y);
  const closeBox = (await page
    .locator('.home-library-drawer > [data-slot="dialog-close"]')
    .boundingBox())!;
  expect(createBox.y + createBox.height / 2).toBeCloseTo(closeBox.y + closeBox.height / 2, 0);
  await expect(page.locator('.home-library-scroll > button')).toHaveCount(0);
  await row.locator('.home-folder-icon').click();
  await expect(row).not.toBeVisible();
  await page.locator('.home-folder-back').click();
  await expect(row).toBeVisible();
  await row.locator('.home-folder-more').click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(row.locator('input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  await expect(row.locator('input')).not.toBeVisible();
  await row.locator('.home-folder-more').click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('Mathematics');
  const confirmBox = await confirmation.boundingBox();
  expect(confirmBox!.x).toBeGreaterThanOrEqual(0);
  expect(confirmBox!.x + confirmBox!.width).toBeLessThanOrEqual(320);
  expect((await row.boundingBox())!.height).toBeCloseTo(box!.height, 0);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(row.locator('.home-folder-more')).toBeFocused();
  expect(
    await page.locator('.home-library-scroll').evaluate((e) => e.scrollWidth - e.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test('nonempty phone folders distinguish keeping courses from removing them', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  let deleted = false;
  let deletionMode: string | null = null;
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      json: {
        folders: deleted
          ? []
          : [{ id: 'occupied-folder', name: 'Math', order: 0, createdAt: 1, updatedAt: 1 }],
      },
    }),
  );
  await page.route('**/api/folders/occupied-folder?*', (route) => {
    deletionMode = new URL(route.request().url()).searchParams.get('mode');
    deleted = true;
    return route.fulfill({ json: { removedStageIds: [] } });
  });
  await page.route('**/api/stages', (route) =>
    route.fulfill({
      json: {
        stages: [
          {
            id: 'folder-member',
            name: 'Algebra',
            folderId: deleted ? undefined : 'occupied-folder',
            sceneCount: 3,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByTestId('home-history-open').click();
  const row = page.getByTestId('home-folder-row');
  await expect(row).toContainText('1 courses');
  await row.locator('.home-folder-more').click();
  const remove = page.getByRole('menuitem', { name: 'Delete folder and 1 course', exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('including chat history');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(deletionMode).toBeNull();
  await expect(page.getByTestId('home-library-drawer')).toBeVisible();
  await row.locator('.home-folder-more').click();
  await page.getByRole('menuitem').filter({ hasText: 'Delete folder only' }).click();
  await expect.poll(() => deletionMode).toBe('ungroup');
  await expect(row).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Algebra', exact: true })).toBeVisible();
});

test.describe('touch folder dialogs', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const action of ['cancel', 'close', 'escape', 'outside'] as const) {
    test(`closing new folder with ${action} preserves the recent-learning drawer`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await page.getByTestId('home-history-open').tap();
      const drawer = page.getByTestId('home-library-drawer');
      await page.getByTestId('home-new-folder').tap();
      const dialog = page.locator('[data-slot="dialog-content"]:not(.home-library-drawer)');
      await expect(dialog).toBeVisible();
      await dialog.locator('input').fill('Draft folder');
      if (action === 'cancel')
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
      if (action === 'close') await dialog.locator('[data-slot="dialog-close"]').tap();
      if (action === 'escape') await page.keyboard.press('Escape');
      if (action === 'outside')
        await page
          .locator('[data-slot="dialog-overlay"]')
          .last()
          .tap({ position: { x: 380, y: 10 } });
      await expect(dialog).not.toBeVisible();
      await expect(drawer).toBeVisible();
      await expect(page.getByTestId('home-new-folder')).toBeFocused();
      await drawer.locator('[data-slot="dialog-close"]').tap();
      await expect(drawer).not.toBeVisible();
    });
  }
});

test.describe('phone rotation', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('phone rotation retains mobile layout and desktop settings has its own label', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-mobile', 'true');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId('home-page')).toHaveAttribute('data-mobile', 'true');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.home-desktop-settings button')).toHaveAccessibleName('Settings');
  });
});

test.describe('phone horizontal safe areas', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const direction of ['ltr', 'rtl'] as const) {
    test(`keeps both primary controls inside asymmetric landscape insets (${direction})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 844, height: 390 });
      await page.goto('/');
      const home = page.getByTestId('home-page');
      await expect(home).toHaveAttribute('data-mobile', 'true');
      for (const [left, right] of [
        [59, 34],
        [34, 59],
        [0, 0],
      ]) {
        await page.evaluate(
          ({ direction, left, right }) => {
            document.documentElement.dir = direction;
            document.documentElement.style.setProperty('--safe-area-left', `${left}px`);
            document.documentElement.style.setProperty('--safe-area-right', `${right}px`);
          },
          { direction, left, right },
        );
        const history = page.getByTestId('home-history-open');
        const toolbar = page.locator('.home-top-tools');
        const startInset = direction === 'ltr' ? left : right;
        const endInset = direction === 'ltr' ? right : left;
        await expect
          .poll(async () => {
            const box = (await history.boundingBox())!;
            return direction === 'ltr' ? box.x : 844 - box.x - box.width;
          })
          .toBeCloseTo(Math.max(12, startInset), 0);
        await expect
          .poll(async () => {
            const box = (await toolbar.boundingBox())!;
            return direction === 'ltr' ? 844 - box.x - box.width : box.x;
          })
          .toBeCloseTo(Math.max(12, endInset), 0);
        await expect(home).toHaveCSS('padding-left', `${Math.max(16, left)}px`);
        await expect(home).toHaveCSS('padding-right', `${Math.max(16, right)}px`);
      }
    });
  }
});

test.describe('phone portal safe areas', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const direction of ['ltr', 'rtl'] as const) {
    test(`keeps options and nested phone panels inside physical safe bounds (${direction})`, async ({
      page,
    }) => {
      await page.route('**/api/folders', (route) =>
        route.fulfill({
          json: {
            folders: [
              { id: 'safe-folder', name: 'Safe folder', order: 0, createdAt: 1, updatedAt: 1 },
            ],
          },
        }),
      );
      await page.route('**/api/stages', (route) => route.fulfill({ json: { stages: [] } }));
      for (const [width, height, left, right] of [
        [844, 390, 59, 34],
        [844, 390, 34, 59],
        [844, 390, 0, 0],
        [390, 844, 59, 34],
        [390, 844, 0, 0],
      ]) {
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await expect(page.getByTestId('home-page')).toHaveAttribute('data-mobile', 'true');
        await page.evaluate(
          ({ direction, left, right }) => {
            document.documentElement.dir = direction;
            document.documentElement.style.setProperty('--safe-area-left', `${left}px`);
            document.documentElement.style.setProperty('--safe-area-right', `${right}px`);
          },
          { direction, left, right },
        );
        const assertBounds = async (panel: ReturnType<typeof page.locator>, gutter = 0) => {
          await expect(panel).toBeVisible();
          await expect
            .poll(async () => (await panel.boundingBox())!.x)
            .toBeGreaterThanOrEqual(Math.max(gutter, left));
          await expect
            .poll(async () => {
              const box = (await panel.boundingBox())!;
              return box.x + box.width;
            })
            .toBeLessThanOrEqual(width - Math.max(gutter, right) + 1);
          expect(await panel.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
        };
        await page.getByTestId('home-options-open').click();
        const options = page.getByTestId('home-mobile-options');
        await assertBounds(options, 12);
        await options.getByRole('button', { name: 'All settings', exact: true }).click();
        const settings = page.locator('.home-settings-dialog');
        await assertBounds(settings);
        await settings.locator('button[aria-label="Close"]').click();
        await page.getByTestId('home-history-open').click();
        const drawer = page.getByTestId('home-library-drawer');
        await assertBounds(drawer);
        await page.getByTestId('home-new-folder').click();
        const folderDialog = page.locator(
          '[data-slot="dialog-content"]:not(.home-library-drawer):not(.home-mobile-options):not(.home-settings-dialog)',
        );
        await assertBounds(folderDialog, 12);
        await folderDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByTestId('home-folder-row').locator('.home-folder-more').click();
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        await assertBounds(page.getByRole('alertdialog'), 12);
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await drawer.locator('[data-slot="dialog-close"]').click();
      }
    });
  }
});

test('phone home keeps its layout unchanged when only the keyboard viewport changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (
      window as unknown as { setKeyboardViewport: (height: number, offsetTop: number) => void }
    ).setKeyboardViewport = (height, offsetTop) => {
      Object.assign(viewport, { height, offsetTop });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
  await page.goto('/');
  const home = page.getByTestId('home-page');
  await expect(home).toHaveAttribute('data-mobile', 'true');
  await page.getByTestId('home-requirement').fill('Keep my draft');
  const before = await home.boundingBox();
  for (const [height, offsetTop] of [
    [430, 0],
    [430, 110],
    [490, 60],
    [844, 0],
  ]) {
    await page.evaluate(
      ({ height, offsetTop }) => {
        (
          window as unknown as { setKeyboardViewport: (height: number, offsetTop: number) => void }
        ).setKeyboardViewport(height, offsetTop);
      },
      { height, offsetTop },
    );
    // Let the shared viewport event queue flush before checking for unwanted mutations.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(home).not.toHaveAttribute('data-keyboard');
    expect(await home.boundingBox()).toEqual(before);
    await expect(page.locator('.home-mobile-heading')).toBeVisible();
    await expect(page.locator('.home-brand img')).toHaveCSS('width', '190px');
    await expect(page.locator('.home-slogan')).toHaveCSS('font-size', '14px');
    expect(
      await home.evaluate((element) => {
        const touch = (type: string, y: number) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: [{ clientX: 100, clientY: y }] });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        };
        touch('touchstart', 200);
        return touch('touchmove', 250);
      }),
    ).toBe(true);
  }
  await expect(page.getByTestId('home-requirement')).toHaveValue('Keep my draft');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(home).toHaveAttribute('data-mobile', 'false');
  expect(
    await home.evaluate((element) => {
      for (const [type, y] of [
        ['touchstart', 200],
        ['touchmove', 250],
      ] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: [{ clientX: 100, clientY: y }] });
        element.dispatchEvent(event);
        if (type === 'touchmove') return event.defaultPrevented;
      }
      return false;
    }),
  ).toBe(false);
});
