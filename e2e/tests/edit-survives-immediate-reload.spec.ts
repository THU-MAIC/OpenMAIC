import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { readServerDocument, seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });
const SHAPE_ID = 'reload-box';
const SCENE_ID = 'scene-reload';

/**
 * An edit followed at once by a reload must reach the server.
 *
 * The autosave waits 500 ms after the last change, and its regular write reads
 * the document before writing it. A reload inside that window used to abort
 * the read, so the write was never sent and the edit was gone after the
 * reload. The page now writes pending changes directly, with requests that
 * outlive the page, when it unloads.
 */
async function openSeededEditor(page: Page): Promise<string> {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId('e2e-reload-save');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Reload right after an edit', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: SCENE_ID,
        stageId,
        type: 'slide',
        title: 'Reload',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-reload',
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
  return stageId;
}

async function storedShapePosition(
  page: Page,
  stageId: string,
): Promise<{ left: number; top: number } | null> {
  const document = await readServerDocument(page, stageId);
  const scene = document?.scenes.find((candidate) => candidate.id === SCENE_ID) as
    | { content: { canvas: { elements: Array<{ id: string; left: number; top: number }> } } }
    | undefined;
  const shape = scene?.content.canvas.elements.find((element) => element.id === SHAPE_ID);
  return shape ? { left: shape.left, top: shape.top } : null;
}

test.describe('Edits made just before a page unload', () => {
  test('a slide edit followed at once by a reload is kept', async ({ page }) => {
    const stageId = await openSeededEditor(page);

    const shape = page.locator(`#editable-element-${SHAPE_ID} .editable-element-shape`);
    await expect(shape).toBeVisible({ timeout: 20_000 });
    const box = await shape.boundingBox();
    if (!box) throw new Error('Shape has no bounding box');

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120, y + 60, { steps: 10 });
    await page.mouse.up();
    // The move is on screen, so the editor committed it to the course.
    await expect
      .poll(async () => {
        const moved = await shape.boundingBox();
        return moved && Math.round(moved.x - box.x);
      })
      .toBe(120);

    // Reload well inside the autosave's 500 ms debounce.
    await page.reload({ waitUntil: 'load' });

    // The write that carries the move may still be landing: give it a moment,
    // but the shape must end up where it was dropped.
    await expect
      .poll(
        async () => {
          const stored = await storedShapePosition(page, stageId);
          return stored !== null && stored.left > 100 && stored.top > 100;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  });
});
