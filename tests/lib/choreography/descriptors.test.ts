import { describe, expect, it } from 'vitest';
import {
  DESCRIPTORS,
  spotlightV1,
  laserV1,
  getDescriptor,
  AnimationDescriptorSchema,
} from '@/lib/choreography';

describe('animation descriptor registry', () => {
  it('registers spotlight.v1 and laser.v1 under their versioned ids', () => {
    expect(Object.keys(DESCRIPTORS).sort()).toEqual(['laser.v1', 'spotlight.v1']);
    expect(getDescriptor('spotlight.v1')).toBe(spotlightV1);
    expect(getDescriptor('laser.v1')).toBe(laserV1);
    expect(getDescriptor('nope.v1')).toBeUndefined();
  });

  it('ids and versions are consistent', () => {
    for (const [key, d] of Object.entries(DESCRIPTORS)) {
      expect(d.id).toBe(key);
      expect(d.version).toBe(1);
      expect(key.endsWith(`.v${d.version}`)).toBe(true);
    }
  });
});

describe('every shipped descriptor conforms to the zod schema', () => {
  for (const [key, d] of Object.entries(DESCRIPTORS)) {
    it(`${key} validates`, () => {
      expect(() => AnimationDescriptorSchema.parse(d)).not.toThrow();
    });
  }

  it('rejects a descriptor missing required fields', () => {
    expect(AnimationDescriptorSchema.safeParse({ id: 'x.v1', version: 1 }).success).toBe(false);
  });

  it('rejects an unknown easing type', () => {
    const bad = {
      ...spotlightV1,
      layers: [
        {
          id: 'l',
          tracks: [
            {
              property: 'x',
              from: 0,
              to: 1,
              durationMs: 100,
              easing: { type: 'bogus', points: [0, 0, 0, 0] },
            },
          ],
        },
      ],
    };
    expect(AnimationDescriptorSchema.safeParse(bad).success).toBe(false);
  });
});

describe('spotlight.v1 pins the source animation values', () => {
  it('has the dim/cutout/border layers and z-index 100', () => {
    expect(spotlightV1.zIndex).toBe(100);
    expect(spotlightV1.params).toMatchObject({ dimness: 0.7 });
    expect(spotlightV1.layers.map((l) => l.id).sort()).toEqual(['border', 'cutout', 'dim']);
  });

  it('cutout uses the 600ms expo-out curve', () => {
    const cutout = spotlightV1.layers.find((l) => l.id === 'cutout')!;
    for (const t of cutout.tracks) {
      expect(t.durationMs).toBe(600);
      expect(t.easing).toEqual({ type: 'cubicBezier', points: [0.16, 1, 0.3, 1] });
    }
  });

  it('border is 500ms, delayed 50ms', () => {
    const border = spotlightV1.layers.find((l) => l.id === 'border')!;
    for (const t of border.tracks) {
      expect(t.durationMs).toBe(500);
      expect(t.delayMs).toBe(50);
    }
  });
});

describe('laser.v1 pins the source animation values', () => {
  it('has the dot/ring/core layers, z-index 101, red default', () => {
    expect(laserV1.zIndex).toBe(101);
    expect(laserV1.params).toMatchObject({ color: '#ff0000' });
    expect(laserV1.layers.map((l) => l.id).sort()).toEqual(['core', 'dot', 'ring']);
  });

  it('the ring pulses infinitely, scale 1→2.8, 1500ms, 300ms repeat delay', () => {
    const ring = laserV1.layers.find((l) => l.id === 'ring')!;
    const scale = ring.tracks.find((t) => t.property === 'scale')!;
    expect(scale).toMatchObject({
      from: 1,
      to: 2.8,
      durationMs: 1500,
      repeat: 'infinite',
      repeatDelayMs: 300,
    });
  });

  it('the dot fly-in is 500ms enter and 250ms exit', () => {
    const dot = laserV1.layers.find((l) => l.id === 'dot')!;
    const enterLeft = dot.tracks.find((t) => t.property === 'left' && t.phase === 'enter')!;
    const exitLeft = dot.tracks.find((t) => t.property === 'left' && t.phase === 'exit')!;
    expect(enterLeft.durationMs).toBe(500);
    expect(exitLeft.durationMs).toBe(250);
  });
});
