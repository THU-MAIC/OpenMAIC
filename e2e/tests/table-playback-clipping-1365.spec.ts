import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const STAGE_ID = 'e2e-table-clipping-1365';
const FINAL_ROW_TEXT = 'Issue1365FinalRow';
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

// At this width every first-column cell wraps to two lines. The element height
// sits between the old legacy table (~266px) and both aligned renderers (~146px).
const TABLE_WIDTH = 600;
const TABLE_HEIGHT = 180;
const TABLE_TOP = 370;
const TABLE_ROTATE = 0;
const ROW_TEXTS = [
  '课堂播放渲染链与缩略图渲染链必须在同一份幻灯片数据上给出一致的表格高度',
  '当单元格文本折行时旧实现的内边距与行高会把整张表格撑出元素盒子之外',
  '本行用于验证表格底部内容在教室视图中不会被幻灯片视口裁掉的回归场景',
  '两个渲染实现的行高都应由该行最高的单元格决定而不是由声明高度决定',
  '最后一行是报告者截图里丢失的那一行必须在两条渲染链中完整可见',
];

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
    ({ stageId, finalRowText, rowTexts, theme, geometry }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Table clipping regression',
            description: '',
            language: 'zh-CN',
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
                    top: geometry.top,
                    width: geometry.width,
                    height: geometry.height,
                    rotate: geometry.rotate,
                    colWidths: [0.5, 0.5],
                    rowHeights: [20, 20, 20, 20, 20],
                    cellMinHeight: 20,
                    outline: { width: 1, color: '#334155', style: 'solid' },
                    data: rowTexts.map((text, rowIndex) => [
                      {
                        id: `label-${rowIndex}`,
                        colspan: 1,
                        rowspan: 1,
                        text,
                        style: { fontsize: '14px' },
                      },
                      {
                        id: `value-${rowIndex}`,
                        colspan: 1,
                        rowspan: 1,
                        text:
                          rowIndex === rowTexts.length - 1 ? finalRowText : `Value${rowIndex + 1}`,
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
    {
      stageId: STAGE_ID,
      finalRowText: FINAL_ROW_TEXT,
      rowTexts: ROW_TEXTS,
      theme: defaultTheme,
      geometry: {
        top: TABLE_TOP,
        width: TABLE_WIDTH,
        height: TABLE_HEIGHT,
        rotate: TABLE_ROTATE,
      },
    },
  );
}

async function readSurface(locator: Locator) {
  await expect(locator).toHaveCount(1);

  return locator.evaluate((element) => {
    const table = element.querySelector('table');
    if (!table) throw new Error('Could not resolve the rendered HTML table');

    const rows = Array.from(table.querySelectorAll('tr'));
    const finalRow = rows.at(-1);
    if (!finalRow) throw new Error('Could not resolve the final table row');

    const wrappedRowCount = rows.filter((row) =>
      Array.from(row.querySelectorAll('td')).some((cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const fragments = Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          );
          if (fragments.length >= 2) return true;
        }
        return false;
      }),
    ).length;

    const elementRect = element.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const finalRowRect = finalRow.getBoundingClientRect();
    const overflowRatio = (bottom: number) =>
      Math.max(0, bottom - elementRect.bottom) / elementRect.height;

    return {
      rowCount: rows.length,
      wrappedRowCount,
      finalRowHeight: finalRowRect.height,
      tableOverflowRatio: overflowRatio(tableRect.bottom),
      finalRowOverflowRatio: overflowRatio(finalRowRect.bottom),
    };
  });
}

test('keeps wrapped table rows visible in the thumbnail and default classroom canvas', async ({
  page,
}, testInfo) => {
  expect(TABLE_ROTATE, 'bounding-box assertions require an unrotated fixture').toBe(0);

  await seedTableClassroom(page);
  await page.goto(`/classroom/${STAGE_ID}`);
  await page.getByText('Loading classroom...').waitFor({ state: 'hidden', timeout: 15_000 });

  const legacyTable = page
    .locator('.screen-element .base-element-table')
    .filter({ hasText: FINAL_ROW_TEXT });
  const thumbnailTable = page
    .locator('.thumbnail-slide .base-element-table')
    .filter({ hasText: FINAL_ROW_TEXT });
  const surfaces = {
    legacy: await readSurface(legacyTable),
    package: await readSurface(thumbnailTable),
  };

  await testInfo.attach('table clipping metrics', {
    body: JSON.stringify(surfaces, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('table clipping classroom', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  for (const [name, surface] of Object.entries(surfaces)) {
    expect(surface.rowCount, `${name}: row count`).toBe(ROW_TEXTS.length);
    expect(surface.wrappedRowCount, `${name}: wrapped row count`).toBe(ROW_TEXTS.length);
    expect(surface.finalRowHeight, `${name}: final row has visible geometry`).toBeGreaterThan(0);
    expect(surface.tableOverflowRatio, `${name}: table escapes its element`).toBeLessThanOrEqual(
      0.01,
    );
    expect(
      surface.finalRowOverflowRatio,
      `${name}: final row escapes its element`,
    ).toBeLessThanOrEqual(0.01);
  }

  expect(surfaces.package.rowCount).toBe(surfaces.legacy.rowCount);
});
