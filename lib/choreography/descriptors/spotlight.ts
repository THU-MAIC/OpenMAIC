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
 * - dim: static `rgba(0,0,0,{dimness})`, dimness default 0.5, with the cutout
 *   subtracted.
 *
 * The `dimness` default is 0.5 — the value the runtime actually renders: a
 * spotlight action with no `dimOpacity` is stored as `action.dimOpacity ?? 0.5`
 * (`ActionEngine.executeSpotlight`; DSL documents `dimOpacity` default 0.5), so
 * the component's own `?? 0.7` fallback is unreachable at playback. The exporter
 * must use 0.5 to match.
 *
 * Shared easing `[0.16, 1, 0.3, 1]` (the spotlight expo-out).
 */
export const spotlightV1: AnimationDescriptor = {
  id: 'spotlight.v1',
  version: 1,
  effect: 'spotlight',
  params: { dimness: 0.5 },
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
      // The white outline sits inside the same wrapper motion.div as the dim
      // rect, so it fades in/out with the whole effect. `dim` carries the
      // canonical wrapper opacity fade; the border rides it (on top of its own
      // geometry + border-opacity tracks below).
      inheritsFrom: { parentId: 'dim', props: ['opacity'] },
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
      // <mask>: white full-cover minus the black cutout rect). Spans the whole
      // 0..100 viewport (`<rect width="100" height="100">` at the origin) — made
      // explicit so a literal consumer dims the entire frame rather than nothing.
      maskedBy: { layerId: 'cutout', mode: 'subtract' },
      staticProps: { x: 0, y: 0, width: 100, height: 100, fill: 'rgba(0,0,0,{dimness})' },
      // The whole effect is wrapped in a motion.div that fades opacity 0→1 on
      // enter and →0 on exit. The source sets no explicit transition, so Motion
      // applies its default tween (300ms) — pinned here explicitly so a
      // non-Motion consumer (the exporter) reproduces the fade instead of
      // popping the spotlight on/off. This layer carries the canonical wrapper
      // fade; the border layer inherits its opacity so both fade out together.
      tracks: [
        { property: 'opacity', from: 0, to: 1, durationMs: 300, phase: 'enter' },
        { property: 'opacity', from: 1, to: 0, durationMs: 300, phase: 'exit' },
      ],
    },
  ],
};
