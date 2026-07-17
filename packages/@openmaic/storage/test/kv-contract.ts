// Implementation-agnostic contract for `KVStore`. Every backend (browser today,
// HTTP later) is proven equivalent by running this same suite against it, so a
// new backend cannot silently diverge from the primitive's semantics.
import { describe, expect, test } from 'vitest';
import type { KVStore } from '../src/index.js';

export function runKVStoreContract(name: string, makeStore: () => KVStore): void {
  describe(`KVStore contract: ${name}`, () => {
    test('round-trips a value set then get', async () => {
      const kv = makeStore();
      await kv.set('greeting', 'hello');
      expect(await kv.get<string>('greeting')).toBe('hello');
    });

    test('returns null for a missing key', async () => {
      const kv = makeStore();
      expect(await kv.get('nope')).toBeNull();
    });

    test('round-trips structured JSON values', async () => {
      const kv = makeStore();
      const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
      await kv.set('obj', value);
      expect(await kv.get('obj')).toEqual(value);
    });

    test('overwrites an existing key', async () => {
      const kv = makeStore();
      await kv.set('k', 'first');
      await kv.set('k', 'second');
      expect(await kv.get<string>('k')).toBe('second');
    });

    test('remove deletes a key', async () => {
      const kv = makeStore();
      await kv.set('k', 'v');
      await kv.remove('k');
      expect(await kv.get('k')).toBeNull();
    });

    test('defaults to the account scope', async () => {
      const kv = makeStore();
      await kv.set('k', 'v'); // no scope → account
      expect(await kv.get('k', 'account')).toBe('v');
      expect(await kv.get('k', 'device')).toBeNull();
    });

    test('isolates the device and account scopes', async () => {
      const kv = makeStore();
      await kv.set('k', 'device-val', 'device');
      await kv.set('k', 'account-val', 'account');
      expect(await kv.get('k', 'device')).toBe('device-val');
      expect(await kv.get('k', 'account')).toBe('account-val');
    });

    test('keys() lists keys in a scope, filtered by prefix', async () => {
      const kv = makeStore();
      await kv.set('ui:width', 1, 'device');
      await kv.set('ui:height', 2, 'device');
      await kv.set('other', 3, 'device');
      await kv.set('ui:acct', 4, 'account');
      const uiKeys = await kv.keys('ui:', 'device');
      expect([...uiKeys].sort()).toEqual(['ui:height', 'ui:width']);
    });

    test('keys() with no prefix lists every key in the scope', async () => {
      const kv = makeStore();
      await kv.set('a', 1);
      await kv.set('b', 2);
      expect([...(await kv.keys())].sort()).toEqual(['a', 'b']);
    });

    test('set(undefined) clears the key instead of corrupting it', async () => {
      const kv = makeStore();
      await kv.set('k', 'v');
      await kv.set('k', undefined);
      // Must return null, not throw — a stored literal "undefined" would throw
      // on the JSON.parse in get().
      expect(await kv.get('k')).toBeNull();
      expect(await kv.keys()).not.toContain('k');
    });

    test('remove is scoped', async () => {
      const kv = makeStore();
      await kv.set('k', 'device-val', 'device');
      await kv.set('k', 'account-val', 'account');
      await kv.remove('k', 'device');
      expect(await kv.get('k', 'device')).toBeNull();
      expect(await kv.get('k', 'account')).toBe('account-val');
    });
  });
}
