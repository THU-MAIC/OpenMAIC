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
 * Chinese unit words are matched without a trailing `\b`. `\b` only fires
 * between a word character and a non-word one, and 时 is not a word character in
 * JavaScript's `\w`, so `1 小时` at the end of a string would never match. The
 * English units get a `(?![a-z])` instead, which is the boundary they need.
 */
const HOUR_UNITS = String.raw`(?:个\s*)?(?:小时|钟头|hours?(?![a-z])|hrs?(?![a-z]))`;
const MINUTE_UNITS = String.raw`(?:分钟|分半钟|mins?(?![a-z])|minutes?(?![a-z]))`;

/** A hyphen or a space may separate the figure from its unit: `2-hour`, `45-min`. */
const UNIT_JOIN = String.raw`[\s-]*`;

/**
 * Nouns that make a duration the length of the lesson rather than the length of
 * the thing the lesson is about. 课 covers 课程 / 微课 / 大课 / 系统课.
 */
const COURSE_NOUN =
  /(?:课|讲座|讲堂|教程|视频|培训|报告|班|入门|精讲|专题|系列|导论|概论|串讲|lecture|course|lesson|class|session|talk|video|tutorial|seminar|training|webinar)/i;

/** Words that open a lesson length rather than a topical one. */
const DURATION_INTENT =
  /(?:时长|全长|总长|总共|一共|整节|整个|全程|持续|课时|duration|length|whole|total|lasts?|runs?)/i;

/**
 * Words a bare duration may be followed by and still describe a lesson: a
 * preposition (`60 minutes on entropy`) or a teaching verb (`60 分钟讲透镇痛药`).
 * A duration followed by a plain noun phrase is attributive — `a 30-minute
 * insulin response` is a phenomenon, not a sitting.
 */
const LENGTH_FOLLOWER = new RegExp(
  String.raw`^\s*(?:$|[，。、；：,.;:!?！？]|(?:on|about|for|of|in|to|covering|explaining|introducing)\b|(?:讲|说|介绍|覆盖|涵盖|带|学|练))`,
  'i',
);

interface DurationMatch {
  minutes: number;
  /** Index of the first character of the whole duration phrase. */
  start: number;
  /** Index just past the last character of the whole duration phrase. */
  end: number;
}

/** How a duration phrase relates to the lesson, judged from what surrounds it. */
type DurationContext = 'course' | 'bare' | 'attributive';

const CN_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const EN_NUMERALS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** `thirty`, `thirty-five`, `forty five` — the tens a minute count is written with. */
const EN_TENS =
  /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](one|two|three|four|five|six|seven|eight|nine))?$/i;

function englishNumeral(words: string): number | null {
  const lower = words.trim().toLowerCase();
  const tens = EN_TENS.exec(lower);
  if (tens) {
    return (EN_NUMERALS[tens[1]!.toLowerCase()] ?? 0) + (tens[2] ? (EN_NUMERALS[tens[2]] ?? 0) : 0);
  }
  return EN_NUMERALS[lower] ?? null;
}

/**
 * 一 to 九, 十, 十五, 二十, 四十五 — the counts a lesson length is written with.
 *
 * Three characters at most: `四十五分钟` is forty-five, and a two-character capture
 * read it as `十五` — fifteen — because the leading digit fell outside the match.
 */
function chineseNumeral(token: string): number | null {
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (tens) {
    const high = tens[1] ? (CN_DIGITS[tens[1]] ?? 0) : 1;
    const low = tens[2] ? (CN_DIGITS[tens[2]] ?? 0) : 0;
    return high * 10 + low;
  }
  return CN_DIGITS[token] ?? null;
}

/**
 * Rewrite written-out durations as figures.
 *
 * `一小时的课程`, `半小时的课` and `a one-hour lecture` are the ordinary way to
 * write a length, and the figure matcher reads digits only. Without this all
 * three fall through to the short path — which is the failure this feature exists
 * to prevent, and it looks exactly like the feature working.
 */
function normalizeDurationWords(text: string): string {
  return (
    text
      .replace(
        /(一\s*个\s*)?半\s*个?\s*(小时|钟头)/g,
        (_match, one: string | undefined, unit: string) => `${one ? '1.5' : '0.5'} ${unit}`,
      )
      .replace(
        /([一二两三四五六七八九十]{1,3})\s*个?\s*(小时|钟头)/g,
        (match, token: string, unit: string) => {
          const value = chineseNumeral(token);
          return value === null ? match : `${value} ${unit}`;
        },
      )
      // Minutes are written the same way: `三十分钟的课` is an ordinary request and
      // the digit matcher found nothing in it.
      .replace(
        /([一二两三四五六七八九十]{1,3})\s*个?\s*(分钟|分半钟)/g,
        (match, token: string, unit: string) => {
          const value = chineseNumeral(token);
          return value === null ? match : `${value} ${unit}`;
        },
      )
      .replace(/half\s*(?:an?\s*)?[- ]?hours?/gi, '0.5 hour')
      .replace(/\ban?\s+hours?\b/gi, '1 hour')
      .replace(
        /\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)[- ]hours?\b/gi,
        (_match, words: string) => `${englishNumeral(words) ?? 1} hours`,
      )
      // Minutes too: `a thirty-minute course` and `a ninety-minute lecture` are
      // the same ordinary request as their digit forms.
      .replace(
        /\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)[- ]minutes?\b/gi,
        (_match, words: string) => `${englishNumeral(words) ?? 1} minutes`,
      )
  );
}

/**
 * Every duration phrase in a requirement, in the order they appear.
 *
 * Read as a person would, from the largest unit mentioned: `1.5小时` is 90
 * minutes, not 1 and not 5. Compound phrases are summed, because `1 小时 30 分钟`
 * read as hours alone is 60 — a course half an hour shorter than requested.
 *
 * All of them, not the first: a requirement can name a duration without naming a
 * lesson length, and it can name both. `Create a 60-minute course about the
 * 2-hour insulin response` is an hour, and returning the first figure — or the
 * first hour — picks the phenomenon over the course.
 *
 * A figure above the longest supported sitting is skipped, not clamped and not
 * fatal to the search. "为什么睡 12 小时还是累" is a lesson about sleep, not a
 * twelve-hour course, and clamping it would plan a four-hour one; but a
 * requirement can name both — `Create a 60-minute lesson about why 12 hours of
 * sleep can leave you tired` — and stopping at the first out-of-range candidate
 * threw away the hour that was actually asked for. The minute branch gets the
 * same guard: clamping a `300-minute` request to 240 ships a course an hour short
 * with nothing to say it did.
 */
function matchDurations(text: string): DurationMatch[] {
  if (!text) return [];

  const found: DurationMatch[] = [];

  /**
   * Spans of a rejected compound, so its minutes are not read a second time as
   * a duration of their own. `a 4 hour 30 minute course` is 270 minutes and
   * unsupported; without this the minute scan then finds the `30 minute` tail
   * and plans a half-hour course out of a four-and-a-half-hour request.
   */
  const rejected: Array<{ start: number; end: number }> = [];

  const hoursPattern = new RegExp(String.raw`(\d+(?:\.\d+)?)${UNIT_JOIN}${HOUR_UNITS}`, 'gi');
  for (const hours of text.matchAll(hoursPattern)) {
    const value = Number.parseFloat(hours[1]!);
    if (!Number.isFinite(value) || value <= 0) continue;

    const start = hours.index ?? 0;
    let minutes = Math.round(value * 60);
    let end = start + hours[0].length;
    // A fractional hour already names the whole length; a trailing minutes
    // component after `1.5 小时` would be a second, contradictory figure.
    if (Number.isInteger(value)) {
      const tail = new RegExp(
        String.raw`^\s*(?:又|and|零)?\s*(\d+(?:\.\d+)?)${UNIT_JOIN}${MINUTE_UNITS}`,
        'i',
      ).exec(text.slice(end));
      const extra = tail ? Number.parseFloat(tail[1]!) : 0;
      if (tail && Number.isFinite(extra) && extra > 0) {
        minutes += Math.round(extra);
        end += tail[0].length;
      }
    }

    if (minutes > LONG_FORM_MAX_MINUTES) {
      rejected.push({ start, end });
      continue;
    }
    found.push({ minutes, start, end });
  }

  const minutePattern = new RegExp(String.raw`(\d+(?:\.\d+)?)${UNIT_JOIN}${MINUTE_UNITS}`, 'gi');
  for (const plain of text.matchAll(minutePattern)) {
    const start = plain.index ?? 0;
    if (rejected.some((span) => start >= span.start && start < span.end)) continue;

    const value = Number.parseFloat(plain[1]!);
    if (!Number.isFinite(value) || value <= 0) continue;

    const minutes = Math.round(value);
    if (minutes > LONG_FORM_MAX_MINUTES) continue;
    found.push({ minutes, start, end: start + plain[0].length });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * The duration a request asks for, in whole minutes, or `null` when it asks for
 * none.
 *
 * This reads the first number; whether that number is the length of a lesson is
 * {@link detectLongForm}'s question, because `第 3 分钟出现的心电图` is a real
 * duration in a real requirement that is not a three-minute course.
 */
export function detectRequestedMinutes(requirement: string): number | null {
  return matchDurations(normalizeDurationWords(requirement))[0]?.minutes ?? null;
}

/**
 * How a duration phrase relates to the lesson, judged from what surrounds it.
 *
 * A requirement can name a duration without naming a lesson length: `explain the
 * 30-minute insulin response` is about a phenomenon that lasts half an hour. And
 * it can name both, which is why this is per-candidate rather than per-request:
 * in `Create a 60-minute course about the 2-hour insulin response` the course is
 * the first figure and the phenomenon is the second, and only the surrounding
 * words say which is which.
 *
 * - `course`: a course noun follows it, or a duration word precedes it.
 * - `bare`: only a preposition or a teaching verb follows — `60 minutes on
 *   entropy`, `60 分钟讲透镇痛药`, or the whole requirement.
 * - `attributive`: a plain noun phrase follows, so the figure describes that
 *   thing rather than the sitting.
 */
function durationContext(text: string, match: DurationMatch): DurationContext {
  if (DURATION_INTENT.test(text.slice(Math.max(0, match.start - 24), match.end))) return 'course';

  const after = text.slice(match.end, match.end + 12);
  if (COURSE_NOUN.test(after)) return 'course';
  if (LENGTH_FOLLOWER.test(after)) return 'bare';
  return 'attributive';
}

/**
 * Whether a requirement describes a long-form sitting, and how long.
 *
 * `requestedMinutes` is `null` when the requirement names no duration; such a
 * request keeps the flat path's default rather than being guessed into an hour.
 *
 * The candidate is chosen by context, not by unit or by order. Hours used to win
 * outright, so `Create a 60-minute course about the 2-hour insulin response`
 * planned two hours; and the context test then accepted it because `course`
 * appeared somewhere in the sentence. A figure the sentence frames as the
 * course's length beats one it frames as a topic, and a bare duration beats an
 * attributive one.
 */
export function detectLongForm(requirement: string): {
  isLongForm: boolean;
  requestedMinutes: number | null;
} {
  // Normalized once, so the context checks read the same string the match was
  // taken from and its indices still line up.
  const text = normalizeDurationWords(requirement);
  const candidates = matchDurations(text);
  if (candidates.length === 0) return { isLongForm: false, requestedMinutes: null };

  const eligible = candidates
    .filter((candidate) => candidate.minutes >= LONG_FORM_MIN_MINUTES)
    .map((candidate) => ({ candidate, context: durationContext(text, candidate) }));

  const chosen =
    eligible.find((entry) => entry.context === 'course') ??
    eligible.find((entry) => entry.context === 'bare');

  if (!chosen) {
    // A duration was named, but every candidate describes something the lesson
    // is about rather than the lesson. Report the figure, keep the flat path.
    return { isLongForm: false, requestedMinutes: candidates[0]!.minutes };
  }
  return { isLongForm: true, requestedMinutes: chosen.candidate.minutes };
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
