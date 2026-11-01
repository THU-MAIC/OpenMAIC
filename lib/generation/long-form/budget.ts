/**
 * The numbers a long-form plan is built from: how fast speech actually runs,
 * how much of a page is actually speech, and how long a request is.
 *
 * Every constant here is a measured operating point rather than a preference,
 * because the plan's job is to be wrong in a predictable direction. A narration
 * budget that overshoots gets trimmed at generation time; one that undershoots
 * leaves a page of silence, and silence is what makes a 60-minute lesson feel
 * abandoned.
 */

import type { LongFormLanguage } from './types';

/**
 * Continuous speech units per minute.
 *
 * Chinese TTS at a comfortable teaching pace lands at 220-260 characters per
 * minute; 240 is the centre. English narration in the documentary-lecture
 * register that premium courses use runs 140-160 words per minute; 145 is the
 * centre. Both are deliberately the middle of the band rather than the fast
 * end: a long lesson read at the fast end is exhausting by minute 40.
 */
export const SPEECH_RATE_PER_MINUTE: Readonly<Record<LongFormLanguage, number>> = {
  zh: 240,
  en: 145,
};

/**
 * Fraction of a page's wall clock that is actually spoken.
 *
 * The rest is what makes a page teach rather than recite: spotlight and laser
 * moves, a chart building, a formula assembling, a pause after a question, a
 * two-second beat before the reveal. At 0.85 a 3-minute page carries about
 * 2.5 minutes of speech, which is what a well-cut lesson sounds like.
 */
export const SPEECH_DENSITY = 0.85;

/** Below this, a request is a normal lesson and the flat outline path owns it. */
export const LONG_FORM_MIN_MINUTES = 25;

/** Above this, planning a single sitting stops being credible. */
export const LONG_FORM_MAX_MINUTES = 240;

/** Pages per minute. See `LongFormPlanOptions.sceneDensity`. */
export const DEFAULT_SCENE_DENSITY = 0.45;

/** No module is shorter than this, however the minutes divide. */
export const MIN_MODULE_MINUTES = 6;

/** No module is longer than this before it needs a reset of its own. */
export const MAX_MODULE_MINUTES = 20;

/**
 * A module at or above this length ends with a retrieval beat.
 *
 * 9 minutes, not 10: once the module count was calibrated to a real hour (7
 * modules of 8-10 minutes), a 10-minute floor left only two modules qualifying
 * and a 60-minute course with two retrieval points. The reference lesson uses
 * about four. At 9 the same hour gets three, which is the density the rubric
 * asks for without turning the course into a quiz show.
 */
export const CHECKPOINT_MODULE_MINUTES = 9;

/**
 * A module at or above this length owes the learner a decision point.
 *
 * Below 8 minutes there is no room for a scenario, a choice and its
 * consequence; what comes out instead is a quiz whose stem already contains the
 * answer. Eight is the shortest module that can hold all three beats.
 */
export const DECISION_MODULE_MINUTES = 8;

/** No page is shorter than this; a 40-second page is a slide transition. */
export const MIN_SCENE_SECONDS = 60;

/** No page is longer than this; attention on one static frame dies before 5:00. */
export const MAX_SCENE_SECONDS = 300;

export function speechRateFor(language: LongFormLanguage): number {
  return SPEECH_RATE_PER_MINUTE[language];
}

/** Spoken units a page of `seconds` is budgeted to carry. */
export function speechBudgetFor(seconds: number, language: LongFormLanguage): number {
  const minutes = seconds / 60;
  return Math.round(minutes * speechRateFor(language) * SPEECH_DENSITY);
}

/**
 * The duration a request asks for, in whole minutes, or `null` when it asks for
 * none.
 *
 * Duration is not a structured field anywhere in the product — it lives inside
 * the free-form requirement — so this reads it the way a person would, from the
 * largest unit mentioned. `1.5小时` is 90 minutes, not 1 and not 5.
 *
 * Two guards, both learned from real requirement text:
 *
 * - Chinese unit words are matched without a trailing `\b`. `\b` only fires
 *   between a word character and a non-word one, and 时 is not a word character
 *   in JavaScript's `\w`, so `1 小时` at the end of a string would never match.
 *   The English units get a `(?![a-z])` instead, which is the boundary they
 *   actually need.
 * - An hour figure above the longest supported sitting is treated as absent
 *   rather than clamped. "为什么睡 12 小时还是累" is a lesson about sleep, not a
 *   twelve-hour course, and clamping it would plan a four-hour one. A genuine
 *   six-hour request falls back to the flat path, which is the lesser error.
 */
export function detectRequestedMinutes(requirement: string): number | null {
  if (!requirement) return null;

  const hours = requirement.match(
    /(\d+(?:\.\d+)?)\s*个?\s*(?:小时|钟头|hours?(?![a-z])|hrs?(?![a-z]))/i,
  );
  if (hours) {
    const value = Number.parseFloat(hours[1]);
    if (Number.isFinite(value) && value > 0) {
      const minutes = Math.round(value * 60);
      return minutes > LONG_FORM_MAX_MINUTES ? null : minutes;
    }
  }

  const minutes = requirement.match(
    /(\d+(?:\.\d+)?)[\s-]*(?:分钟|分半钟|mins?(?![a-z])|minutes?(?![a-z]))/i,
  );
  if (minutes) {
    const value = Number.parseFloat(minutes[1]);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }

  return null;
}

/**
 * Whether a requirement describes a long-form sitting, and how long.
 *
 * `requestedMinutes` is `null` when the requirement names no duration; such a
 * request keeps the flat path's default rather than being guessed into an hour.
 */
export function detectLongForm(requirement: string): {
  isLongForm: boolean;
  requestedMinutes: number | null;
} {
  const requestedMinutes = detectRequestedMinutes(requirement);
  if (requestedMinutes === null) return { isLongForm: false, requestedMinutes: null };
  return {
    isLongForm: requestedMinutes >= LONG_FORM_MIN_MINUTES,
    requestedMinutes,
  };
}

export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return LONG_FORM_MIN_MINUTES;
  return Math.min(LONG_FORM_MAX_MINUTES, Math.max(LONG_FORM_MIN_MINUTES, Math.round(minutes)));
}

/**
 * Split `total` into `parts` whole numbers in proportion to `weights`, summing
 * exactly to `total`.
 *
 * Largest-remainder rather than per-part rounding: five modules of 12, 24, 28,
 * 24 and 12 percent of 60 minutes round to 7, 14, 17, 14 and 7 — which is 59.
 * The minute that disappears is always the one a lesson notices.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0 || total <= 0 || weights.length === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (weight / sum) * total);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = total - floors.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] += 1;
    remaining -= 1;
  }
  return result;
}
