import { describe, expect, it } from 'vitest';
import { getShadowOption } from '@/lib/export/use-export-pptx';
import type { PPTElementShadow } from '@/lib/types/slides';

const shadow = (over: Partial<PPTElementShadow> = {}): PPTElementShadow => ({
  h: 0,
  v: 0,
  blur: 0,
  color: '#000000',
  ...over,
});

describe('getShadowOption', () => {
  it('converts the offset from px to pt (regression #678)', () => {
    // h=10, v=0 -> offset picks up h (10px). pptxgenjs offset is in points.
    const result = getShadowOption(shadow({ h: 10, v: 0, blur: 8 }), 2);
    expect(result.offset).toBe(5); // 10px / 2 = 5pt — previously left as 10px
    expect(result.angle).toBe(1);
  });

  it('converts blur and offset with the same ratio', () => {
    const ratio = 96 / 72; // ≈ 1.333, the default ratioPx2Pt factor
    const result = getShadowOption(shadow({ h: 0, v: 12, blur: 12 }), ratio);
    expect(result.offset).toBeCloseTo(12 / ratio, 10);
    expect(result.blur).toBeCloseTo(12 / ratio, 10);
    // Offset and blur must share the same unit so the shadow stays aligned.
    expect(result.offset).toBeCloseTo(result.blur ?? NaN, 10);
  });

  it('uses the default offset of 4px (converted) when h and v are both zero', () => {
    const result = getShadowOption(shadow({ h: 0, v: 0, blur: 0 }), 2);
    expect(result.offset).toBe(2); // default 4px / 2
    expect(result.angle).toBe(45);
  });

  it('maps direction to the expected angle and magnitude', () => {
    const cases: Array<[number, number, number, number]> = [
      // h, v, expectedAngle, expectedOffsetPx (before ratio)
      [0, 5, 90, 5],
      [0, -5, 270, 5],
      [6, 0, 1, 6],
      [-6, 0, 180, 6],
      [3, 4, 45, 4],
      [3, -4, 315, 4],
      [-3, 4, 135, 4],
      [-3, -4, 225, 4],
    ];
    for (const [h, v, angle, offsetPx] of cases) {
      const result = getShadowOption(shadow({ h, v, blur: 0 }), 1);
      expect(result.angle).toBe(angle);
      expect(result.offset).toBe(offsetPx); // ratio 1 -> px === pt
    }
  });

  it('formats color and opacity from the shadow color', () => {
    const result = getShadowOption(shadow({ color: '#ff0000' }), 1);
    expect(result.color).toBe('ff0000'); // leading '#' stripped
    expect(result.type).toBe('outer');
  });
});
