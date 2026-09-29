import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import { readServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The one-way import of what an earlier build kept in this browser.
 *
 * The browser gets a pre-server database as an old build left it (schema
 * version 4, so opening it runs the upgrade ladder in a real browser): one
 * course with a narration clip whose bytes exist only there. Loading the app
 * must, with no interaction, put the course on the server for this browser's
 * owner -- listed in the library, its narration uploaded and referenced by an
 * allocated id -- and a fresh browser context carrying the same owner cookie
 * must see it too, although its own storage is empty.
 */

const NARRATION_KEY = 'tts_s0_action_e2elegacy01';

async function seedLegacyDatabase(page: Page, stageId: string, name: string): Promise<void> {
  // A static file: same origin, and no app code that could start the import
  // before the database is written.
  await page.goto('/openmaic-mark.png');
  await page.evaluate(
    async ({ stageId, name, narrationKey }) => {
      const now = Date.now();
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        // Dexie stores its version 4 as IndexedDB version 40.
        const request = indexedDB.open('MAIC-Database', 40);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
          const scenes = db.createObjectStore('scenes', { keyPath: 'id' });
          scenes.createIndex('stageId', 'stageId');
          scenes.createIndex('order', 'order');
          scenes.createIndex('[stageId+order]', ['stageId', 'order']);
          db.createObjectStore('audioFiles', { keyPath: 'id' }).createIndex(
            'createdAt',
            'createdAt',
          );
          db.createObjectStore('imageFiles', { keyPath: 'id' }).createIndex(
            'createdAt',
            'createdAt',
          );
          db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          const chats = db.createObjectStore('chatSessions', { keyPath: 'id' });
          chats.createIndex('stageId', 'stageId');
          chats.createIndex('[stageId+createdAt]', ['stageId', 'createdAt']);
          db.createObjectStore('playbackState', { keyPath: 'stageId' });
          db.createObjectStore('stageOutlines', { keyPath: 'stageId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(['stages', 'scenes', 'audioFiles'], 'readwrite');
        tx.objectStore('stages').put({ id: stageId, name, createdAt: now, updatedAt: now });
        tx.objectStore('scenes').put({
          id: `${stageId}-scene`,
          stageId,
          type: 'slide',
          title: 'Legacy scene',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: `${stageId}-canvas`,
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: {
                backgroundColor: '#ffffff',
                themeColors: ['#2563eb'],
                fontColor: '#111827',
                fontName: 'Inter',
              },
              elements: [],
            },
          },
          actions: [
            { id: 'action_e2elegacy01', type: 'speech', text: 'Hello', audioId: narrationKey },
          ],
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('audioFiles').put({
          id: narrationKey,
          blob: new Blob([new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])], {
            type: 'audio/mpeg',
          }),
          format: 'mp3',
          createdAt: now,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    },
    { stageId, name, narrationKey: NARRATION_KEY },
  );
}

test('a course stored only in the browser moves to the server on first load', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const stageId = uniqueStageId('legacy-import-e2e');
  const name = `Legacy course ${stageId.slice(-8)}`;
  await seedLegacyDatabase(page, stageId, name);

  await page.goto('/');

  // No interaction: the course appears once the import has run.
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });

  // On the server, its narration now names an allocated asset whose bytes
  // are the clip that was only in the browser.
  const document = await readServerDocument(page, stageId);
  expect(document).not.toBeNull();
  const actions = (document!.scenes[0] as { actions: { audioId: string }[] }).actions;
  expect(actions[0]!.audioId).toMatch(/^ast_/);
  const bytes = await page.request.get(
    `/api/persistence/assets/${encodeURIComponent(actions[0]!.audioId)}/content`,
  );
  expect(bytes.status()).toBe(200);
  expect([...(await bytes.body())].slice(0, 3)).toEqual([73, 68, 51]);

  // The legacy database is still there, untouched.
  const legacyRows = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = () => {
          const tx = request.result.transaction('stages', 'readonly');
          const count = tx.objectStore('stages').count();
          count.onsuccess = () => {
            request.result.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(legacyRows).toBe(1);

  // A fresh browser context with the same owner cookie and no local data.
  const cookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === 'anonymous_id',
  );
  expect(cookies).toHaveLength(1);
  const fresh = await browser.newContext();
  try {
    await fresh.addCookies(cookies);
    const other = await fresh.newPage();
    await other.goto('/');
    await expect(other.getByText(name).first()).toBeVisible({ timeout: 30_000 });
    expect(
      await other.evaluate(async () =>
        (await indexedDB.databases()).some((info) => info.name === 'MAIC-Database'),
      ),
    ).toBe(false);
  } finally {
    await fresh.close();
  }
});

test('a first visit without an owner cookie imports under one owner, whatever order the first answers arrive in', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stageId = uniqueStageId('legacy-first-visit-e2e');
  const name = `First visit ${stageId.slice(-8)}`;
  await seedLegacyDatabase(page, stageId, name);
  // A browser that has never been given an owner: the upgrade's first load.
  await page.context().clearCookies();

  // Hold the answer to the page's first owner-scoped request until the importer
  // has bound the browser, so it reaches the browser last. Before the page
  // response established the owner, that answer minted an owner of its own and
  // replaced the cookie the binding was made with.
  let releaseHeld: () => void = () => undefined;
  const bindingDone = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let holding = false;
  await page.route(/\/api\/(stages|folders|persistence)(\/|\?|$)/, async (route) => {
    const response = await route.fetch();
    if (!holding) {
      holding = true;
      await Promise.race([bindingDone, new Promise((resolve) => setTimeout(resolve, 45_000))]);
    }
    await route.fulfill({ response });
  });
  await page.route('**/api/identity/legacy-import-binding', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
    releaseHeld();
  });

  await page.goto('/');

  await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
  expect(holding).toBe(true);
  const cookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === 'anonymous_id',
  );
  expect(cookies).toHaveLength(1);

  // After a reload the course is still this browser's.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
  const after = (await page.context().cookies()).filter((cookie) => cookie.name === 'anonymous_id');
  expect(after.map((cookie) => cookie.value)).toEqual(cookies.map((cookie) => cookie.value));
});
