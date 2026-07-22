import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page } from '@playwright/test';

/**
 * Targeted live verification of playback cursor persistence (#869 cutover):
 * the resume cursor lands in device-scoped KV (localStorage
 * `playback-cursor:<stageId>`) while the lecture plays, and survives a fresh
 * page (empty sessionStorage). Consumed-discussion state is volatile by
 * decision — a re-shown proactive card auto-skips — so no runtime records are
 * asserted here.
 */

const STAGE_ID = 'stage-playback-e2e';
const SCENE_ID = 'scene-playback-e2e';

async function seedStage(page: Page) {
  // Loading a classroom route forces the app to open (and version) the Dexie
  // database even when it is empty; only then do the object stores exist.
  await page.goto('/classroom/warmup-nonexistent');
  await page.waitForFunction(
    async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'MAIC-Database')) return false;
      const open = indexedDB.open('MAIC-Database');
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const ready =
        db.objectStoreNames.contains('stages') && db.objectStoreNames.contains('scenes');
      db.close();
      return ready;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    async ({ stageId, sceneId }) => {
      const open = indexedDB.open('MAIC-Database');
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const now = Date.now();
      const tx = db.transaction(['stages', 'scenes'], 'readwrite');
      tx.objectStore('stages').put({
        id: stageId,
        name: 'Playback E2E Stage',
        createdAt: now,
        updatedAt: now,
        currentSceneId: sceneId,
      });
      tx.objectStore('scenes').put({
        id: sceneId,
        stageId,
        type: 'slide',
        title: 'Playback E2E Scene',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [
          { id: 'act-speech-1', type: 'speech', text: 'One.' },
          { id: 'act-speech-2', type: 'speech', text: 'Two.' },
          { id: 'act-speech-3', type: 'speech', text: 'Three.' },
        ],
        createdAt: now,
        updatedAt: now,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { stageId: STAGE_ID, sceneId: SCENE_ID },
  );
}

async function readCursor(page: Page): Promise<{ sceneId: string; actionIndex: number } | null> {
  return page.evaluate((stageId) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.includes(`playback-cursor:${stageId}`)) {
        const parsed = JSON.parse(localStorage.getItem(key)!);
        // BrowserKVStore may wrap the value; unwrap common shapes.
        return parsed?.value ?? parsed;
      }
    }
    return null;
  }, STAGE_ID);
}

test('playback cursor persists to device KV and survives a fresh page', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('settings-storage', settings);
    },
    createSettingsStorage({ autoPlayLecture: true, ttsEnabled: false }),
  );
  await seedStage(page);

  await page.goto(`/classroom/${STAGE_ID}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });

  // The central play affordance is a non-semantic motion.div overlay
  // (canvas-area.tsx z-[102]); click it to start the lecture.
  const overlayPlay = page.locator('div[class*="z-[102]"] div.pointer-events-auto').first();
  await overlayPlay.waitFor({ state: 'visible', timeout: 15_000 });
  await overlayPlay.click();

  // Speech actions advance on reading-time timers; the cursor save is
  // debounced 1s behind progress.
  await expect
    .poll(async () => (await readCursor(page))?.sceneId ?? null, {
      timeout: 60_000,
      message: 'the device cursor should be persisted while the lecture plays',
    })
    .toBe(SCENE_ID);

  // Fresh page = empty sessionStorage → the KV cursor is the resume source
  // and must still be readable.
  const fresh = await context.newPage();
  await fresh.goto(`/classroom/${STAGE_ID}`);
  await expect(fresh.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });
  const cursorAfterReload = await readCursor(fresh);
  expect(cursorAfterReload?.sceneId).toBe(SCENE_ID);

  await fresh.close();
});
