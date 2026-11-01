/**
 * From a free-form requirement to a plan, or to nothing.
 *
 * Duration is not a structured field anywhere in the product: it lives inside
 * the sentence the user typed. This is the one place that reads it, so the
 * outline stage and the narration stage cannot disagree about whether a course
 * is long-form or how long it is.
 */

import { detectLongForm } from './budget';
import { planLongFormCourse } from './plan';
import type { LongFormCoursePlan, LongFormLanguage } from './types';

/**
 * The teaching language, inferred from the requirement's script.
 *
 * A heuristic, and knowingly a shallow one: it counts CJK characters against
 * Latin letters. It exists because the speech budget is counted in characters
 * for Chinese and words for English — a 40% error either way — and the
 * requirement's script is a better signal than a default. An explicit
 * instruction ("teach me in English") inside a Chinese sentence will be missed;
 * that error costs budget accuracy, not correctness, and the language directive
 * downstream still wins on what is actually said.
 */
export function inferPlanLanguage(text: string): LongFormLanguage {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  if (cjk === 0) return 'en';
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk * 2 >= latin ? 'zh' : 'en';
}

/**
 * The plan for a requirement, or `null` when the requirement is not long-form.
 *
 * `null` is the signal that the flat short-lesson path owns this request, so
 * callers must not treat it as an error.
 */
export function planForRequirement(
  requirement: string,
  options?: { sceneDensity?: number },
): LongFormCoursePlan | null {
  const { isLongForm, requestedMinutes } = detectLongForm(requirement);
  if (!isLongForm || requestedMinutes === null) return null;

  return planLongFormCourse({
    minutes: requestedMinutes,
    language: inferPlanLanguage(requirement),
    ...(options?.sceneDensity !== undefined ? { sceneDensity: options.sceneDensity } : {}),
  });
}
