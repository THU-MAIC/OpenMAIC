/**
 * Shared easing / duration constants for the Pro mode chrome transitions.
 *
 * Centralized so the choreography between stage.tsx (sidebar slide-out,
 * canvas slot motion.layout) and EditShell (CommandBar drop, leftRail
 * slide-in, content fade) shares one timing source.
 *
 * Ease curve [0.22, 1, 0.36, 1] is the cubic-bezier ease-out-quart shape —
 * natural deceleration with a slight overshoot at the end, used elsewhere
 * in the OpenMAIC playback chrome.
 */
export const CHROME_EASE = [0.22, 1, 0.36, 1] as const;

/** Base duration for a chrome enter/exit step (seconds). */
export const CHROME_DURATION = 0.28;

/** Same duration in milliseconds (for CSS `transition` strings). */
export const CHROME_DURATION_MS = Math.round(CHROME_DURATION * 1000);

/** Ease curve as a CSS `cubic-bezier(...)` string for CSS `transition`. */
export const CHROME_EASE_CSS = `cubic-bezier(${CHROME_EASE.join(', ')})`;

/** Inter-element stagger between chrome layers (seconds). */
export const CHROME_STAGGER = 0.1;

export const CHROME_TRANSITION = {
  duration: CHROME_DURATION,
  ease: CHROME_EASE,
} as const;
