/**
 * Clearing the local cache must leave every pre-server browser database alone.
 *
 * Existing users' courses may exist only there until the one-way importer has
 * moved them, so "Clear Local Cache" deleting (or opening under a clashing
 * schema) any of them would lose data. The four databases are seeded with real
 * rows through their own stores, the clear runs, and every row must still be
 * readable through the read-only legacy module.
 */
import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { BrowserAssetStore, BrowserDocumentStore, BrowserRuntimeStore } from '@openmaic/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { clearLocalCache } from '@/lib/device-storage/clear-local-cache';
import { db as deviceDb, DEVICE_DATABASE_NAME } from '@/lib/device-storage/database';
import {
  LEGACY_ASSET_POOL_DATABASE_NAME,
  LEGACY_DATABASE_NAME,
  LEGACY_DOCUMENTS_DATABASE_NAME,
  LEGACY_RUNTIME_DATABASE_NAME,
  openLegacyAssetReader,
  openLegacyDocumentReader,
  openLegacyRuntimeReader,
  readLegacyDocumentSnapshots,
  readLegacyFolders,
  readLegacyMediaFiles,
  resetLegacyBrowserStorageForTests,
} from '@/lib/legacy-browser-storage';
import { LegacyBrowserDatabase } from '@/lib/legacy-browser-storage/schema';

const LEGACY_NAMES = [
  LEGACY_DATABASE_NAME,
  LEGACY_DOCUMENTS_DATABASE_NAME,
  LEGACY_RUNTIME_DATABASE_NAME,
  LEGACY_ASSET_POOL_DATABASE_NAME,
];

const NOW = '2026-09-01T00:00:00.000Z';
let assetId = '';

async function seedLegacyDatabases(): Promise<void> {
  // MAIC-Database at its full schema, with rows in durable tables.
  const legacy = new LegacyBrowserDatabase();
  await legacy.stages.put({ id: 'legacy-stage', name: 'Old course', createdAt: 1, updatedAt: 2 });
  await legacy.scenes.put({
    id: 'legacy-scene',
    stageId: 'legacy-stage',
    type: 'slide',
    title: 'Old slide',
    order: 0,
    content: { type: 'slide', canvas: { id: 'c', elements: [] } } as never,
    createdAt: 1,
    updatedAt: 2,
  });
  await legacy.folders.put({
    id: 'legacy-folder',
    name: 'Old folder',
    order: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await legacy.mediaFiles.put({
    id: 'legacy-stage:gen_img_1',
    stageId: 'legacy-stage',
    type: 'image',
    blob: new Blob(['old-bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    size: 9,
    prompt: 'p',
    params: '{}',
    createdAt: 1,
  });
  legacy.close();

  const documents = new BrowserDocumentStore({ dbName: LEGACY_DOCUMENTS_DATABASE_NAME });
  await documents.saveDocument({
    stage: { id: 'doc-stage', name: 'Browser document', createdAt: 1, updatedAt: 2 },
    scenes: [],
  });

  const runtime = new BrowserRuntimeStore({ dbName: LEGACY_RUNTIME_DATABASE_NAME });
  await runtime.createSession({
    id: 'legacy-session',
    kind: 'pbl',
    stageId: 'doc-stage',
    learnerKey: 'anon:legacy-device',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });

  const assets = new BrowserAssetStore({ dbName: LEGACY_ASSET_POOL_DATABASE_NAME });
  assetId = await assets.put(new Blob(['asset-bytes'], { type: 'text/plain' }));
  await assets.close();
}

// Seeded once. The stores keep their connections open, so the databases are
// not deleted afterwards; this file's fake IndexedDB goes away with it.
beforeAll(async () => {
  resetLegacyBrowserStorageForTests();
  await seedLegacyDatabases();
  // The device cache has something of its own to clear.
  await deviceDb.snapshots.add({ index: 0, slides: [] });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:asset');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  resetLegacyBrowserStorageForTests();
});

describe('Clear Local Cache and the pre-server databases', () => {
  it('uses a device database name no legacy database has', () => {
    expect(LEGACY_NAMES).not.toContain(DEVICE_DATABASE_NAME);
    expect(new Set(LEGACY_NAMES).size).toBe(LEGACY_NAMES.length);
  });

  it('clears the device cache and leaves all four legacy databases with their data', async () => {
    await clearLocalCache();

    // The device cache itself was cleared.
    expect(await deviceDb.snapshots.count()).toBe(0);

    // Every legacy database still exists …
    for (const name of LEGACY_NAMES) {
      expect(await Dexie.exists(name), name).toBe(true);
    }

    // … with its rows intact, read through the read-only module.
    resetLegacyBrowserStorageForTests();
    const snapshot = await readLegacyDocumentSnapshots().read('legacy-stage');
    expect(snapshot?.stage.name).toBe('Old course');
    expect(snapshot?.scenes.map((scene) => scene.id)).toEqual(['legacy-scene']);
    expect((await readLegacyFolders()).map((folder) => folder.id)).toEqual(['legacy-folder']);
    const media = await readLegacyMediaFiles('legacy-stage');
    expect(await media[0]?.blob.text()).toBe('old-bytes');

    const documents = await openLegacyDocumentReader();
    expect((await documents?.loadDocument('doc-stage'))?.stage.name).toBe('Browser document');

    const runtime = await openLegacyRuntimeReader();
    expect(
      (await runtime?.listSessions('doc-stage', 'anon:legacy-device'))?.map(
        (session) => session.id,
      ),
    ).toEqual(['legacy-session']);

    const assets = await openLegacyAssetReader();
    expect(await assets?.exists(assetId)).toBe(true);
    await assets?.close();
  });
});
