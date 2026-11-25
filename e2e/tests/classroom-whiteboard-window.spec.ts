/** The classroom whiteboard is a window: it opens over the stage and can be resized and moved. */
import { expect, test } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';

test('classroom whiteboard moves and resizes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ sidebarCollapsed: true }),
  );
  const stageId = uniqueStageId('e2e-whiteboard-window');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Whiteboard window', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-board',
        stageId,
        type: 'slide',
        title: 'Board',
        order: 0,
        actions: [],
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-board',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            background: { type: 'solid', color: '#ffffff' },
            theme: defaultTheme,
            elements: [],
          },
        },
      },
    ],
  });
  await page.goto(`/classroom/${stageId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  const title = page.locator('[data-window-drag]');
  await expect(title).toBeVisible();
  await title.hover();
  const sheet = title.locator('..');
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 15 });
    await page.mouse.up();
  };
  // It opens over the whole stage; dragging its corner makes it smaller.
  const opened = (await sheet.boundingBox())!;
  await drag(opened.x + opened.width - 3, opened.y + opened.height - 3, -360, -200);
  await expect
    .poll(async () => (await sheet.boundingBox())!.width)
    .toBeLessThan(opened.width - 300);
  const resized = (await sheet.boundingBox())!;
  expect(resized.height).toBeLessThan(opened.height - 150);
  // Dragging its title bar moves it, at the size it was given.
  await drag(resized.x + 240, resized.y + 28, 300, 120);
  await expect.poll(async () => (await sheet.boundingBox())!.x).toBeGreaterThan(resized.x + 200);
  const moved = (await sheet.boundingBox())!;
  expect(Math.abs(moved.width - resized.width)).toBeLessThan(2);
  expect(moved.y).toBeGreaterThan(resized.y + 80);
});
