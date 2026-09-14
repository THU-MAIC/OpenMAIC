import { describe, expect, test } from 'vitest';
import { encodeJson, sanitizeJsonString, sanitizeJsonValue } from '../src/pg-json.js';

const NUL = '\u0000';
const REPLACEMENT = '\uFFFD';

describe('sanitizeJsonString', () => {
  test('replaces NUL with U+FFFD', () => {
    expect(sanitizeJsonString(`a${NUL}b`)).toBe(`a${REPLACEMENT}b`);
  });

  test('replaces a lone high surrogate with U+FFFD', () => {
    expect(sanitizeJsonString('a\uD800b')).toBe(`a${REPLACEMENT}b`);
  });

  test('replaces a lone low surrogate with U+FFFD', () => {
    expect(sanitizeJsonString('a\uDC00b')).toBe(`a${REPLACEMENT}b`);
  });

  test('replaces a trailing lone high surrogate with U+FFFD', () => {
    expect(sanitizeJsonString('a\uD800')).toBe(`a${REPLACEMENT}`);
  });

  test('replaces a leading lone low surrogate with U+FFFD', () => {
    expect(sanitizeJsonString('\uDC00a')).toBe(`${REPLACEMENT}a`);
  });

  test('preserves a valid surrogate pair (emoji)', () => {
    const emoji = '\u{1F600}';
    expect(sanitizeJsonString(`a${emoji}b`)).toBe(`a${emoji}b`);
  });

  test('preserves adjacent valid surrogate pairs', () => {
    const pairs = '\u{1F600}\u{1F601}';
    expect(sanitizeJsonString(pairs)).toBe(pairs);
  });

  test('replaces a lone high surrogate immediately before a valid pair', () => {
    expect(sanitizeJsonString(`\uD800\u{1F600}`)).toBe(`${REPLACEMENT}\u{1F600}`);
  });

  test('returns the same string reference when nothing changes', () => {
    const input = 'plain text';
    expect(sanitizeJsonString(input)).toBe(input);
  });
});

describe('encodeJson', () => {
  test('sanitizes NUL and lone surrogates in nested values and arrays', () => {
    const encoded = encodeJson({ a: [`x${NUL}y`, { b: '\uD800' }], c: '\uDC00' }, 'value');
    expect(JSON.parse(encoded)).toEqual({
      a: [`x${REPLACEMENT}y`, { b: REPLACEMENT }],
      c: REPLACEMENT,
    });
  });

  test('sanitizes object keys as well as values, at every depth', () => {
    const encoded = encodeJson({ [`k${NUL}`]: 1, [`h\uD800`]: { [`l\uDC00`]: 2 } }, 'value');
    expect(JSON.parse(encoded)).toEqual({
      [`k${REPLACEMENT}`]: 1,
      [`h${REPLACEMENT}`]: { [`l${REPLACEMENT}`]: 2 },
    });
  });

  test('does not corrupt literal backslash-u text', () => {
    const encoded = encodeJson({ text: 'literal \\ud800 and \\u0000' }, 'value');
    expect(JSON.parse(encoded)).toEqual({ text: 'literal \\ud800 and \\u0000' });
  });

  test('preserves valid surrogate pairs through serialization', () => {
    const emoji = '\u{1F600}';
    expect(JSON.parse(encodeJson({ text: `emoji ${emoji}` }, 'value'))).toEqual({
      text: `emoji ${emoji}`,
    });
  });

  test('maps undefined to JSON null', () => {
    expect(encodeJson(undefined, 'value')).toBe('null');
  });

  test('wraps a value that JSON cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => encodeJson(circular, 'value')).toThrow(
      '@openmaic/storage: value is not JSON-serializable',
    );
  });
});

describe('sanitizeJsonValue', () => {
  test('returns the same object reference when nothing needs sanitizing', () => {
    const value = { plain: 'text', nested: { ok: true } };
    expect(sanitizeJsonValue('', value)).toBe(value);
  });

  test('returns the same array reference and leaves its members to stringify', () => {
    const value = [1, 'text', { plain: true }];
    expect(sanitizeJsonValue('', value)).toBe(value);
  });

  test('rebuilds with a null prototype when a key changes', () => {
    const rebuilt = sanitizeJsonValue('', { [`x${NUL}`]: 1 }) as Record<string, unknown>;
    // A normal `{}` would invoke the `__proto__` setter on assignment; the null
    // prototype makes every emitted member an own data property.
    expect(Object.getPrototypeOf(rebuilt)).toBeNull();
    expect(rebuilt[`x${REPLACEMENT}`]).toBe(1);
  });
});

describe('encodeJson key collisions', () => {
  test('keeps both members when a NUL key collides with the replacement key', () => {
    const encoded = encodeJson(
      { [`a${NUL}`]: { first: true }, [`a${REPLACEMENT}`]: { second: true } },
      'value',
    );
    expect(Object.keys(JSON.parse(encoded))).toEqual([`a${REPLACEMENT}`, `a${REPLACEMENT}#2`]);
    expect(JSON.parse(encoded)).toEqual({
      [`a${REPLACEMENT}`]: { first: true },
      [`a${REPLACEMENT}#2`]: { second: true },
    });
  });

  test('keeps the replacement key first and suffixes the later NUL key', () => {
    const encoded = encodeJson(
      { [`a${REPLACEMENT}`]: { second: true }, [`a${NUL}`]: { first: true } },
      'value',
    );
    expect(Object.keys(JSON.parse(encoded))).toEqual([`a${REPLACEMENT}`, `a${REPLACEMENT}#2`]);
    expect(JSON.parse(encoded)).toEqual({
      [`a${REPLACEMENT}`]: { second: true },
      [`a${REPLACEMENT}#2`]: { first: true },
    });
  });

  test('disambiguates a three-way collision with increasing ordinals', () => {
    const encoded = encodeJson({ [`a${NUL}`]: 1, [`a${REPLACEMENT}`]: 2, ['a\uD800']: 3 }, 'value');
    expect(JSON.parse(encoded)).toEqual({
      [`a${REPLACEMENT}`]: 1,
      [`a${REPLACEMENT}#2`]: 2,
      [`a${REPLACEMENT}#3`]: 3,
    });
  });

  test('bumps past a disambiguated key that is also an original key', () => {
    const encoded = encodeJson(
      { [`a${NUL}`]: 'nul', [`a${REPLACEMENT}#2`]: 'original', [`a${REPLACEMENT}`]: 'rc' },
      'value',
    );
    expect(JSON.parse(encoded)).toEqual({
      [`a${REPLACEMENT}`]: 'nul',
      [`a${REPLACEMENT}#2`]: 'original',
      [`a${REPLACEMENT}#3`]: 'rc',
    });
  });

  test('never emits a duplicate or still-offending key', () => {
    const encoded = encodeJson(
      {
        [`a${NUL}`]: 1,
        [`a${REPLACEMENT}`]: 2,
        ['b\uD800']: 3,
        [`b${REPLACEMENT}`]: 4,
        [`b${REPLACEMENT}#2`]: 5,
      },
      'value',
    );
    const keys = Object.keys(JSON.parse(encoded));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(sanitizeJsonString(key)).toBe(key);
  });
});

describe('encodeJson own __proto__ members', () => {
  test('keeps an own __proto__ member when a sibling key needs sanitizing', () => {
    const value = JSON.parse(`{"__proto__":{"own":true},"x\\u0000":1}`) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);

    const encoded = encodeJson(value, 'value');
    expect(encoded).toContain('"__proto__"');
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed['__proto__']).toEqual({ own: true });
    expect(parsed[`x${REPLACEMENT}`]).toBe(1);
  });

  test('keeps an own __proto__ member inside an array element', () => {
    const element = JSON.parse(`{"__proto__":{"own":true},"x\\u0000":1}`) as Record<
      string,
      unknown
    >;
    const encoded = encodeJson({ list: [element] }, 'value');
    const parsed = JSON.parse(encoded) as { list: Record<string, unknown>[] };
    expect(Object.prototype.hasOwnProperty.call(parsed.list[0], '__proto__')).toBe(true);
    expect(parsed.list[0]['__proto__']).toEqual({ own: true });
    expect(parsed.list[0][`x${REPLACEMENT}`]).toBe(1);
  });
});
