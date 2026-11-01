/**
 * Long-form course planning: the vocabulary of a 60-minute lesson.
 *
 * The standard outline path treats a course as a flat list of 8-15 scenes and
 * assumes one to two scenes per minute, which is right for a 15-20 minute
 * lesson and wrong for an hour. A 60-minute lesson is not "four 15-minute
 * lessons stapled together": it has module boundaries, attention resets, a
 * difficulty curve and a memory spine that no single scene owns.
 *
 * This module is the pure planning layer for that shape. It knows nothing
 * about models, prompts or persistence — it turns a duration and a language
 * into an explicit time budget that later stages must spend, and it is the
 * single source of truth for how many minutes, scenes and spoken characters a
 * long-form course is allowed.
 */

/** What a module is *for*. Modules are chosen by teaching function, not by topic. */
export type TeachingFunction =
  /** Open the loop: a problem, a phenomenon or a bet the learner cannot yet settle. */
  | 'hook'
  /** Build the concept the rest of the course will reason with. */
  | 'concept'
  /** Derive the mechanism: why it works, step by step. */
  | 'mechanism'
  /** Move it: worked examples, transfer, near-miss cases. */
  | 'application'
  /** Close the loop: integrate, assess, and hand off to what comes next. */
  | 'integration';

/** Where a page sits in its module's own arc. */
export type SceneRole =
  /** First page of a module: re-anchor and state the question. */
  | 'open'
  /** Middle pages: carry the module's argument. */
  | 'develop'
  /** A retrieval or practice beat inside the module. */
  | 'check'
  /** Last page of a module: consolidate and bridge to the next one. */
  | 'close';

export interface LongFormModulePlan {
  /** Stable id, `module_1` upward. */
  id: string;
  /** 1-based position in the course. */
  index: number;
  /** Working title the outline stage refines in the teaching language. */
  title: string;
  teachingFunction: TeachingFunction;
  /** Whole minutes, inclusive of start and exclusive of end. */
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  /** Pages this module is allowed to spend. Fixed before content exists. */
  sceneBudget: number;
  /** Spoken characters (zh) or words (en) this module may spend. */
  speechBudget: number;
  /**
   * The device that keeps this module attached to the previous one. Module
   * boundaries are where long lessons lose their thread, so each one carries
   * an explicit bridge rather than hoping the model writes one.
   */
  bridge: string;
  /** Whether this module should end with a retrieval beat (quiz or check). */
  endsWithCheck: boolean;
}

export interface LongFormSceneSlot {
  /** 1-based page number across the whole course. */
  index: number;
  moduleId: string;
  moduleIndex: number;
  role: SceneRole;
  /** Seconds this page is expected to fill. */
  durationSeconds: number;
  /** Spoken characters (zh) or words (en) budgeted for this page's narration. */
  speechBudget: number;
}

export interface LongFormCoursePlan {
  /** Requested total length in whole minutes. */
  minutes: number;
  language: LongFormLanguage;
  /** Units per minute of continuous speech for this language. */
  speechRate: number;
  modules: LongFormModulePlan[];
  scenes: LongFormSceneSlot[];
  /** Sum of every scene's speech budget; the whole course's spoken allowance. */
  totalSpeechBudget: number;
  /** Wall-clock minute marks where the learner is meant to get a fresh start. */
  resetMinutes: number[];
  /** True when the requested length needed more than one teaching cycle. */
  multiCycle: boolean;
  /**
   * Modules that must carry a decision point: a moment where the learner
   * chooses, and then sees what the choice costs.
   *
   * Long lessons fail at agency before they fail at information. An hour of
   * correctly derived conclusions still leaves someone unable to act, because
   * nothing in the hour ever asked them to pick. These modules owe one.
   */
  decisionModules: number[];
  /**
   * Modules that must declare the foundation they assume and patch it.
   *
   * The concept modules are where a missing prerequisite does the most damage:
   * every later derivation rests on them, so a learner who lacks the base does
   * not fall behind on one page, they fall behind on the rest of the course.
   */
  patchModules: number[];
}

export type LongFormLanguage = 'zh' | 'en';

export interface LongFormPlanOptions {
  minutes: number;
  language?: LongFormLanguage;
  /**
   * Pages per minute. Long-form lessons run *deeper* per page, not *more*
   * pages: 0.45 puts a 60-minute course at 27 pages of 2-3 minutes each,
   * against 60-120 pages at the flat path's 1-2 per minute.
   */
  sceneDensity?: number;
}
