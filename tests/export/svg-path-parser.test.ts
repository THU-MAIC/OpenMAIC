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
});

describe('getSvgPathRange', () => {
  test('returns zero range for malformed path (existing tolerant behaviour)', () => {
    expect(getSvgPathRange('not a path')).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});
