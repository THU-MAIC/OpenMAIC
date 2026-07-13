import { describe, expect, it } from 'vitest';
import {
  findElementGeometry,
  getElementPercentageGeometry,
  applyGeometry,
  resolveEffectGeometry,
  type EffectSegment,
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
