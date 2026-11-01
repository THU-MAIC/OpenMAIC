/**
 * Turning a length into a shape: which modules a long-form course has, how
 * many minutes and pages each one may spend, and what each page is for.
 *
 * The shape is decided before any content exists, on purpose. A model asked to
 * "write a 60-minute lesson" produces one of two failure modes: sixty thin
 * pages that race the clock, or twelve pages that claim an hour they cannot
 * fill. Fixing the budget first turns the model's job from arithmetic into
 * craft — it has to say something worth two and a half minutes, and it is told
 * which two and a half minutes.
 */

import {
  CHECKPOINT_MODULE_MINUTES,
  DECISION_MODULE_MINUTES,
  DEFAULT_SCENE_DENSITY,
  LONG_FORM_MAX_MINUTES,
  LONG_FORM_MIN_MINUTES,
  MAX_MODULE_MINUTES,
  MAX_SCENE_SECONDS,
  MIN_MODULE_MINUTES,
  MIN_SCENE_SECONDS,
  SPEECH_DENSITY,
  apportion,
  clampMinutes,
  speechBudgetFor,
  speechRateFor,
} from './budget';
import type {
  LongFormCoursePlan,
  LongFormModulePlan,
  LongFormPlanOptions,
  LongFormSceneSlot,
  LongFormLanguage,
  SceneRole,
  TeachingFunction,
} from './types';

/**
 * The order teaching functions appear in, longest pool first.
 *
 * Taking the first `n - 1` entries and closing with `integration` keeps every
 * length credible: a 25-minute course is hook → concept → mechanism →
 * integration, a 60-minute one adds application, and a two-hour one runs the
 * concept/mechanism/application trio twice with integration only at the end.
 */
const FUNCTION_POOL: readonly TeachingFunction[] = [
  'hook',
  'concept',
  'mechanism',
  'application',
  'concept',
  'mechanism',
  'application',
  'concept',
  'mechanism',
  'application',
  'concept',
];

/** Share of the course each function takes when it is not the only middle one. */
const FUNCTION_WEIGHT: Readonly<Record<TeachingFunction, number>> = {
  hook: 0.12,
  concept: 1,
  mechanism: 1.15,
  application: 1,
  integration: 0.13,
};

const MODULE_TITLE: Readonly<Record<TeachingFunction, string>> = {
  hook: 'Problem framing',
  concept: 'Concept construction',
  mechanism: 'Mechanism derivation',
  application: 'Application and transfer',
  integration: 'Integration and assessment',
};

/**
 * The bridge each module owes the one before it.
 *
 * Written as an instruction rather than a sentence: the outline stage has to
 * produce the actual bridge in the teaching language, and a pre-written English
 * sentence would leak into a Chinese course.
 */
const BRIDGE_INSTRUCTION: Readonly<Record<TeachingFunction, string>> = {
  hook: 'Open on a concrete situation the learner recognises but cannot yet explain.',
  concept: 'Name the gap the previous module left open, then define the concept that closes it.',
  mechanism:
    'Take the definition just built and ask why it must behave this way — derive, do not assert.',
  application:
    'Carry the derived mechanism into a case the learner has not seen, then vary one condition.',
  integration:
    'Return to the opening situation and settle it with what the course built, then name what remains open.',
};

/**
 * How many modules a length supports.
 *
 * Calibrated against a real 61-minute lesson (ch18 镇痛药, `eval/long-form`):
 * the designer taught it as 7 multi-page units of 4-12 minutes, averaging 7.3.
 * The previous divisor of 11 planned 6 modules of ~10 minutes, which passed the
 * count check but merged teaching moves the designer kept apart. 8.5 lands on 7
 * modules for an hour and keeps every length inside 6-20 minutes per module.
 */
export function moduleCountFor(minutes: number): number {
  const clamped = Math.min(LONG_FORM_MAX_MINUTES, Math.max(LONG_FORM_MIN_MINUTES, minutes));
  return Math.min(FUNCTION_POOL.length + 1, Math.max(4, Math.round(clamped / 8.5)));
}

/** The teaching functions a course of `count` modules runs through. */
export function functionsFor(count: number): TeachingFunction[] {
  const head = FUNCTION_POOL.slice(0, Math.max(1, count - 1));
  return [...head, 'integration'];
}

/**
 * Weights for one course: hook and integration are fixed shares, the middle
 * modules divide what is left in proportion to their function.
 */
function weightsFor(functions: readonly TeachingFunction[]): number[] {
  const fixed = functions.reduce((acc, fn) => {
    return fn === 'hook' || fn === 'integration' ? acc + FUNCTION_WEIGHT[fn] : acc;
  }, 0);
  const middleRaw = functions
    .filter((fn) => fn !== 'hook' && fn !== 'integration')
    .reduce((acc, fn) => acc + FUNCTION_WEIGHT[fn], 0);
  const middleBudget = Math.max(0, 1 - fixed);

  return functions.map((fn) => {
    if (fn === 'hook' || fn === 'integration') return FUNCTION_WEIGHT[fn];
    if (middleRaw <= 0) return middleBudget;
    return (FUNCTION_WEIGHT[fn] / middleRaw) * middleBudget;
  });
}

/**
 * Hold every part inside `[min, max]` and keep the total unchanged.
 *
 * Two different failures, one function. A 25-minute course apportions to
 * 3 / 9 / 10 / 3 minutes: three minutes is not a module, it is a slide with a
 * title, so the stubs are lifted and the derivation module pays. A four-hour
 * course apportions the hook 12% of 240 minutes — 29 minutes of opening —
 * because a fixed share of the total does not shrink as the total grows, so the
 * cap has to do it instead.
 */
export function enforceBounds(parts: readonly number[], min: number, max: number): number[] {
  const out = [...parts];

  let deficit = 0;
  for (let index = 0; index < out.length; index += 1) {
    if (out[index] < min) {
      deficit += min - out[index];
      out[index] = min;
    }
  }

  let surplus = 0;
  for (let index = 0; index < out.length; index += 1) {
    if (out[index] > max) {
      surplus += out[index] - max;
      out[index] = max;
    }
  }

  while (deficit > 0) {
    let largest = -1;
    for (let index = 0; index < out.length; index += 1) {
      if (out[index] > min && (largest === -1 || out[index] > out[largest])) largest = index;
    }
    if (largest === -1) break;
    const take = Math.min(deficit, out[largest] - min);
    out[largest] -= take;
    deficit -= take;
  }

  while (surplus > 0) {
    let smallest = -1;
    for (let index = 0; index < out.length; index += 1) {
      if (out[index] < max && (smallest === -1 || out[index] < out[smallest])) smallest = index;
    }
    if (smallest === -1) break;
    const give = Math.min(surplus, max - out[smallest]);
    out[smallest] += give;
    surplus -= give;
  }

  return out;
}

/** Seconds per page, apportioned so the module's pages sum to its minutes. */
function sceneSeconds(moduleMinutes: number, sceneBudget: number): number[] {
  const total = moduleMinutes * 60;
  const even = apportion(
    total,
    Array.from({ length: sceneBudget }, () => 1),
  );
  const clamped = even.map((seconds) =>
    Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, seconds)),
  );

  // Clamping moves the module's total off its minutes. Push the difference onto
  // pages that still have headroom, so the module still ends where it promised.
  let drift = total - clamped.reduce((acc, seconds) => acc + seconds, 0);
  for (let pass = 0; pass < 8 && drift !== 0; pass += 1) {
    for (let index = 0; index < clamped.length && drift !== 0; index += 1) {
      const step = Math.sign(drift);
      const next = clamped[index] + step;
      if (next < MIN_SCENE_SECONDS || next > MAX_SCENE_SECONDS) continue;
      clamped[index] = next;
      drift -= step;
    }
  }
  return clamped;
}

/**
 * What each page of a module is for.
 *
 * The close page and the check page both want to be last, and a four-page
 * module cannot afford both: spending two of four pages on consolidation leaves
 * one page to actually teach. So close is only scheduled separately once a
 * module has five pages, and folds into the check page below that.
 */
function rolesFor(sceneBudget: number, endsWithCheck: boolean): SceneRole[] {
  if (sceneBudget === 0) return [];
  if (sceneBudget === 1) return [endsWithCheck ? 'check' : 'open'];
  if (sceneBudget === 2) return endsWithCheck ? ['open', 'check'] : ['open', 'close'];

  const roles: SceneRole[] = Array.from({ length: sceneBudget }, () => 'develop');
  roles[0] = 'open';
  if (endsWithCheck) {
    roles[sceneBudget - 1] = 'check';
    if (sceneBudget >= 5) roles[sceneBudget - 2] = 'close';
  } else {
    roles[sceneBudget - 1] = 'close';
  }
  return roles;
}

function clampDensity(density: number): number {
  if (!Number.isFinite(density)) return DEFAULT_SCENE_DENSITY;
  return Math.min(0.6, Math.max(0.3, density));
}

/**
 * Plan a long-form course.
 *
 * Deterministic: the same minutes and language always produce the same plan, so
 * a regenerated course keeps its skeleton and only its content moves.
 */
export function planLongFormCourse(options: LongFormPlanOptions): LongFormCoursePlan {
  const minutes = clampMinutes(options.minutes);
  const language: LongFormLanguage = options.language ?? 'zh';
  const density = clampDensity(options.sceneDensity ?? DEFAULT_SCENE_DENSITY);
  const rate = speechRateFor(language);

  const functions = functionsFor(moduleCountFor(minutes));
  const durations = enforceBounds(
    apportion(minutes, weightsFor(functions)),
    MIN_MODULE_MINUTES,
    MAX_MODULE_MINUTES,
  );

  // Every long-form course gets at least one retrieval beat. On a short
  // long-form sitting no module may reach the checkpoint floor, and a course
  // with no retrieval at all is the one thing the rubric refuses to forgive.
  const checks = durations.map((duration) => duration >= CHECKPOINT_MODULE_MINUTES);
  if (!checks.some(Boolean)) checks[checks.length - 1] = true;

  const modules: LongFormModulePlan[] = [];
  const scenes: LongFormSceneSlot[] = [];
  const resetMinutes: number[] = [];
  let cursorMinute = 0;
  let sceneCursor = 1;

  functions.forEach((teachingFunction, position) => {
    const duration = durations[position];
    const sceneBudget = Math.max(2, Math.round(duration * density));
    const endsWithCheck = checks[position];
    const roles = rolesFor(sceneBudget, endsWithCheck);
    const seconds = sceneSeconds(duration, sceneBudget);
    const moduleId = `module_${position + 1}`;

    modules.push({
      id: moduleId,
      index: position + 1,
      title: MODULE_TITLE[teachingFunction],
      teachingFunction,
      startMinute: cursorMinute,
      endMinute: cursorMinute + duration,
      durationMinutes: duration,
      sceneBudget,
      speechBudget: Math.round(duration * rate * SPEECH_DENSITY),
      bridge: BRIDGE_INSTRUCTION[teachingFunction],
      endsWithCheck,
    });
    resetMinutes.push(cursorMinute);

    seconds.forEach((durationSeconds, offset) => {
      scenes.push({
        index: sceneCursor,
        moduleId,
        moduleIndex: position + 1,
        role: roles[offset] ?? 'develop',
        durationSeconds,
        speechBudget: speechBudgetFor(durationSeconds, language),
      });
      sceneCursor += 1;
    });

    cursorMinute += duration;
  });

  const middleFunctions = modules
    .map((module) => module.teachingFunction)
    .filter((fn) => fn !== 'hook' && fn !== 'integration');

  // Obligations. A decision point needs room — a module shorter than 8 minutes
  // cannot hold a scenario, the learner's choice, and the consequence of it, so
  // asking for one there produces a quiz with the answer in the stem.
  //
  // But not every module can carry one either: six decision quizzes in an hour
  // is a course that is mostly quizzes. One per ~20 minutes is the density that
  // keeps the learner deciding without turning the lesson into a test, and the
  // longest modules get them because they are the ones with room to spend.
  const decisionModules = (() => {
    const target = Math.min(5, Math.max(2, Math.round(minutes / 20)));
    const eligible = [...modules]
      .filter((module) => module.durationMinutes >= DECISION_MODULE_MINUTES)
      .sort((a, b) => b.durationMinutes - a.durationMinutes || a.index - b.index);

    // A 25-minute sitting has no module at the floor: four modules of 6-7
    // minutes. The floor is a preference, the two decisions are not, so the
    // longest modules take them in compressed form.
    const chosen =
      eligible.length >= 2
        ? eligible.slice(0, target)
        : [...modules]
            .sort((a, b) => b.durationMinutes - a.durationMinutes || a.index - b.index)
            .slice(0, 2);

    return chosen.map((module) => module.index).sort((a, b) => a - b);
  })();

  const patchModules = modules
    .filter((module) => module.teachingFunction === 'concept')
    .map((module) => module.index);

  return {
    minutes,
    language,
    speechRate: rate,
    modules,
    scenes,
    totalSpeechBudget: scenes.reduce((acc, scene) => acc + scene.speechBudget, 0),
    resetMinutes,
    multiCycle: new Set(middleFunctions).size !== middleFunctions.length,
    decisionModules,
    patchModules,
  };
}

/**
 * Where page `index` (1-based) sits in the course, or `null` when the plan has
 * no such page.
 */
export function locateScene(
  plan: LongFormCoursePlan,
  index: number,
): { scene: LongFormSceneSlot; module: LongFormModulePlan } | null {
  const scene = plan.scenes.find((candidate) => candidate.index === index);
  if (!scene) return null;
  const modulePlan = plan.modules.find((candidate) => candidate.id === scene.moduleId);
  if (!modulePlan) return null;
  return { scene, module: modulePlan };
}

/** `mm:ss` for a minute offset, used in prompts and reports. */
export function formatClock(minuteOffset: number): string {
  const total = Math.max(0, Math.round(minuteOffset * 60));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
