import { describe, expect, it } from 'vitest';
import type { PPTLineElement } from '@openmaic/dsl';
import { getLineKind, toLineKindPatch } from '../../src/ui/line/line-format';

function line(overrides: Partial<PPTLineElement> = {}): PPTLineElement {
  return {
    id: 'line-1',
    type: 'line',
    left: 100,
    top: 80,
    width: 2,
    start: [0, 0],
    end: [120, 80],
    style: 'solid',
    color: '#333333',
    points: ['', ''],
    ...overrides,
  };
}

describe('line format model', () => {
  it.each([
    [{}, 'straight'],
    [{ broken: [10, 20] as [number, number] }, 'broken'],
    [{ broken2: [10, 20] as [number, number] }, 'broken2'],
    [{ curve: [10, 20] as [number, number] }, 'curve'],
    [
      {
        cubic: [
          [10, 20],
          [30, 40],
        ] as [[number, number], [number, number]],
      },
      'cubic',
    ],
  ] as const)('reads %s as %s', (overrides, expected) => {
    expect(getLineKind(line(overrides))).toBe(expected);
  });

  it('changes a straight line to cubic without moving either endpoint', () => {
    expect(toLineKindPatch(line(), 'cubic')).toEqual({
      broken: undefined,
      broken2: undefined,
      curve: undefined,
      cubic: [
        [60, 40],
        [60, 40],
      ],
    });
  });

  it('clears incompatible controls when switching to a straight line', () => {
    expect(
      toLineKindPatch(
        line({
          broken: [20, 40],
          curve: [30, 20],
          cubic: [
            [10, 10],
            [20, 20],
          ],
        }),
        'straight',
      ),
    ).toEqual({ broken: undefined, broken2: undefined, curve: undefined, cubic: undefined });
  });
});
