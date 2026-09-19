import { describe, expect, test } from 'vitest';
import { BrowserKVStore, kvPersistStorage } from '../src/index.js';
import { MemoryStorage } from './setup.js';

const makeKv = () => new BrowserKVStore({ storage: new MemoryStorage() });

describe('kvPersistStorage (zustand persist adapter)', () => {
  test('getItem returns null for an unwritten store', async () => {
    const storage = kvPersistStorage(makeKv());
    expect(await storage.getItem('settings-storage')).toBeNull();
  });

  test('round-trips the persisted { state, version } envelope', async () => {
    const storage = kvPersistStorage<{ nickname: string }>(makeKv());
    const value = { state: { nickname: 'Ada' }, version: 4 };
    await storage.setItem('settings-storage', value);
    expect(await storage.getItem('settings-storage')).toEqual(value);
  });

  test('removeItem clears the persisted store', async () => {
    const storage = kvPersistStorage(makeKv());
    await storage.setItem('k', { state: { x: 1 } });
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });

  test('writes under the given KV scope', async () => {
    const kv = makeKv();
    const deviceStorage = kvPersistStorage(kv, 'device');
    await deviceStorage.setItem('layout', { state: { width: 320 } });
    // Same key under the account scope is untouched.
    expect(await kv.get('layout', 'account')).toBeNull();
    expect(await kv.get('layout', 'device')).toEqual({ state: { width: 320 } });
  });

  test('defaults to the account scope', async () => {
    const kv = makeKv();
    const storage = kvPersistStorage(kv);
    await storage.setItem('profile', { state: { nickname: 'Ada' } });
    expect(await kv.get('profile', 'account')).toEqual({ state: { nickname: 'Ada' } });
  });
});
