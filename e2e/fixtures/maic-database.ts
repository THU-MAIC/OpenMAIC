import type { Page } from '@playwright/test';

// Keep the logical version in sync with the latest `this.version(...)` in
// lib/utils/database.ts. Dexie stores logical version 15 as native IndexedDB
// version 150 (logical version × 10); using 15 here would make Dexie replay
// an incompatible upgrade path against this already-current test schema.
const MAIC_DATABASE_VERSION = 15 * 10;

const MAIC_STORES: ReadonlyArray<{
  name: string;
  primaryKey?: string;
  indexes?: ReadonlyArray<{ name: string; keyPath: string | string[] }>;
  autoIncrement?: boolean;
}> = [
  { name: 'stages', indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }] },
  {
    name: 'scenes',
    indexes: [
      { name: 'stageId', keyPath: 'stageId' },
      { name: 'order', keyPath: 'order' },
      { name: 'seq', keyPath: 'seq' },
      { name: '[stageId+order]', keyPath: ['stageId', 'order'] },
      { name: '[stageId+seq]', keyPath: ['stageId', 'seq'] },
    ],
  },
  { name: 'audioFiles', indexes: [{ name: 'createdAt', keyPath: 'createdAt' }] },
  { name: 'imageFiles', indexes: [{ name: 'createdAt', keyPath: 'createdAt' }] },
  { name: 'snapshots', autoIncrement: true },
  {
    name: 'chatSessions',
    indexes: [
      { name: 'stageId', keyPath: 'stageId' },
      { name: '[stageId+createdAt]', keyPath: ['stageId', 'createdAt'] },
    ],
  },
  { name: 'playbackState', primaryKey: 'stageId' },
  { name: 'stageOutlines', primaryKey: 'stageId' },
  {
    name: 'mediaFiles',
    indexes: [
      { name: 'stageId', keyPath: 'stageId' },
      { name: '[stageId+type]', keyPath: ['stageId', 'type'] },
    ],
  },
  { name: 'generatedAgents', indexes: [{ name: 'stageId', keyPath: 'stageId' }] },
  {
    name: 'voiceProfiles',
    indexes: [
      { name: 'providerId', keyPath: 'providerId' },
      { name: 'kind', keyPath: 'kind' },
      { name: 'updatedAt', keyPath: 'updatedAt' },
    ],
  },
  {
    name: 'autoVoiceCache',
    primaryKey: 'voiceId',
    indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  },
  {
    name: 'agentEditSessions',
    indexes: [
      { name: 'stageId', keyPath: 'stageId' },
      { name: '[stageId+updatedAt]', keyPath: ['stageId', 'updatedAt'] },
    ],
  },
];

/** Create the current MAIC schema before a test navigates to the application. */
export async function prepareMaicDatabase(page: Page): Promise<void> {
  const bootstrapPath = '/__e2e-idb-bootstrap__';
  await page.route(`**${bootstrapPath}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>E2E IndexedDB bootstrap</title>',
    }),
  );

  try {
    // about:blank has an opaque origin, which Chromium correctly disallows
    // from using IndexedDB. A mocked same-origin document has no app scripts,
    // so it gives this setup exclusive ownership of the initial DB upgrade.
    await page.goto(bootstrapPath);
    await page.evaluate(
      ({ version, stores }) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('MAIC-Database', version);

          request.onupgradeneeded = () => {
            const database = request.result;
            for (const store of stores) {
              const objectStore = database.createObjectStore(store.name, {
                keyPath: store.name === 'snapshots' ? undefined : (store.primaryKey ?? 'id'),
                autoIncrement: store.autoIncrement,
              });
              for (const index of store.indexes ?? []) {
                objectStore.createIndex(index.name, index.keyPath);
              }
            }
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () =>
            reject(request.error ?? new Error('Unable to prepare MAIC database'));
          request.onblocked = () => reject(new Error('MAIC database creation was blocked'));
        }),
      { version: MAIC_DATABASE_VERSION, stores: MAIC_STORES },
    );
  } finally {
    await page.unroute(`**${bootstrapPath}`);
  }
}
