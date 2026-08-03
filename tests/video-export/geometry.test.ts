import { describe, expect, it } from 'vitest';
import {
  findElementGeometry,
  getElementPercentageGeometry,
  applyGeometry,
  resolveEffectGeometry,
  resolveVideoPlacement,
  type EffectSegment,
  type VideoSegment,
  type VideoTimelineScene,
} from '@/lib/video-export';
import { el, slide, spotlight } from './helpers';

describe('geometry helper (pure)', () => {
  it('computes percentage geometry against the fixed 1000 x 562.5 base', () => {
    const g = getElementPercentageGeometry(
      el('e1', { left: 100, top: 100, width: 200, height: 100 }),
    )!;
    expect(g.x).toBeCloseTo(10, 5);
    expect(g.y).toBeCloseTo(17.7778, 3);
    expect(g.w).toBeCloseTo(20, 5);
    expect(g.h).toBeCloseTo(17.7778, 3);
    expect(g.centerX).toBeCloseTo(20, 5);
    expect(g.centerY).toBeCloseTo(26.6667, 3);
  });

  it('finds an element by id and returns null for a miss', () => {
    const elements = [el('e1', { left: 0, top: 0, width: 100, height: 100 })];
    expect(findElementGeometry(elements, 'e1')).not.toBeNull();
    expect(findElementGeometry(elements, 'nope')).toBeNull();
  });
});

const effect = (elementId: string): EffectSegment => ({
  actionId: 'sp',
  actionIndex: 0,
  type: 'spotlight',
  descriptorId: 'spotlight.v1',
  startMs: 0,
  durationMs: 100,
  elementId,
  geometry: null,
  params: { dimness: 0.5 },
  degraded: false,
});

describe('resolveEffectGeometry', () => {
  it('attaches geometry when the element resolves', () => {
    const elements = [el('e1', { left: 0, top: 0, width: 100, height: 100 })];
    const { effect: out, unresolved } = resolveEffectGeometry(effect('e1'), elements);
    expect(unresolved).toBe(false);
    expect(out.geometry).not.toBeNull();
    expect(out.degraded).toBe(false);
  });

  it('degrades (geometry null) when the element is missing or there are no elements', () => {
    expect(resolveEffectGeometry(effect('e1'), []).unresolved).toBe(true);
    expect(resolveEffectGeometry(effect('e1'), undefined).effect.degraded).toBe(true);
  });
});

describe('applyGeometry — across scenes', () => {
  it('resolves present elements and emits unresolved-element diagnostics for misses', () => {
    const source = [
      slide('s0', [spotlight('sp', 'e1')], {
        elements: [el('e1', { left: 0, top: 0, width: 100, height: 100 })],
      }),
      slide('s1', [spotlight('sp2', 'ghost')], { elements: [] }),
    ];
    const timelineScenes: VideoTimelineScene[] = [
      { ...baseScene('s0', 0), effects: [effect('e1')] },
      {
        ...baseScene('s1', 1),
        effects: [{ ...effect('ghost'), actionId: 'sp2', elementId: 'ghost' }],
      },
    ];

    const { scenes, diagnostics } = applyGeometry(timelineScenes, source);
    expect(scenes[0].effects[0].geometry).not.toBeNull();
    expect(scenes[0].effects[0].degraded).toBe(false);
    expect(scenes[1].effects[0].geometry).toBeNull();
    expect(scenes[1].effects[0].degraded).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'unresolved-element', sceneId: 's1', actionId: 'sp2' }),
    ]);
  });
});

/**
 * Issue #867 item 5 — the outer-box vs content-box delta. The pure calc places a
 * spotlight on the element's authored box; the live overlay (and the frame PNG)
 * measures the `.element-content` box, which for horizontal text is auto-height
 * plus 10px content padding. This suite quantifies that delta and proves the
 * compiler prefers a supplied GeometryProbe (measured content box) over the
 * authored box, degrading to the pure calc only on a probe miss.
 */
describe('applyGeometry — GeometryProbe (content-box) vs authored box', () => {
  // An authored 200×100 text box at (100,100). At 10px padding + a typical
  // 2-line auto-height, the rendered content box measures taller and inset.
  const authored = el('e1', { left: 100, top: 100, width: 200, height: 100 });

  it('quantifies the delta the probe corrects for a padded auto-height text box', () => {
    const outerBox = getElementPercentageGeometry(authored)!;
    // Content box: 10px padding on all sides shrinks the box and shifts its
    // origin; auto-height makes it 140px tall (2 wrapped lines) rather than 100.
    const paddedLeft = 110; // 100 + 10
    const paddedTop = 110;
    const contentW = 180; // 200 - 2*10
    const contentH = 140; // measured, taller than authored 100
    const contentBox = getElementPercentageGeometry(
      el('e1', { left: paddedLeft, top: paddedTop, width: contentW, height: contentH }),
    )!;

    // The delta is real and non-trivial in 0–100 space — this is the misalignment
    // users saw. Assert each axis moved so a regression that drops the probe fails.
    expect(Math.abs(contentBox.x - outerBox.x)).toBeGreaterThan(0.5);
    expect(Math.abs(contentBox.y - outerBox.y)).toBeGreaterThan(0.5);
    expect(Math.abs(contentBox.h - outerBox.h)).toBeGreaterThan(5);
    expect(contentBox.centerY).not.toBeCloseTo(outerBox.centerY, 1);
  });

  it('prefers the measured content-box geometry over the authored box', () => {
    const measured = { x: 11, y: 19.5, w: 18, h: 24.9, centerX: 20, centerY: 31.95 };
    const probe = {
      contentGeometry: (elementId: string) => (elementId === 'e1' ? measured : null),
    };
    const source = [slide('s0', [spotlight('sp', 'e1')], { elements: [authored] })];
    const timelineScenes: VideoTimelineScene[] = [
      { ...baseScene('s0', 0), effects: [effect('e1')] },
    ];

    const { scenes } = applyGeometry(timelineScenes, source, probe);
    expect(scenes[0].effects[0].geometry).toEqual(measured);
    expect(scenes[0].effects[0].degraded).toBe(false);
  });

  it('falls back to the authored box when the probe returns null', () => {
    const probe = { contentGeometry: () => null };
    const source = [slide('s0', [spotlight('sp', 'e1')], { elements: [authored] })];
    const timelineScenes: VideoTimelineScene[] = [
      { ...baseScene('s0', 0), effects: [effect('e1')] },
    ];

    const { scenes } = applyGeometry(timelineScenes, source, probe);
    expect(scenes[0].effects[0].geometry).toEqual(getElementPercentageGeometry(authored));
    expect(scenes[0].effects[0].degraded).toBe(false);
  });

  it('uses measured geometry for an unrotated video clip', () => {
    const unrotated = el('v1', { left: 100, top: 100, width: 200, height: 100 });
    const measured = { x: 11, y: 19.5, w: 18, h: 15, centerX: 20, centerY: 27 };
    const seg: VideoSegment = {
      actionId: 'pv',
      actionIndex: 0,
      startMs: 0,
      durationMs: 100,
      elementId: 'v1',
      geometry: null,
      rotate: 0,
      present: true,
      degraded: false,
      durationSource: 'stored',
    };
    const { video } = resolveVideoPlacement(seg, [unrotated], measured);
    expect(video.geometry).toEqual(measured); // rendered box wins for a zero rotation
    expect(video.rotate).toBe(0);
    expect(video.degraded).toBe(false);
  });

  it('falls back to the authored box for a rotated video, so rotation is never doubled', () => {
    // The measured box is the AABB of the already-rotated element; re-applying
    // `rotate` to it would rotate the clip twice. A rotated element must use its
    // authored box + rotate — the single, un-doubled source of truth.
    const rotated = el('v1', { left: 100, top: 100, width: 200, height: 100, rotate: 30 });
    const measured = { x: 11, y: 19.5, w: 18, h: 15, centerX: 20, centerY: 27 };
    const seg: VideoSegment = {
      actionId: 'pv',
      actionIndex: 0,
      startMs: 0,
      durationMs: 100,
      elementId: 'v1',
      geometry: null,
      rotate: 0,
      present: true,
      degraded: false,
      durationSource: 'stored',
    };
    const { video } = resolveVideoPlacement(seg, [rotated], measured);
    expect(video.geometry).toEqual(getElementPercentageGeometry(rotated)); // authored box, not measured
    expect(video.rotate).toBe(30); // rotation from the authored element, applied once
    expect(video.degraded).toBe(false);
  });
});

function baseScene(id: string, index: number): VideoTimelineScene {
  return {
    id,
    index,
    title: id,
    type: 'slide',
    startMs: 0,
    durationMs: 0,
    supported: true,
    base: { kind: 'slide-snapshot' },
    narration: [],
    effects: [],
    videos: [],
    markers: [],
  };
}
