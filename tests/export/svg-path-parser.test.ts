import { describe, test, expect, vi, beforeEach } from 'vitest';
import { toPoints, getSvgPathRange } from '@/lib/export/svg-path-parser';

describe('toPoints', () => {
  beforeEach(() => {
    // Silence the parser's warn log for malformed-path cases.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  test('parses a valid M/L/Z path', () => {
    const points = toPoints('M 0 0 L 1 0 L 1 1 L 0 1 Z');
    expect(points.length).toBeGreaterThan(0);
    expect(points[0]).toMatchObject({ type: 'M', x: 0, y: 0 });
  });

  test('returns [] for a malformed path so the export does not crash', () => {
    // Real-world malformed path observed in an imported course manifest:
    // upstream LLM produced "alert" instead of an "A" arc command.
    const malformed = 'M 1 0.5 alert 0.5 0.5 0 1 1 0 0.5 A 0.5 0.5 0 1 1 1 0.5 Z';
    expect(toPoints(malformed)).toEqual([]);
  });

  test('returns [] for an arc-first path instead of throwing', () => {
    // A syntactically valid path whose first command is an arc (A): `points` is
    // still empty when the arc is reached, so reading the previous point must not
    // throw. Guards the documented "malformed path returns []" contract.
    expect(toPoints('A 0.5 0.5 0 1 1 1 0.5')).toEqual([]);
  });
});

describe('getSvgPathRange', () => {
  test('returns zero range for malformed path (existing tolerant behaviour)', () => {
    expect(getSvgPathRange('not a path')).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  test('does not include the origin for a closed glyph away from (0,0)', () => {
    // Z carries no x/y; it must not inject a spurious (0,0) into the bbox.
    expect(getSvgPathRange('M 100 100 L 200 100 L 200 200 L 100 200 Z')).toEqual({
      minX: 100,
      minY: 100,
      maxX: 200,
      maxY: 200,
    });
  });

  test('handles H/V commands without missing-axis zeros', () => {
    expect(getSvgPathRange('M 50 60 H 150 V 160 H 50 Z')).toEqual({
      minX: 50,
      minY: 60,
      maxX: 150,
      maxY: 160,
    });
  });

  test('resolves relative commands instead of treating deltas as absolute', () => {
    expect(getSvgPathRange('m 100 100 l 50 0 l 0 50 l -50 0 z')).toEqual({
      minX: 100,
      minY: 100,
      maxX: 150,
      maxY: 150,
    });
  });

  test('accounts for arc bulge (non-zero extent on the bulge axis)', () => {
    expect(getSvgPathRange('M 0 50 A 50 50 0 0 1 100 50')).toEqual({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 50,
    });
  });
});
