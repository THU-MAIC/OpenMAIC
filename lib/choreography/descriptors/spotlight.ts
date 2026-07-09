import type { AnimationDescriptor } from './types';

/**
 * spotlight.v1 — focus a single element, dimming the rest.
 *
 * An SVG mask (0-100 viewBox) punches a rounded cutout over a dimmed full-screen
 * rect; a white border traces the cutout. Values captured verbatim from the
 * `SpotlightOverlay` effect component (`motion/react`):
 * - cutout: 600ms expo-out, insets from ±8/rx4 to the tight ±~0.5/rx1 frame.
 *   Modeled as a `role: 'mask'` layer — it is not painted itself; the `dim`
 *   layer subtracts it (`maskedBy`), so a non-React consumer reconstructs the
 *   "dim everywhere except the cutout" compositing rather than "draw a black
 *   rect".
 * - border: 500ms expo-out, delayed 50ms, fading in as it settles.
 * - dim: static `rgba(0,0,0,{dimness})`, dimness default 0.7, with the cutout
 *   subtracted.
 *
 * Shared easing `[0.16, 1, 0.3, 1]` (the spotlight expo-out).
 */
export const spotlightV1: AnimationDescriptor = {
  id: 'spotlight.v1',
  version: 1,
  effect: 'spotlight',
  params: { dimness: 0.7 },
  zIndex: 100,
  layers: [
    {
      id: 'cutout',
      // Geometry only — subtracted from `dim` (see its maskedBy), not painted.
      role: 'mask',
      staticProps: { fill: '#000000' },
      tracks: [
        {
          property: 'x',
          from: { ref: 'x', offset: -8 },
          to: { ref: 'x', offset: -0.4 },
          durationMs: 600,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'y',
          from: { ref: 'y', offset: -8 },
          to: { ref: 'y', offset: -0.6 },
          durationMs: 600,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'width',
          from: { ref: 'w', offset: 16 },
          to: { ref: 'w', offset: 0.8 },
          durationMs: 600,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'height',
          from: { ref: 'h', offset: 16 },
          to: { ref: 'h', offset: 1.2 },
          durationMs: 600,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'rx',
          from: 4,
          to: 1,
          durationMs: 600,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
      ],
    },
    {
      id: 'border',
      staticProps: {
        stroke: 'rgba(255,255,255,0.7)',
        strokeWidth: 1.2,
        fill: 'none',
        vectorEffect: 'non-scaling-stroke',
      },
      tracks: [
        {
          property: 'x',
          from: { ref: 'x', offset: -4 },
          to: { ref: 'x', offset: -0.4 },
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'y',
          from: { ref: 'y', offset: -4 },
          to: { ref: 'y', offset: -0.6 },
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'width',
          from: { ref: 'w', offset: 8 },
          to: { ref: 'w', offset: 0.8 },
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'height',
          from: { ref: 'h', offset: 8 },
          to: { ref: 'h', offset: 1.2 },
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'opacity',
          from: 0,
          to: 1,
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
        {
          property: 'rx',
          from: 2,
          to: 1,
          durationMs: 500,
          delayMs: 50,
          easing: { type: 'cubicBezier', points: [0.16, 1, 0.3, 1] },
        },
      ],
    },
    {
      id: 'dim',
      // Full-screen dim behind the cutout, with the cutout subtracted (SVG
      // <mask>: white full-cover minus the black cutout rect). The container's
      // opacity fade-in has no explicit duration in the source (engine default),
      // so no track here.
      maskedBy: { layerId: 'cutout', mode: 'subtract' },
      staticProps: { fill: 'rgba(0,0,0,{dimness})' },
      tracks: [],
    },
  ],
};
