import type { Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const COURSE_COUNT = 24;
/** COURSE_THUMBNAIL_CONCURRENCY in lib/hooks/use-course-thumbnails.ts. */
const THUMBNAIL_CONCURRENCY = 4;

/** Store a one-slide course as the page's owner. */
async function seedCourse(page: Page, stageId: string, name: string, updatedAt: number) {
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name,
      description: '',
      style: 'professional',
      createdAt: updatedAt,
      updatedAt,
    },
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
            id: `slide-${stageId}`,
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: '#1e3a8a' },
            elements: [],
          },
        },
        createdAt: updatedAt,
        updatedAt,
      },
    ],
    outline: { outlines: [], createdAt: updatedAt, updatedAt },
  });
}

async function seedLibrary(page: Page, prefix: string): Promise<string[]> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const names: string[] = [];
  const now = Date.now();
  for (let i = 0; i < COURSE_COUNT; i++) {
    const name = `${prefix} ${String(i).padStart(2, '0')}`;
    names.push(name);
    // Distinct times so the list order (newest first) is the seed order.
    await seedCourse(page, uniqueStageId('e2e-lazy-thumbnail'), name, now - i * 1000);
  }
  return names;
}

/** Thumbnails kept in the device cache (`maic-device-cache`). */
function cachedThumbnailCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('maic-device-cache');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('courseThumbnails')) {
            database.close();
            resolve(0);
            return;
          }
          const count = database
            .transaction('courseThumbnails')
            .objectStore('courseThumbnails')
            .count();
          count.onsuccess = () => {
            database.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

test.describe('Home library loading', () => {
  test('lists every course before any course content loads, then loads thumbnails lazily and bounded', async ({
    page,
  }) => {
    const prefix = `Lazy ${crypto.randomUUID().slice(0, 6)}`;
    const names = await seedLibrary(page, prefix);

    // Hold every course document read until the test releases it.
    const held: Route[] = [];
    const requested: string[] = [];
    await page.route('**/api/persistence/documents/*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      requested.push(new URL(route.request().url()).pathname);
      held.push(route);
    });
    const releaseAll = async () => {
      while (held.length) await held.shift()!.continue();
    };

    await page.goto('/');
    const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });

    // The whole list renders while no course content has been served.
    await expect(cards).toHaveCount(COURSE_COUNT);
    for (const name of [names[0], names[COURSE_COUNT - 1]]) {
      await expect(cards.filter({ hasText: name })).toHaveCount(1);
    }
    await expect(cards.first().locator('[data-thumbnail-state="loading"]')).toBeVisible();

    // Loads are bounded: only `THUMBNAIL_CONCURRENCY` are in flight however
    // many cards are on screen.
    await expect.poll(() => held.length).toBe(THUMBNAIL_CONCURRENCY);
    await page.waitForTimeout(500);
    expect(held.length).toBe(THUMBNAIL_CONCURRENCY);

    // ...and lazy: releasing them loads the cards near the viewport, not the
    // whole library.
    await expect
      .poll(async () => {
        await releaseAll();
        return held.length;
      })
      .toBe(0);
    await page.waitForTimeout(500);
    await releaseAll();
    await expect(cards.first().locator('[data-thumbnail-state="loading"]')).toHaveCount(0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThan(COURSE_COUNT);

    // Scrolling the last card into view loads its thumbnail.
    const last = cards.filter({ hasText: names[COURSE_COUNT - 1] });
    await last.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        await releaseAll();
        return last.locator('[data-thumbnail-state="loading"]').count();
      })
      .toBe(0);
  });

  test('a reload shows unchanged courses from the device cache and reads only a changed one', async ({
    page,
  }) => {
    const prefix = `Cached ${crypto.randomUUID().slice(0, 6)}`;
    await page.goto('/', { waitUntil: 'networkidle' });
    const now = Date.now();
    const ids = [0, 1, 2].map(() => uniqueStageId('e2e-cached-thumbnail'));
    for (const [i, id] of ids.entries()) {
      await seedCourse(page, id, `${prefix} ${i}`, now - i * 1000);
    }
    const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });
    const documentReads: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path.startsWith('/api/persistence/documents/')) {
        documentReads.push(decodeURIComponent(path.split('/').pop()!));
      }
    });
    const loaded = async () => {
      await expect(cards).toHaveCount(ids.length);
      await expect(cards.locator('[data-thumbnail-state="loading"]')).toHaveCount(0);
    };

    await page.goto('/');
    await loaded();
    expect(documentReads.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    await expect.poll(() => cachedThumbnailCount(page)).toBeGreaterThanOrEqual(ids.length);

    // Nothing changed: every thumbnail comes from the device cache.
    documentReads.length = 0;
    await page.reload();
    await loaded();
    expect(documentReads.filter((id) => ids.includes(id))).toEqual([]);

    // One course changed: only that one is read again.
    await seedCourse(page, ids[1]!, `${prefix} 1`, now + 5000);
    documentReads.length = 0;
    await page.reload();
    await loaded();
    expect(documentReads.filter((id) => ids.includes(id))).toEqual([ids[1]]);
  });
});
