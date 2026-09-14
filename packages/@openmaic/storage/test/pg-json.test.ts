import { describe, expect, test } from 'vitest';
import { encodeJson, sanitizeJsonString } from '../src/pg-json.js';

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
