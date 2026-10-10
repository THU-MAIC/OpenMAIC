import type { Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

async function seedCourse(page: Page, name: string): Promise<void> {
  const stageId = uniqueStageId('e2e-skeleton');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name, description: '', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        type: 'slide',
        title: name,
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: '#1e3a8a' },
            elements: [],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
}

/** Hold every `GET /api/stages` until the returned release is called. */
async function holdLibrary(page: Page): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let released = false;
  await page.route('**/api/stages', async (route) => {
    if (route.request().method() !== 'GET' || released) return route.fallback();
    held.push(route);
  });
  return async () => {
    released = true;
    while (held.length) await held.shift()!.fallback();
  };
}

const skeleton = (page: Page) => page.locator('[data-library-skeleton]');

test.describe('Home library skeleton', () => {
  test('shows the library layout while it loads, then the courses in the same place', async ({
    page,
  }) => {
    const name = `Skeleton ${crypto.randomUUID().slice(0, 6)}`;
    await page.goto('/', { waitUntil: 'networkidle' });
    await seedCourse(page, name);

    const release = await holdLibrary(page);
    await page.goto('/');
    await expect(skeleton(page)).toBeVisible();
    await expect(skeleton(page).locator('[data-skeleton-tile]')).toHaveCount(8);
    const tile = (await skeleton(page).locator('[data-skeleton-tile]').first().boundingBox())!;

    await release();
    const card = page.locator('.group.cursor-pointer').filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(skeleton(page)).toHaveCount(0);

    // The first tile of the loaded grid has the skeleton tile's footprint
    // (measured once the cards' entrance has finished).
    await page.waitForTimeout(800);
    const first = (await page
      .locator('.grid.gap-x-5.gap-y-8 > div')
      .first()
      .locator('.group.cursor-pointer')
      .boundingBox())!;
    expect(Math.abs(first.width - tile.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.height - tile.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.x - tile.x)).toBeLessThanOrEqual(1);
  });

  test('is on screen, with the hero, before the page scripts run', async ({ page }) => {
    // The page as painted from its server HTML: none of its scripts load.
    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.goto('/');
    await expect(skeleton(page)).toBeVisible();
    const logo = page.locator('img[alt="OpenMAIC"]');
    await expect(logo).toBeVisible();
    // The hero's entrance is CSS: it finishes without any script.
    await expect.poll(() => logo.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });

  test('is dark from the first paint in dark mode', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.goto('/');
    await expect(skeleton(page)).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await context.close();
  });

  test('an empty library shows the empty state, not a skeleton', async ({ page }) => {
    await page.route('**/api/stages', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { stages: [] } })
        : route.fallback(),
    );
    await page.route('**/api/folders', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { folders: [] } })
        : route.fallback(),
    );
    await page.goto('/');
    await expect(page.getByText(/No courses yet/)).toBeVisible();
    await expect(skeleton(page)).toHaveCount(0);
  });

  test('a library that cannot be read shows the error, not a skeleton', async ({ page }) => {
    await page.route('**/api/stages', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 500 }) : route.fallback(),
    );
    await page.goto('/');
    await expect(
      page.getByText('Saved classrooms could not be loaded', { exact: false }),
    ).toBeVisible();
    await expect(skeleton(page)).toHaveCount(0);
  });
});
