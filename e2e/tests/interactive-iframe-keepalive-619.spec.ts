import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

/**
 * E2E for #619: interactive scene iframes must NOT reload on remount.
 *
 * The keep-alive iframe is identified by its title `Interactive Scene <id>`.
 * A MutationObserver on the top document records every add/remove of *that*
 * iframe element. The proof of keep-alive: after each remount trigger (Pro mode
 * toggle, scene switch and back) the element is neither removed nor recreated
 * (zero recorded mutations), and the click-counter state it holds is preserved.
 *
 * Note: the slide nav rail also renders a separate, stateless `Interactive
 * Preview` thumbnail iframe that does reload on re-render — a different surface,
 * out of scope here. Scoping the observer to the playback iframe's title keeps
 * the assertion clean of that noise.
 */

const TEST_STAGE_ID = 'e2e-iframe-keepalive';
const INTERACTIVE_SCENE_ID = 'scene-interactive';
const IFRAME_TITLE = `Interactive Scene ${INTERACTIVE_SCENE_ID}`;
const SHOTS = 'e2e/__screenshots-619';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

const INTERACTIVE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#eaf0ff">
  <div style="text-align:center">
    <div style="font-size:14px;color:#556">interactive widget</div>
    <h1 id="count" style="font-size:72px;margin:8px 0;color:#2a3">0</h1>
    <button id="inc" style="font-size:18px;padding:8px 18px">+1</button>
  </div>
  <script>
    var n = 0, c = document.getElementById('count');
    document.getElementById('inc').addEventListener('click', function () { c.textContent = String(++n); });
  </script>
</body></html>`;

async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId, interactiveId, html, theme }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Keep-alive test',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });

          tx.objectStore('scenes').put({
            id: interactiveId,
            stageId,
            type: 'interactive',
            title: 'Interactive',
            order: 0,
            content: { type: 'interactive', url: '', html },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('scenes').put({
            id: 'scene-slide',
            stageId,
            type: 'slide',
            title: 'A slide',
            order: 1,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-1',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                elements: [
                  {
                    type: 'text',
                    id: 'el-1',
                    content: 'A slide',
                    left: 50,
                    top: 50,
                    width: 900,
                    height: 100,
                  },
                ],
              },
            },
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('outlines').put({
            stageId,
            outline: { outlines: [], createdAt: now, updatedAt: now },
          });

          localStorage.setItem(
            `maic:device:editor-current-scene:${stageId}`,
            JSON.stringify({ sceneId: interactiveId, updatedAt: new Date(now).toISOString() }),
          );

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    },
    {
      stageId: TEST_STAGE_ID,
      interactiveId: INTERACTIVE_SCENE_ID,
      html: INTERACTIVE_HTML,
      theme: defaultTheme,
    },
  );
}

const keepAliveMutations = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __kaMut: string[] }).__kaMut.slice());

const resetMutations = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    (window as unknown as { __kaMut: string[] }).__kaMut.length = 0;
  });

test.describe('#619 interactive iframe keep-alive', () => {
  test('insert toolbar keeps its position across unsupported surfaces', async ({ page }) => {
    await seedDatabase(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();
    await page.getByRole('switch').first().click();

    // SlideNav thumbnails cover most of each scene item's hit area. Dispatch
    // directly to the resolved item so this regression only exercises toolbar
    // state across scene transitions, not thumbnail pointer routing.
    await classroom.sidebarScenes.nth(1).click({ force: true }); // slide
    const handle = page.getByTestId('insert-toolbar-drag-handle');
    await expect(handle).toBeVisible();
    const initial = await handle.boundingBox();
    expect(initial).not.toBeNull();

    await handle.press('Enter');
    await handle.press('Shift+ArrowRight');
    await handle.press('Shift+ArrowDown');
    await handle.press('Escape');
    const moved = await handle.boundingBox();
    expect(moved).not.toBeNull();
    expect(moved!.x).toBeCloseTo(initial!.x + 24, 0);
    expect(moved!.y).toBeCloseTo(initial!.y + 24, 0);

    await classroom.sidebarScenes.nth(0).click({ force: true });
    await expect(handle).toBeHidden();
    await classroom.sidebarScenes.nth(1).click({ force: true });
    await expect(handle).toBeVisible();
    const restored = await handle.boundingBox();
    expect(restored).not.toBeNull();
    expect(restored!.x).toBeCloseTo(moved!.x, 0);
    expect(restored!.y).toBeCloseTo(moved!.y, 0);
  });

  test('iframe survives Pro-mode toggle and scene switch without reloading', async ({ page }) => {
    // Record add/remove of the keep-alive iframe (by title) in the top document.
    await page.addInitScript((title) => {
      if (window.top !== window.self) return;
      (window as unknown as { __kaMut: string[] }).__kaMut = [];
      const log = (window as unknown as { __kaMut: string[] }).__kaMut;
      const isTarget = (n: Node) =>
        n instanceof HTMLIFrameElement && n.getAttribute('title') === title;
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          m.addedNodes.forEach((n) => isTarget(n) && log.push('ADD'));
          m.removedNodes.forEach((n) => isTarget(n) && log.push('REM'));
        }
      });
      document.addEventListener('DOMContentLoaded', () =>
        mo.observe(document.body, { childList: true, subtree: true }),
      );
    }, IFRAME_TITLE);

    await seedDatabase(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const iframeEl = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
    const count = frame.locator('#count');

    // Initial render. Build in-iframe state that only survives a true keep-alive.
    await expect(iframeEl).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText('0');
    await frame.locator('#inc').click();
    await frame.locator('#inc').click();
    await frame.locator('#inc').click();
    await expect(count).toHaveText('3');
    await page.screenshot({ path: `${SHOTS}/01-interactive-counter-3.png`, fullPage: true });

    // Ignore any initial mount churn (incl. dev StrictMode); from here on the
    // keep-alive iframe must not be added or removed again.
    await resetMutations(page);

    // `.first()` because the ~280ms mode cross-fade briefly mounts both chrome
    // layers (each with its own Pro switch).
    // --- Trigger A: Pro mode toggle (edit chrome remounts the placeholder) ---
    await page.getByRole('switch').first().click();
    // Since #777 the interactive iframe stays VISIBLE in edit mode — the editor
    // agent ("Edit with AI") fixes interactive HTML, so the teacher must see the
    // live page while editing. The keep-alive proof is that it is neither
    // unmounted nor reloaded: the in-iframe counter state survives the toggle.
    await expect(iframeEl).toBeVisible();
    await expect(count).toHaveText('3'); // state preserved across the mode toggle
    await page.screenshot({ path: `${SHOTS}/02-pro-mode.png`, fullPage: true });

    await page.getByRole('switch').first().click();
    await expect(iframeEl).toBeVisible(); // back to playback
    await expect(count).toHaveText('3'); // state preserved → no reload
    // Let the ~280ms mode cross-fade fully settle: the outgoing chrome's
    // placeholder cleanup fires late, and a non-owner-checked release would hide
    // the iframe here (the blank-on-return regression). It must stay visible.
    await page.waitForTimeout(600);
    await expect(iframeEl).toBeVisible();
    await expect(count).toHaveText('3');
    await page.screenshot({ path: `${SHOTS}/03-back-from-pro.png`, fullPage: true });

    // --- Trigger B: scene switch away and back (placeholder unmount/remount) ---
    await classroom.clickScene(1); // slide
    await expect(page.getByRole('heading', { name: 'A slide' })).toBeVisible();
    await expect(iframeEl).toBeHidden();

    await classroom.clickScene(0); // back to interactive
    await expect(iframeEl).toBeVisible();
    await expect(count).toHaveText('3'); // state preserved → no reload
    await page.screenshot({ path: `${SHOTS}/04-back-from-scene-switch.png`, fullPage: true });

    // The keep-alive iframe element was never removed or recreated across either
    // remount trigger — the document (and its in-iframe state) was preserved.
    expect(await keepAliveMutations(page)).toEqual([]);
  });
});
