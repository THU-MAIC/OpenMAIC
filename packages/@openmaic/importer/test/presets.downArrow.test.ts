import { describe, expect, it } from 'vitest';
import { getPresetShapePath } from '../src/shapes/presets';

describe('downArrow geometry', () => {
  it('scales the head length by the shortest side in a tall arrow', () => {
    const path = getPresetShapePath(
      'downArrow',
      100,
      300,
      new Map([
        ['adj1', 32000],
        ['adj2', 40000],
      ]),
    );
    expect(path).toBe('M34,0 L66,0 L66,260 L100,260 L50,300 L0,260 L34,260 Z');
  });
  it('clamps adjustments to keep the shaft and head within the frame', () => {
    const path = getPresetShapePath(
      'downArrow',
      100,
      50,
      new Map([
        ['adj1', 200000],
        ['adj2', 200000],
      ]),
    );
    expect(path).toBe('M0,0 L100,0 L100,0 L100,0 L50,50 L0,0 L0,0 Z');
  });
});
