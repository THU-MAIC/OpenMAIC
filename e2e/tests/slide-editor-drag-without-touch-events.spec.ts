import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });
const SHAPE_ID = 'drag-box';

/**
 * Pro-mode element drag and resize in a browser without the Touch Events API.
 *
 * Desktop Safari does not define the `TouchEvent` global. The slide editor's
 * gesture hooks tested `instanceof TouchEvent` on mouse-down, which threw a
 * ReferenceError there, so no element could be dragged, resized or rotated.
 * Playwright's WebKit build does define `TouchEvent`, so the spec removes it
 * before the app loads to reproduce Safari's environment in any engine.
 */
async function openSeededEditor(page: Page): Promise<void> {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
    delete (window as { TouchEvent?: unknown }).TouchEvent;
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId('e2e-drag-no-touch');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Drag without touch events', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-drag',
        stageId,
        type: 'slide',
        title: 'Drag',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-drag',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            background: { type: 'solid', color: '#ffffff' },
            theme: defaultTheme,
            elements: [
              {
                id: SHAPE_ID,
                type: 'shape',
                left: 100,
                top: 100,
                width: 200,
                height: 120,
                rotate: 0,
                viewBox: [200, 200],
                path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
                fixedRatio: false,
                fill: '#3b82f6',
              },
            ],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });

  await page.goto(`/classroom/${stageId}`, { waitUntil: 'networkidle' });
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page
    .getByRole('switch', { name: /edit course/i })
    .first()
    .click();
}

async function dragBy(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe('Slide editor without the TouchEvent global (desktop Safari)', () => {
  test('a selected element can be dragged and resized', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openSeededEditor(page);
    expect(await page.evaluate(() => typeof window.TouchEvent)).toBe('undefined');

    const shape = page.locator(`#editable-element-${SHAPE_ID} .editable-element-shape`);
    await expect(shape).toBeVisible({ timeout: 20_000 });
    const start = await shape.boundingBox();
    if (!start) throw new Error('Shape has no bounding box');

    // Select, then drag the selected element.
    await page.mouse.click(start.x + start.width / 2, start.y + start.height / 2);
    await dragBy(page, start.x + start.width / 2, start.y + start.height / 2, 120, 60);
    await expect
      .poll(async () => {
        const box = await shape.boundingBox();
        return box && { dx: Math.round(box.x - start.x), dy: Math.round(box.y - start.y) };
      })
      .toEqual({ dx: 120, dy: 60 });

    // Resize from the bottom-right handle of the selection.
    const moved = await shape.boundingBox();
    if (!moved) throw new Error('Shape has no bounding box');
    const handles = await page.locator('.resize-handler').evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
        .map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })),
    );
    expect(handles.length).toBeGreaterThan(0);
    const corner = handles.reduce((a, b) => (b.x + b.y > a.x + a.y ? b : a));
    await dragBy(page, corner.x, corner.y, 40, 20);
    await expect
      .poll(async () => {
        const box = await shape.boundingBox();
        return box && box.width > moved.width + 30 && box.height > moved.height + 10;
      })
      .toBe(true);

    expect(pageErrors.filter((message) => message.includes('TouchEvent'))).toEqual([]);
  });
});
