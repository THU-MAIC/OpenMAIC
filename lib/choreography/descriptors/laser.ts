import type { AnimationDescriptor } from './types';

/**
 * laser.v1 — a laser dot flies in from the nearest off-screen corner to the
 * element center, with a pulsing ring and a glowing core.
 *
 * Values captured verbatim from the `LaserOverlay` effect component
 * (`motion/react`):
 * - dot fly-in: left/top 500ms expo-out `[0.22,1,0.36,1]`; opacity 150ms;
 *   start corner is `center > 50 ? 105 : -5` (percent) per axis.
 * - exit: 250ms ease-in `[0.4,0,1,1]` back to the start corner (position +
 *   opacity).
 * - ring: infinite pulse, scale 1→2.8, opacity 0.6→0, 1500ms easeOut, 300ms
 *   repeat delay.
 * - core: 10px square (`w-2.5 h-2.5`), glow `0 0 8px 2px {color}60`.
 *
 * Static geometry captured too, so a literal (non-React) renderer matches the
 * app rather than drawing an offset square: the dot group is centered on the
 * target via `translate(-50%, -50%)` (`-translate-x/y-1/2`), and both the ring
 * and core are circles (`rounded-full` → `borderRadius: 9999px`); the ring is
 * `position: absolute; inset: 0` inside the group.
 *
 * Color default `#ff0000` — the app store's laserOptions default
 * (`lib/store/canvas.ts`), which the caller passes in; the component's own
 * fallback `#ff3b30` is only used when no options exist, which does not happen
 * at playback time.
 */
export const laserV1: AnimationDescriptor = {
  id: 'laser.v1',
  version: 1,
  effect: 'laser',
  params: { color: '#ff0000' },
  zIndex: 101,
  layers: [
    {
      id: 'dot',
      // The dot group is anchored at its own center on the target coordinate.
      staticProps: { transform: 'translate(-50%, -50%)' },
      tracks: [
        {
          property: 'left',
          from: { axis: 'centerX', threshold: 50, whenAbove: 105, whenBelow: -5 },
          to: { ref: 'centerX' },
          durationMs: 500,
          easing: { type: 'cubicBezier', points: [0.22, 1, 0.36, 1] },
          phase: 'enter',
        },
        {
          property: 'top',
          from: { axis: 'centerY', threshold: 50, whenAbove: 105, whenBelow: -5 },
          to: { ref: 'centerY' },
          durationMs: 500,
          easing: { type: 'cubicBezier', points: [0.22, 1, 0.36, 1] },
          phase: 'enter',
        },
        {
          property: 'opacity',
          from: 0,
          to: 1,
          durationMs: 150,
          phase: 'enter',
        },
        {
          property: 'left',
          from: { ref: 'centerX' },
          to: { axis: 'centerX', threshold: 50, whenAbove: 105, whenBelow: -5 },
          durationMs: 250,
          easing: { type: 'cubicBezier', points: [0.4, 0, 1, 1] },
          phase: 'exit',
        },
        {
          property: 'top',
          from: { ref: 'centerY' },
          to: { axis: 'centerY', threshold: 50, whenAbove: 105, whenBelow: -5 },
          durationMs: 250,
          easing: { type: 'cubicBezier', points: [0.4, 0, 1, 1] },
          phase: 'exit',
        },
        {
          property: 'opacity',
          from: 1,
          to: 0,
          durationMs: 250,
          easing: { type: 'cubicBezier', points: [0.4, 0, 1, 1] },
          phase: 'exit',
        },
      ],
    },
    {
      id: 'ring',
      // Nested inside the animated dot wrapper in the source, so it rides the
      // dot's fly-in/exit position + fade, then adds its own scale/opacity pulse.
      inheritsFrom: { parentId: 'dot', props: ['left', 'top', 'opacity'] },
      // Circular pulse ring, absolutely positioned to fill the dot group.
      staticProps: {
        position: 'absolute',
        inset: 0,
        borderRadius: 9999,
        border: '1.5px solid {color}',
      },
      tracks: [
        {
          property: 'scale',
          from: 1,
          to: 2.8,
          durationMs: 1500,
          easing: { type: 'named', name: 'easeOut' },
          repeat: 'infinite',
          repeatDelayMs: 300,
        },
        {
          property: 'opacity',
          from: 0.6,
          to: 0,
          durationMs: 1500,
          easing: { type: 'named', name: 'easeOut' },
          repeat: 'infinite',
          repeatDelayMs: 300,
        },
      ],
    },
    {
      id: 'core',
      // Nested inside the animated dot wrapper too — rides the dot's fly-in/exit
      // position + fade. It has no animation of its own.
      inheritsFrom: { parentId: 'dot', props: ['left', 'top', 'opacity'] },
      // Circular light core (rounded-full).
      staticProps: {
        width: 10,
        height: 10,
        borderRadius: 9999,
        backgroundColor: '{color}',
        boxShadow: '0 0 8px 2px {color}60',
      },
      tracks: [],
    },
  ],
};
