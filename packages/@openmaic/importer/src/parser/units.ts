/**
 * Unit conversion utilities for OOXML / PPTX.
 *
 * PPTX uses several unit systems:
 *   - EMU (English Metric Units): 1 inch = 914400 EMU
 *   - Points: 1 inch = 72 pt
 *   - Hundredths of a point: used for font sizes
 *   - 60000ths of a degree: used for angles
 *   - 100000ths (percentage): used for scale factors
 */

/** EMU to pixels (at 96 DPI). */
export function emuToPx(emu: number): number {
  return (emu / 914400) * 96;
}

/** EMU to points. */
export function emuToPt(emu: number): number {
  return emu / 12700;
}

/** OOXML angle (60000ths of a degree) to degrees. */
export function angleToDeg(angle: number): number {
  return angle / 60000;
}

/** OOXML percentage (100000ths) to a decimal fraction (0..1 range for 0%..100%). */
export function pctToDecimal(pct: number): number {
  return pct / 100000;
}

/** Hundredths of a point to points (used for font sizes in OOXML). */
export function hundredthPtToPt(val: number): number {
  return val / 100;
}

/** Points to pixels (at 96 DPI). */
export function ptToPx(pt: number): number {
  return (pt * 96) / 72;
}

/**
 * Heuristic: detect whether a value is in EMU or points.
 * Values with abs > 20000 are almost certainly EMU (a single point = 12700 EMU).
 */
export function detectUnit(value: number): 'emu' | 'point' {
  return Math.abs(value) > 20000 ? 'emu' : 'point';
}

/**
 * Smart conversion to pixels: auto-detects whether the value is EMU or points
 * and converts accordingly.
 */
export function smartToPx(value: number): number {
  if (detectUnit(value) === 'emu') {
    return emuToPx(value);
  }
  return ptToPx(value);
}
