import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  marqueeRect,
  computeMarqueeSelection,
  type MarqueeRect,
} from '../../../src/editing/core/marquee';

const box = (o: Partial<PPTElement> = {}) =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 100,
    width: 100,
    height: 60,
    rotate: 0,
    ...o,
  }) as unknown as PPTElement;

describe('marqueeRect — normalization', () => {
  it('normalizes all four drag directions to the same min/max rect', () => {
    const a = { x: 10, y: 20 };
    const b = { x: 110, y: 220 };
    const expected: MarqueeRect = { minX: 10, minY: 20, maxX: 110, maxY: 220 };
    // top-left → bottom-right and every other diagonal collapse to one rect.
    expect(marqueeRect(a, b)).toEqual(expected);
    expect(marqueeRect(b, a)).toEqual(expected);
    expect(marqueeRect({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual(expected);
    expect(marqueeRect({ x: 10, y: 220 }, { x: 110, y: 20 })).toEqual(expected);
  });
});

describe('computeMarqueeSelection — containment mode', () => {
  const rect: MarqueeRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };

  it('contain: selects only elements wholly inside the rect', () => {
    const inside = box({ id: 'in', left: 100, top: 100, width: 100, height: 60 });
    const straddling = box({ id: 'edge', left: 480, top: 100, width: 100, height: 60 });
    expect(computeMarqueeSelection(rect, [inside, straddling], { mode: 'contain' })).toEqual([
      'in',
    ]);
  });

  it('intersect: selects any element that overlaps the rect at all', () => {
    const inside = box({ id: 'in', left: 100, top: 100, width: 100, height: 60 });
    const straddling = box({ id: 'edge', left: 480, top: 100, width: 100, height: 60 });
    const outside = box({ id: 'out', left: 600, top: 600, width: 50, height: 50 });
    expect(
      computeMarqueeSelection(rect, [inside, straddling, outside], { mode: 'intersect' }),
    ).toEqual(['in', 'edge']);
  });

  it('contain: a rotated element is tested by its rotation-aware AABB', () => {
    // A 200x40 box rotated 90° about its center spans 40 wide × 200 tall. Placed
    // so its un-rotated box would fit but its rotated bbox overflows the rect on
    // the Y axis, contain must reject it while intersect keeps it.
    const rotated = box({
      id: 'rot',
      left: 100,
      top: 100,
      width: 200,
      height: 40,
      rotate: 90,
    });
    const tight: MarqueeRect = { minX: 0, minY: 0, maxX: 400, maxY: 260 };
    // Rotated bbox: center (200,120), 40 wide (180..220), 200 tall (20..220).
    // maxY 220 <= 260 and minY 20 >= 0 → contained; widen check with a shorter rect.
    expect(computeMarqueeSelection(tight, [rotated], { mode: 'contain' })).toEqual(['rot']);
    const shallow: MarqueeRect = { minX: 0, minY: 0, maxX: 400, maxY: 150 };
    // Now the rotated bbox (20..220 tall) overflows 150 → not contained,
    // but it still overlaps → intersect keeps it.
    expect(computeMarqueeSelection(shallow, [rotated], { mode: 'contain' })).toEqual([]);
    expect(computeMarqueeSelection(shallow, [rotated], { mode: 'intersect' })).toEqual(['rot']);
  });
});

describe('computeMarqueeSelection — bent lines (control-point-aware bounds)', () => {
  // A quadratic 'curve' line whose bend bows BELOW the start→end chord: the
  // chord spans y=0 only, while the control point at y=80 pulls the rendered
  // path down to y=40 at its apex. Chord-only bounds (getElementRange) would
  // never see the bend.
  const curveLine = {
    id: 'l',
    type: 'line',
    left: 0,
    top: 0,
    start: [0, 0],
    end: [100, 0],
    curve: [50, 80],
    width: 2,
    style: 'solid',
    color: '#333',
    points: ['', ''],
  } as unknown as PPTElement;

  it('intersect: a marquee over the bend (entirely off the chord) selects the line', () => {
    const overBend: MarqueeRect = { minX: 30, minY: 20, maxX: 70, maxY: 60 };
    expect(computeMarqueeSelection(overBend, [curveLine], { mode: 'intersect' })).toEqual(['l']);
  });

  it('contain: a chord-only rect does not contain the bent line; room for the control-point box does', () => {
    // Covers the chord but not the bend: the conservative box (down to the
    // control point at y=80) demands more room than the rendered stroke, so
    // contain rejects — never a false positive that splits from the visual.
    const chordOnly: MarqueeRect = { minX: -10, minY: -10, maxX: 110, maxY: 10 };
    expect(computeMarqueeSelection(chordOnly, [curveLine], { mode: 'contain' })).toEqual([]);
    // A rect spanning the full conservative box contains it.
    const roomy: MarqueeRect = { minX: -10, minY: -10, maxX: 110, maxY: 90 };
    expect(computeMarqueeSelection(roomy, [curveLine], { mode: 'contain' })).toEqual(['l']);
  });

  it('intersect: a broken (polyline) line is hit at its elbow, off the chord', () => {
    const brokenLine = {
      ...(curveLine as unknown as Record<string, unknown>),
      id: 'bk',
      curve: undefined,
      broken: [50, 60],
    } as unknown as PPTElement;
    // The elbow vertex sits at (50,60); a box around it (chord is y=0) hits.
    const overElbow: MarqueeRect = { minX: 40, minY: 40, maxX: 60, maxY: 70 };
    expect(computeMarqueeSelection(overElbow, [brokenLine], { mode: 'intersect' })).toEqual(['bk']);
  });
});

describe('computeMarqueeSelection — exclusions', () => {
  const rect: MarqueeRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };

  it('never selects a locked element even when fully inside', () => {
    const a = box({ id: 'a', left: 50, top: 50 });
    const locked = box({ id: 'b', left: 200, top: 200, lock: true });
    expect(computeMarqueeSelection(rect, [a, locked], { mode: 'contain' })).toEqual(['a']);
  });

  it('never selects an excludeIds member', () => {
    const a = box({ id: 'a', left: 50, top: 50 });
    const b = box({ id: 'b', left: 200, top: 200 });
    expect(computeMarqueeSelection(rect, [a, b], { mode: 'contain', excludeIds: ['b'] })).toEqual([
      'a',
    ]);
  });
});

describe('computeMarqueeSelection — group cohesion (all-or-nothing)', () => {
  const g1 = box({ id: 'g1', left: 50, top: 50, groupId: 'G' });
  const g2 = box({ id: 'g2', left: 200, top: 50, groupId: 'G' });
  const solo = box({ id: 's', left: 50, top: 300 });

  it('keeps a group only when EVERY member matched', () => {
    // Rect covers both group members and the solo element → all kept.
    const all: MarqueeRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    expect(computeMarqueeSelection(all, [g1, g2, solo], { mode: 'contain' })).toEqual([
      'g1',
      'g2',
      's',
    ]);
  });

  it('drops partially-covered group members (never splits a group)', () => {
    // Rect covers g1 + solo but NOT g2 (left 200..300 out of a 0..180 rect).
    const partial: MarqueeRect = { minX: 0, minY: 0, maxX: 180, maxY: 500 };
    // g1 matched but its group is incomplete → dropped; solo (no group) stays.
    expect(computeMarqueeSelection(partial, [g1, g2, solo], { mode: 'contain' })).toEqual(['s']);
  });
});
