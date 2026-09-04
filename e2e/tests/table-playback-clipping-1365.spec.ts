import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const STAGE_ID = 'e2e-table-clipping-1365';
const FINAL_ROW_TEXT = 'Issue1365FinalRow';
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

async function seedTableClassroom(page: Page) {
  await page.addInitScript(
    ({ settings }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    { settings: SETTINGS_STORAGE },
  );

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId, finalRowText, theme }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();
          const labels = ['Header', 'Route', 'Hypothesis', 'Evidence', finalRowText];

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Table clipping regression',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
            id: 'scene-table',
            stageId,
            type: 'slide',
            title: 'Table clipping regression',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-table',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                background: { type: 'solid', color: '#ffffff' },
                theme,
                elements: [
                  {
                    id: 'table-near-bottom',
                    type: 'table',
                    left: 50,
                    top: 460,
                    width: 900,
                    height: 100,
                    rotate: 0,
                    colWidths: [0.5, 0.5],
                    rowHeights: [20, 20, 20, 20, 20],
                    cellMinHeight: 20,
                    outline: { width: 1, color: '#334155', style: 'solid' },
                    data: labels.map((label, rowIndex) => [
                      {
                        id: `label-${rowIndex}`,
                        colspan: 1,
                        rowspan: 1,
                        text: label,
                        style: { fontsize: '14px' },
                      },
                      {
                        id: `value-${rowIndex}`,
                        colspan: 1,
                        rowspan: 1,
                        text: `Value${rowIndex + 1}`,
                        style: { fontsize: '14px' },
                      },
                    ]),
                  },
                ],
              },
            },
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: STAGE_ID, finalRowText: FINAL_ROW_TEXT, theme: defaultTheme },
  );
}

test('keeps the final table row visible in the thumbnail and default classroom canvas', async ({
  page,
}, testInfo) => {
  await seedTableClassroom(page);
  await page.goto(`/classroom/${STAGE_ID}`);
  await page.getByText('Loading classroom...').waitFor({ state: 'hidden', timeout: 15_000 });

  const renderedTables = page.locator('.base-element-table').filter({ hasText: FINAL_ROW_TEXT });
  await expect(renderedTables).toHaveCount(2);

  const metrics = await renderedTables.evaluateAll((tables) =>
    tables
      .map((element) => {
        const table = element.querySelector('table');
        if (!table) throw new Error('Could not resolve the rendered HTML table');

        const rows = Array.from(table.querySelectorAll('tr'));
        const finalRow = rows.at(-1);
        const finalCell = finalRow?.querySelector('td');
        const finalCellInner = finalCell?.firstElementChild;
        const tableRect = table.getBoundingClientRect();
        const rowRect = finalRow?.getBoundingClientRect();
        const cellRect = finalCell?.getBoundingClientRect();
        const cellInnerRect = finalCellInner?.getBoundingClientRect();
        const textRange = document.createRange();
        if (finalCellInner) textRange.selectNodeContents(finalCellInner);
        const textRect = textRange.getBoundingClientRect();

        let clippingBoundary = element.parentElement;
        while (clippingBoundary) {
          const style = getComputedStyle(clippingBoundary);
          if (
            style.overflow === 'hidden' ||
            style.overflowX === 'hidden' ||
            style.overflowY === 'hidden'
          ) {
            break;
          }
          clippingBoundary = clippingBoundary.parentElement;
        }

        if (!rowRect || !cellRect || !cellInnerRect || !clippingBoundary) {
          throw new Error(
            'Could not resolve the rendered table row, cell, inner content, and slide clipping boundary',
          );
        }

        const boundaryRect = clippingBoundary.getBoundingClientRect();
        const visibleTop = Math.max(rowRect.top, boundaryRect.top);
        const visibleBottom = Math.min(rowRect.bottom, boundaryRect.bottom);

        return {
          width: tableRect.width,
          rowCount: rows.length,
          tableBottom: tableRect.bottom,
          boundaryBottom: boundaryRect.bottom,
          finalRowHeight: rowRect.height,
          finalRowVisibleHeight: Math.max(0, visibleBottom - visibleTop),
          finalTextHeight: textRect.height,
          finalTextVisibleHeight: Math.max(
            0,
            Math.min(textRect.bottom, boundaryRect.bottom) -
              Math.max(textRect.top, boundaryRect.top),
          ),
          renderer: element.closest('.screen-element') ? 'legacy' : 'package',
        };
      })
      .sort((left, right) => right.width - left.width),
  );

  await testInfo.attach('table clipping metrics', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('table clipping classroom', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  const [classroom, thumbnail] = metrics;
  expect(classroom.renderer).toBe('legacy');
  expect(thumbnail.renderer).toBe('package');
  expect(classroom.rowCount).toBe(5);
  expect(thumbnail.rowCount).toBe(classroom.rowCount);

  for (const surface of [classroom, thumbnail]) {
    expect(surface.tableBottom).toBeLessThanOrEqual(surface.boundaryBottom + 1);
    expect(surface.finalRowVisibleHeight).toBeGreaterThanOrEqual(surface.finalRowHeight - 1);
    expect(surface.finalTextHeight).toBeGreaterThan(0);
    expect(surface.finalTextVisibleHeight).toBeGreaterThanOrEqual(surface.finalTextHeight - 1);
  }
});
