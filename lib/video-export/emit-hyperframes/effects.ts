/**
 * Effect emission — an IR {@link EffectSegment} → the overlay HTML and the GSAP
 * timeline statements that reproduce a spotlight / laser at render time.
 *
 * The two shipped descriptors (`spotlight.v1`, `laser.v1`) were transcribed from
 * the live React overlays, whose *rendering* is effect-specific (spotlight is an
 * SVG mask; laser is nested CSS divs) — a fact the descriptor data model does not
 * encode. So each effect has a targeted emitter here that mirrors its component
 * structure and reads the per-instance values (geometry, effective params,
 * timing) straight from the IR segment. The animation constants (durations,
 * offsets, easings) match the descriptor tracks 1:1.
 *
 * Determinism: everything is a paused-timeline tween — no wall-clock animation,
 * no infinite repeats (the laser ring pulse is expanded to a finite count over
 * the effect's lifetime), no `Date.now`/`Math.random`. All times are seconds on
 * the global composition clock.
 *
 * Pure: string generation only; depends on the IR types.
 */
import type { EffectSegment, PercentageGeometry } from '../ir';
import { escapeHtml, sec } from './format';

/** One emitted effect: the DOM to place in the stage and the tweens to add to `tl`. */
export interface EmittedEffect {
  html: string;
  statements: string[];
}

/** Named easing identifiers defined in the composition's inline script (see `EASE_DEFS`). */
const EASE = {
  /** spotlight cutout/border — cubic-bezier(0.16, 1, 0.3, 1). */
  outExpo: 'EASE_OUT_EXPO',
  /** laser enter travel — cubic-bezier(0.22, 1, 0.36, 1). */
  laser: 'EASE_LASER',
  /** laser exit — cubic-bezier(0.4, 0, 1, 1). */
  in: 'EASE_IN',
  /** ring pulse — Motion `easeOut` ≈ cubic-bezier(0, 0, 0.58, 1). */
  out: 'EASE_OUT',
} as const;

/** The inline script defining the eases the effect tweens reference. Deterministic, dependency-free. */
export const EASE_DEFS = `
function cubicBezier(x1, y1, x2, y2) {
  // Deterministic cubic-bezier easing as a GSAP ease function (progress → eased).
  var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
  function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
  function solveX(x) {
    var t = x;
    for (var i = 0; i < 8; i++) {
      var xEst = sampleX(t) - x;
      if (Math.abs(xEst) < 1e-6) return t;
      var d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= xEst / d;
    }
    var lo = 0, hi = 1;
    t = x;
    while (lo < hi) {
      var xEst2 = sampleX(t);
      if (Math.abs(xEst2 - x) < 1e-6) return t;
      if (x > xEst2) lo = t; else hi = t;
      t = (hi - lo) / 2 + lo;
    }
    return t;
  }
  return function (p) { return p <= 0 ? 0 : p >= 1 ? 1 : sampleY(solveX(p)); };
}
var EASE_OUT_EXPO = cubicBezier(0.16, 1, 0.3, 1);
var EASE_LASER = cubicBezier(0.22, 1, 0.36, 1);
var EASE_IN = cubicBezier(0.4, 0, 1, 1);
var EASE_OUT = cubicBezier(0, 0, 0.58, 1);
`.trim();

/** Format a number for HTML/JS output: trimmed to 4 decimals, no exponent. */
function n(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/**
 * Spotlight overlay — a full-frame SVG whose dim rect is punched out by an
 * animated mask cutout, plus a settling border. Mirrors `SpotlightOverlay` and
 * the `spotlight.v1` cutout/border/dim tracks (all in 0–100 percentage space).
 */
function emitSpotlight(seg: EffectSegment, g: PercentageGeometry, id: string): EmittedEffect {
  const dimness = typeof seg.params.dimness === 'number' ? seg.params.dimness : 0.5;
  const start = sec(seg.startMs);
  const exit = Math.max(start, sec(seg.startMs + seg.durationMs) - 0.3);
  const maskId = `${id}-mask`;
  const cut = `#${id}-cut`;
  const border = `#${id}-border`;

  const html = [
    `<div id="${id}" class="fx fx-spotlight" style="position:absolute;inset:0;z-index:100;pointer-events:none;overflow:hidden;visibility:hidden;opacity:0">`,
    `  <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0">`,
    `    <defs><mask id="${maskId}">`,
    `      <rect x="0" y="0" width="100" height="100" fill="white"/>`,
    `      <rect id="${id}-cut" fill="black" x="${n(g.x - 8)}" y="${n(g.y - 8)}" width="${n(g.w + 16)}" height="${n(g.h + 16)}" rx="4"/>`,
    `    </mask></defs>`,
    `    <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,${n(dimness)})" mask="url(#${maskId})"/>`,
    `    <rect id="${id}-border" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.2" vector-effect="non-scaling-stroke" x="${n(g.x - 4)}" y="${n(g.y - 4)}" width="${n(g.w + 8)}" height="${n(g.h + 8)}" rx="2" opacity="0"/>`,
    `  </svg>`,
    `</div>`,
  ].join('\n');

  const cutTo = `{x:${n(g.x - 0.4)},y:${n(g.y - 0.6)},width:${n(g.w + 0.8)},height:${n(g.h + 1.2)},rx:1}`;
  const end = sec(seg.startMs + seg.durationMs);
  const statements = [
    `tl.fromTo('#${id}',{autoAlpha:0},{autoAlpha:1,duration:0.3,ease:'none'},${n(start)});`,
    `tl.fromTo('${cut}',{attr:{x:${n(g.x - 8)},y:${n(g.y - 8)},width:${n(g.w + 16)},height:${n(g.h + 16)},rx:4}},{attr:${cutTo},duration:0.6,ease:${EASE.outExpo}},${n(start)});`,
    `tl.fromTo('${border}',{attr:{x:${n(g.x - 4)},y:${n(g.y - 4)},width:${n(g.w + 8)},height:${n(g.h + 8)},rx:2},opacity:0},{attr:${cutTo},opacity:1,duration:0.5,ease:${EASE.outExpo}},${n(start + 0.05)});`,
    `tl.to('#${id}',{autoAlpha:0,duration:0.3,ease:'none'},${n(exit)});`,
    // Hard kill at the boundary: a non-linear seek landing after the fade must
    // find the overlay hidden, not in a stale mid-fade state.
    `tl.set('#${id}',{autoAlpha:0},${n(end)});`,
  ];
  return { html, statements };
}

/** Frame dimensions in px — needed to express the laser fly-in as a pixel transform. */
export interface FrameDims {
  width: number;
  height: number;
}

/**
 * Laser pointer — a dot (glowing core + pulsing ring) that flies in from the
 * nearest off-frame corner to the target center. Mirrors `LaserOverlay` and the
 * `laser.v1` dot/ring/core layers. The ring's infinite pulse is expanded to a
 * finite repeat count over the effect's lifetime (determinism red-line).
 *
 * The dot is positioned statically at the target center (`left`/`top` %); the
 * fly-in and fly-out animate `x`/`y` **transforms** (px), not `left`/`top` — the
 * seek-by-frame capture engine snaps layout properties to device pixels and
 * stutters, but interpolates transforms sub-pixel.
 */
function emitLaser(
  seg: EffectSegment,
  g: PercentageGeometry,
  id: string,
  dims: FrameDims,
): EmittedEffect {
  const color = typeof seg.params.color === 'string' ? seg.params.color : '#ff0000';
  const start = sec(seg.startMs);
  const exit = Math.max(start, sec(seg.startMs + seg.durationMs) - 0.25);
  const end = sec(seg.startMs + seg.durationMs);
  const startXPct = g.centerX > 50 ? 105 : -5;
  const startYPct = g.centerY > 50 ? 105 : -5;
  // Corner offset from the target center, in px, as an x/y transform delta.
  const dx = ((startXPct - g.centerX) / 100) * dims.width;
  const dy = ((startYPct - g.centerY) / 100) * dims.height;

  // Ring pulse: 1.5s tween + 0.3s repeatDelay per cycle. Expand to a finite
  // count that fills the lifetime (never `repeat: -1`, which breaks the capturer).
  const ringCycle = 1.8;
  const ringRepeat = Math.max(0, Math.ceil(sec(seg.durationMs) / ringCycle) - 1);
  const safeColor = escapeHtml(color);

  const html = [
    `<div id="${id}" class="fx fx-laser" style="position:absolute;z-index:101;pointer-events:none;left:${n(g.centerX)}%;top:${n(g.centerY)}%;visibility:hidden;opacity:0">`,
    `  <div style="position:relative;transform:translate(-50%,-50%)">`,
    `    <div id="${id}-ring" style="position:absolute;inset:0;border-radius:9999px;border:1.5px solid ${safeColor};opacity:0.6"></div>`,
    `    <div style="width:10px;height:10px;border-radius:9999px;background-color:${safeColor};box-shadow:0 0 8px 2px ${safeColor}60"></div>`,
    `  </div>`,
    `</div>`,
  ].join('\n');

  const statements = [
    `tl.fromTo('#${id}',{autoAlpha:0},{autoAlpha:1,duration:0.15,ease:'none'},${n(start)});`,
    `tl.fromTo('#${id}',{x:${n(dx)},y:${n(dy)}},{x:0,y:0,duration:0.5,ease:${EASE.laser}},${n(start)});`,
    `tl.fromTo('#${id}-ring',{scale:1,opacity:0.6},{scale:2.8,opacity:0,duration:1.5,ease:${EASE.out},repeat:${ringRepeat},repeatDelay:0.3},${n(start)});`,
    `tl.to('#${id}',{autoAlpha:0,x:${n(dx)},y:${n(dy)},duration:0.25,ease:${EASE.in}},${n(exit)});`,
    // Hard kills at the boundary so a non-linear seek past the exit finds the
    // overlay (and its still-pulsing ring) fully hidden, not mid-animation.
    `tl.set('#${id}',{autoAlpha:0},${n(end)});`,
    `tl.set('#${id}-ring',{opacity:0},${n(end)});`,
  ];
  return { html, statements };
}

/**
 * Emit one effect segment. Degraded segments (unresolved geometry) produce no
 * output — the base frame still renders, matching the compiler's degrade-on-miss
 * contract. Unknown effect types are skipped defensively.
 */
export function emitEffect(seg: EffectSegment, id: string, dims: FrameDims): EmittedEffect {
  if (seg.degraded || !seg.geometry) return { html: '', statements: [] };
  if (seg.type === 'spotlight') return emitSpotlight(seg, seg.geometry, id);
  if (seg.type === 'laser') return emitLaser(seg, seg.geometry, id, dims);
  return { html: '', statements: [] };
}
