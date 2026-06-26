import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { ensureMaicDatabase, setSettingsStorage } from '../fixtures/browser-storage';

const TEST_STAGE_ID = 'e2e-interactive-stage';
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

const INTERACTIVE_HTML = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Simulation Smoke</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
      }
      .simulation-shell {
        display: grid;
        grid-template-columns: minmax(220px, 320px) 1fr;
        gap: 18px;
        align-items: start;
      }
      .panel {
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 16px;
        padding: 16px;
      }
      .badge {
        display: inline-flex;
        max-width: 260px;
        padding: 6px 10px;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
        font-weight: 700;
      }
      .simulation-stage {
        position: relative;
        min-height: 520px;
        border-radius: 20px;
        border: 1px solid #cbd5e1;
        background:
          radial-gradient(circle at top left, rgba(59, 130, 246, 0.12), transparent 35%),
          linear-gradient(180deg, #eff6ff 0%, #ffffff 100%);
      }
      .toolbar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        background: #fef3c7;
        color: #92400e;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 700;
      }
      .overlay-card {
        position: absolute;
        right: 16px;
        top: 16px;
        width: min(42%, 280px);
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid #bfdbfe;
        border-radius: 16px;
        padding: 14px;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.12);
      }
      .stage-copy {
        position: absolute;
        left: 18px;
        bottom: 18px;
        max-width: 58%;
        background: rgba(15, 23, 42, 0.82);
        color: #fff;
        border-radius: 16px;
        padding: 14px 16px;
      }
      @media (max-width: 700px) {
        .simulation-shell {
          grid-template-columns: 1fr;
        }
        .overlay-card,
        .stage-copy {
          position: static;
          width: auto;
          max-width: none;
          margin: 16px;
        }
        .stage-copy {
          margin-top: 260px;
        }
      }
    </style>
  </head>
  <body>
    <main class="simulation-shell">
      <section class="panel">
        <div class="badge">Extremely long simulation status badge that should wrap instead of punching outside the layout boundary</div>
        <h1>Workplace safety walkthrough</h1>
        <p>This simulation intentionally uses long copy so the iframe patch has to defend the layout.</p>
        <div class="toolbar">
          <button type="button">Start simulation</button>
          <button type="button">Pause and inspect risk controls</button>
          <button type="button">Reset to baseline conditions</button>
        </div>
        <label for="risk">Risk threshold control with a deliberately long label that would normally overflow narrow side panels</label>
        <input id="risk" type="range" min="0" max="100" value="42" />
        <p class="status-chip">Supervisory note with a long sentence that should stay inside the chip instead of stretching the iframe horizontally</p>
      </section>
      <section class="simulation-stage">
        <div class="overlay-card">
          <strong>Inspector panel</strong>
          <p>This floating card should remain readable and bounded even on a tight viewport.</p>
        </div>
        <div class="stage-copy">
          The scene copy stays inside the stage and should not collide with the floating panel once the iframe patch constrains widths and wrapping.
        </div>
      </section>
    </main>
  </body>
</html>`;

async function seedInteractiveStage(page: import('@playwright/test').Page) {
  await setSettingsStorage(page, SETTINGS_STORAGE);
  await ensureMaicDatabase(page);

  await page.evaluate(
    ({ stageId, html }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Interactive smoke test',
            description: '',
            language: 'en',
            style: 'professional',
            interactiveMode: true,
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
            id: 'interactive-scene-0',
            stageId,
            type: 'interactive',
            title: 'Simulation scene',
            order: 0,
            content: {
              type: 'interactive',
              url: 'about:blank',
              html,
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
      });
    },
    { stageId: TEST_STAGE_ID, html: INTERACTIVE_HTML },
  );

  await page.goto(`/classroom/${TEST_STAGE_ID}`, { waitUntil: 'domcontentloaded' });
}

test.describe('Interactive simulation layout', () => {
  test.beforeEach(async ({ page }) => {
    await seedInteractiveStage(page);
  });

  test('keeps simulation iframe content bounded without horizontal overflow', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();

    const iframe = page.locator('iframe[title^="Interactive Scene"]');
    await expect(iframe).toBeVisible();

    const frame = page.frameLocator('iframe[title^="Interactive Scene"]');
    await expect(frame.getByRole('heading', { name: 'Workplace safety walkthrough' })).toBeVisible();

    const overflow = await frame.locator('body').evaluate((body) => {
      const doc = body.ownerDocument;
      const root = doc.scrollingElement ?? doc.documentElement;
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
      };
    });

    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.bodyClientWidth + 1);

    const badgeMetrics = await frame.locator('.badge').evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        rectWidth: el.getBoundingClientRect().width,
        parentWidth: el.parentElement?.getBoundingClientRect().width ?? 0,
      };
    });

    expect(badgeMetrics.whiteSpace).not.toBe('nowrap');
    expect(badgeMetrics.overflowWrap).toBe('anywhere');
    expect(badgeMetrics.rectWidth).toBeLessThanOrEqual(badgeMetrics.parentWidth + 1);

    const shellMetrics = await frame.locator('.simulation-shell').evaluate((el) => {
      const style = window.getComputedStyle(el);
      const firstChild = el.firstElementChild as HTMLElement | null;
      return {
        maxWidth: style.maxWidth,
        paddingTop: Number.parseFloat(style.paddingTop),
        columnTemplate: style.gridTemplateColumns,
        firstChildWidth: firstChild?.getBoundingClientRect().width ?? 0,
        rectWidth: el.getBoundingClientRect().width,
        bodyWidth: document.body.getBoundingClientRect().width,
      };
    });

    expect(shellMetrics.maxWidth).toBe('1120px');
    expect(shellMetrics.paddingTop).toBeGreaterThanOrEqual(10);
    expect(shellMetrics.columnTemplate).not.toBe('none');
    expect(shellMetrics.firstChildWidth).toBeGreaterThanOrEqual(220);
    expect(shellMetrics.rectWidth).toBeLessThanOrEqual(shellMetrics.bodyWidth + 1);

    const stageMetrics = await frame.locator('.simulation-stage').evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        overflow: style.overflow,
        borderRadius: style.borderRadius,
      };
    });

    expect(stageMetrics.overflow).toBe('hidden');
    expect(stageMetrics.borderRadius).toBe('22px');
  });
});
