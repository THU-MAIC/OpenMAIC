// Implementation-agnostic contract for `KVStore`. Every backend (browser and
// HTTP) is proven equivalent by running this same suite against it, so a new
// backend cannot silently diverge from the primitive's semantics.
import { describe, expect, test } from 'vitest';
import type { KVScope, KVStore } from '../src/index.js';

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

    // Both backends decide "this write is a delete" by inspecting the value, not
    // by trial-serializing it: `JSON.stringify` runs caller code, so a probe
    // would reclassify `{ toJSON: () => undefined }` as a delete on one backend
    // while the other rejects it. A value that cannot be stored is refused, and
    // a refused write leaves the previous value alone.
    test('a toJSON returning undefined is refused, not silently treated as a delete', async () => {
      const kv = makeStore();
      await kv.set('k', 'present');

      await expect(kv.set('k', { toJSON: () => undefined })).rejects.toThrow();
      expect(await kv.get('k')).toBe('present');
    });

    test('the scope is validated before anything reads the value', async () => {
      const kv = makeStore();
      let reads = 0;
      const spy = {
        get value() {
          reads += 1;
          return reads;
        },
      };

      // The key is opaque and never validated, but the scope still is — and it is
      // checked before the value is serialized, so an invalid scope cannot make
      // caller code (a getter, a toJSON) run on the way to a rejection.
      await expect(kv.set('k', spy, 'Device' as KVScope)).rejects.toThrow(/unknown KV scope/);
      expect(reads).toBe(0);
    });

    // Scopes arrive as ordinary values (the zustand adapter passes one through
    // verbatim), so a typo is a runtime possibility the type cannot prevent.
    // Every backend must fail closed on one, and identically: a backend that
    // guessed would either strand data in an invisible namespace or — worse for
    // a server-backed one — send a value the caller believed was device-local.
    test('an unknown scope fails closed rather than being guessed', async () => {
      const kv = makeStore();
      const unknownScope = 'Device' as KVScope;

      await expect(kv.set('k', 'v', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.get('k', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.remove('k', unknownScope)).rejects.toThrow(/unknown KV scope/);
      await expect(kv.keys('', unknownScope)).rejects.toThrow(/unknown KV scope/);
    });

    // Coverage matrix — prefix-charset. The prefix is a literal, byte-for-byte
    // comparison, never a pattern. The characters that matter are the ones the
    // obvious SQL translation `key LIKE prefix || '%'` would treat as wildcards
    // or escapes: `%`, `_`, and — the one an implementer skips because they
    // assume a key can never contain it — `\\`, PostgreSQL's default LIKE escape.
    // Each must match only itself, and combinations must not interact.
    test.each([
      ['%', 'literal-%', ['literal-%match', 'literal-Xmatch']],
      ['_', 'literal-_', ['literal-_match', 'literal-Xmatch']],
      ['a backslash', 'literal-\\', ['literal-\\match', 'literal-Xmatch']],
      ['%_ combined', 'p-%_', ['p-%_match', 'p-XYmatch']],
      ['backslash-percent combined', 'p-\\%', ['p-\\%match', 'p-\\Xmatch']],
    ])('keys() matches a %s prefix literally, not as a pattern', async (_name, prefix, keys) => {
      const kv = makeStore();
      const [shouldMatch, shouldNotMatch] = keys as [string, string];
      await kv.set(shouldMatch, 1);
      await kv.set(shouldNotMatch, 2);

      expect(await kv.keys(prefix as string)).toEqual([shouldMatch]);
    });

    // Coverage matrix — key-validity. The key domain is truly opaque and
    // unconstrained: every representative shape below is a legitimate key and
    // must round-trip on every backend — set/get consistent, listed, removable —
    // with no rejection and no mangling, whatever it looks like. (Whole-key `.` /
    // `..` and unpaired surrogates are excluded here only because they are HTTP
    // *transport* limits, not key-domain rejections; they are covered separately.)
    test.each([
      ['an empty string', ''],
      ['a NUL code point', 'ns:before\u0000after'],
      ['a control character', 'ns:tab\u0009here'],
      ['a separator', 'editor-current-scene:stage/one'],
      ['a backslash', 'document-migration:stage\\one'],
      ['a traversal shape, harmless as opaque data', 'a/../../b'],
      ['a percent sign', 'k%2Fnot-decoded'],
      ['an underscore', 'ns_scene_1'],
      ['a colon and trailing spaces', 'ns: a b '],
      ['a BMP unicode character', 'ns:\u573A-\u20AC'],
      ['an astral emoji (paired surrogates)', 'ns:scene-\uD83D\uDD11'],
      // No length ceiling: an arbitrarily long composed key is just as valid.
      ['a very long composed key', `editor-current-scene:${'s'.repeat(5000)}`],
      ['many special characters at once', 'ns:/\\%_: .\u573A\uD83D\uDD11'],
    ])('round-trips an opaque key with %s across every backend', async (_name, key) => {
      const kv = makeStore();
      await kv.set(key, { ok: true });
      expect(await kv.get(key)).toEqual({ ok: true });
      expect(await kv.keys()).toContain(key);
      await kv.remove(key);
      expect(await kv.get(key)).toBeNull();
      expect(await kv.keys()).not.toContain(key);
    });

    // A prefix is not a path segment, so the dot-segment rule that governs keys
    // does not reach it: `.` is the legitimate prefix of a `.hidden`-style key.
    // Backends must agree, or a listing that works in the browser returns 400
    // against a server.
    test('keys() accepts a dot prefix, which is not a dot segment', async () => {
      const kv = makeStore();
      await kv.set('.hidden', 1);
      await kv.set('..parent', 2);
      await kv.set('visible', 3);

      expect([...(await kv.keys('.'))].sort()).toEqual(['..parent', '.hidden']);
      expect(await kv.keys('..')).toEqual(['..parent']);
    });

    test('keys() does not repeat a key', async () => {
      const kv = makeStore();
      await kv.set('one', 1);
      await kv.set('one', 2);
      await kv.set('two', 3);

      const keys = await kv.keys();
      expect([...new Set(keys)]).toHaveLength(keys.length);
      expect([...keys].sort()).toEqual(['one', 'two']);
    });
  });
}
