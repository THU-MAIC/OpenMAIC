import { describe, expect, it } from 'vitest';
import type { AnimationDescriptor } from '@/lib/choreography';
import { laserV1, spotlightV1 } from '@/lib/choreography';
import { resolveMotionLayer } from '@/components/slide-renderer/Editor/motion-descriptor-adapter';

describe('resolveMotionLayer', () => {
  it('resolves the Spotlight cutout geometry and cubic transitions', () => {
    const layer = resolveMotionLayer(spotlightV1, 'cutout', {
      geometry: { x: 20, y: 30, w: 40, h: 10 },
    });

    expect(layer).toEqual({
      initial: { x: 12, y: 22, width: 56, height: 26, rx: 4 },
      animate: { x: 19.6, y: 29.4, width: 40.8, height: 11.2, rx: 1 },
      transition: {
        x: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
        y: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
        width: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
        height: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
        rx: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
      },
      staticProps: { fill: '#000000' },
    });
  });

  it('keeps a zero Spotlight dimness override and resolves enter and exit fades', () => {
    const layer = resolveMotionLayer(spotlightV1, 'dim', {
      params: { dimness: 0 },
    });

    expect(layer).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: {
        opacity: 0,
        transition: { opacity: { duration: 0.3 } },
      },
      transition: { opacity: { duration: 0.3 } },
      staticProps: { x: 0, y: 0, width: 100, height: 100, fill: 'rgba(0,0,0,0)' },
    });
  });

  it.each([
    {
      name: 'above',
      centerX: 75,
      centerY: 80,
      startLeft: '105%',
      startTop: '105%',
    },
    {
      name: 'below',
      centerX: 25,
      centerY: 40,
      startLeft: '-5%',
      startTop: '-5%',
    },
    {
      name: 'exactly at the threshold',
      centerX: 50,
      centerY: 50,
      startLeft: '-5%',
      startTop: '-5%',
    },
  ])(
    'resolves Laser dot corners $name with percent units and source timings',
    ({ centerX, centerY, startLeft, startTop }) => {
      const layer = resolveMotionLayer(laserV1, 'dot', {
        geometry: { centerX, centerY },
        units: { left: '%', top: '%' },
      });

      expect(layer.initial).toEqual({ left: startLeft, top: startTop, opacity: 0 });
      expect(layer.animate).toEqual({ left: `${centerX}%`, top: `${centerY}%`, opacity: 1 });
      expect(layer.transition).toEqual({
        left: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        top: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.15 },
      });
      expect(layer.exit).toEqual({
        left: startLeft,
        top: startTop,
        opacity: 0,
        transition: {
          left: { duration: 0.25, ease: [0.4, 0, 1, 1] },
          top: { duration: 0.25, ease: [0.4, 0, 1, 1] },
          opacity: { duration: 0.25, ease: [0.4, 0, 1, 1] },
        },
      });
    },
  );

  it('resolves Laser ring keyframes and infinite named-ease repeats', () => {
    const layer = resolveMotionLayer(laserV1, 'ring');

    expect(layer.initial).toEqual({});
    expect(layer.animate).toEqual({ scale: [1, 2.8], opacity: [0.6, 0] });
    expect(layer.transition).toEqual({
      scale: { duration: 1.5, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.3 },
      opacity: { duration: 1.5, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.3 },
    });
  });

  it('substitutes exact and embedded Laser core color parameters', () => {
    const layer = resolveMotionLayer(laserV1, 'core', {
      params: { color: '#12ab34' },
    });

    expect(layer).toEqual({
      initial: {},
      animate: {},
      transition: {},
      staticProps: {
        width: 10,
        height: 10,
        borderRadius: 9999,
        backgroundColor: '#12ab34',
        boxShadow: '0 0 8px 2px #12ab3460',
      },
    });
  });

  it('converts finite repeats and spring settings without inventing defaults', () => {
    const descriptor: AnimationDescriptor = {
      id: 'synthetic.v1',
      version: 1,
      effect: 'laser',
      params: { count: 7, label: 'default' },
      zIndex: 1,
      layers: [
        {
          id: 'pulse',
          staticProps: { exact: '{count}', embedded: 'value:{label}' },
          tracks: [
            {
              property: 'x',
              from: 1,
              to: 2,
              durationMs: 800,
              delayMs: 100,
              easing: { type: 'spring', stiffness: 120, damping: 18, mass: 0.7 },
              repeat: 2,
              repeatDelayMs: 250,
            },
            {
              property: 'visibility',
              from: 'hidden',
              to: 'visible',
            },
          ],
        },
      ],
    };

    const layer = resolveMotionLayer(descriptor, 'pulse', {
      params: { count: 0, label: undefined },
      units: { x: 'px' },
    });

    expect(layer).toEqual({
      initial: { visibility: 'hidden' },
      animate: { x: ['1px', '2px'], visibility: 'visible' },
      transition: {
        x: {
          duration: 0.8,
          delay: 0.1,
          type: 'spring',
          stiffness: 120,
          damping: 18,
          mass: 0.7,
          repeat: 2,
          repeatDelay: 0.25,
        },
        visibility: {},
      },
      staticProps: { exact: 0, embedded: 'value:default' },
    });
  });

  it('accepts an empty string parameter override', () => {
    const layer = resolveMotionLayer(laserV1, 'core', { params: { color: '' } });

    expect(layer.staticProps.backgroundColor).toBe('');
    expect(layer.staticProps.boxShadow).toBe('0 0 8px 2px 60');
  });

  it('throws errors that name missing layers, geometry, and parameters', () => {
    expect(() => resolveMotionLayer(spotlightV1, 'missing')).toThrow(/missing.*spotlight\.v1/i);
    expect(() =>
      resolveMotionLayer(spotlightV1, 'cutout', { geometry: { y: 10, w: 20, h: 30 } }),
    ).toThrow(/x/);

    const descriptor: AnimationDescriptor = {
      id: 'missing-param.v1',
      version: 1,
      effect: 'laser',
      zIndex: 1,
      layers: [{ id: 'static', tracks: [], staticProps: { value: '{required}' } }],
    };
    expect(() => resolveMotionLayer(descriptor, 'static')).toThrow(/required/);
  });
});
