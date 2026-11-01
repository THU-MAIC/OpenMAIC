/**
 * Rendering a plan into the two things the model is actually shown: the budget
 * block the outline stage must respect, and the position block each page's
 * narration is written against.
 *
 * Both are deliberately short. A plan the model cannot hold in its head is a
 * plan it will silently abandon by page 20, so the outline block is a table and
 * a list of rules, and the page block is one paragraph of coordinates.
 *
 * The page block is computed against the *actual* outline, not the planned one.
 * A model that returns 24 pages instead of 27 still gets correct clock marks
 * and budgets: the plan supplies the module structure and the speech rate, the
 * outline supplies the page count, and neither is allowed to make the other
 * lie.
 */

import { SPEECH_DENSITY } from './budget';
import { formatClock } from './plan';
import type {
  LongFormCoursePlan,
  LongFormModulePlan,
  LongFormSceneSlot,
  TeachingFunction,
} from './types';

const ROLE_LABEL: Readonly<Record<LongFormSceneSlot['role'], string>> = {
  open: 'open — re-anchor this module and state the question it answers',
  develop: 'develop — carry the argument one step forward',
  check: 'check — make the learner retrieve or apply, not just recognise',
  close: 'close — consolidate this module and bridge to the next',
};

const FUNCTION_LABEL: Readonly<Record<TeachingFunction, string>> = {
  hook: 'hook — open a loop the course will close',
  concept: 'concept — build the definition everything else reasons with',
  mechanism: 'mechanism — derive why it works, step by step',
  application: 'application — carry it into an unseen case, then vary a condition',
  integration: 'integration — settle the opening situation, assess, hand off',
};

/** The unit the speech budget is counted in, for prompt text. */
export function speechUnit(plan: LongFormCoursePlan): string {
  return plan.language === 'zh' ? 'characters' : 'words';
}

/**
 * The block the outline stage receives instead of the flat "1-2 scenes per
 * minute" rule. Everything in it is a hard requirement, and it is phrased as
 * one so that a model which ignores it produces an outline the validator can
 * reject rather than a course that quietly runs 22 minutes.
 */
export function buildLongFormBrief(plan: LongFormCoursePlan): string {
  const unit = speechUnit(plan);
  const obligationsOf = (moduleIndex: number): string => {
    const marks: string[] = [];
    if (plan.patchModules.includes(moduleIndex)) marks.push('P');
    if (plan.decisionModules.includes(moduleIndex)) marks.push('D');
    return marks.length > 0 ? marks.join('') : '—';
  };

  const rows = plan.modules.map((module) => {
    return `| ${module.index} | ${module.title} | ${module.teachingFunction} | ${module.durationMinutes} min | ${module.sceneBudget} | ${module.speechBudget} ${unit} | ${obligationsOf(module.index)} |`;
  });

  const bridges = plan.modules.map(
    (module) => `${module.index}. ${module.title}: ${module.bridge}`,
  );

  const checks = plan.modules
    .filter((module) => module.endsWithCheck)
    .map((module) => module.index);

  const minutesPerPage = plan.minutes / Math.max(1, plan.scenes.length);

  return [
    `## Long-form budget — HARD REQUIREMENT`,
    ``,
    `This is one ${plan.minutes}-minute sitting, not a short lesson. The budget below was fixed before any content exists. Do not change the module count, the module minutes, or the page counts.`,
    ``,
    `| # | Module | Teaching function | Minutes | Pages | Speech budget | Obligations |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `Totals: **${plan.scenes.length} pages**, **${plan.minutes} minutes**, **${plan.totalSpeechBudget} ${unit}** of narration. Obligations: **P** = carry a foundation patch, **D** = carry a decision point.`,
    ``,
    `### Rules that follow from the budget`,
    ``,
    `1. **Depth per page, not page count.** ${plan.scenes.length} pages over ${plan.minutes} minutes means roughly ${minutesPerPage.toFixed(1)} minutes per page. Do NOT return 60 or more pages for an hour: that is the flat short-lesson rhythm and it produces a lesson that sprints.`,
    `2. **Each module is a teaching move, not a topic heading.** A module's pages argue one thing together; the module title you write must name the move ("why doubling the dose does not double the effect"), not the chapter ("Pharmacokinetics II").`,
    `3. **Every module declares its bridge.** The first page of module N must pick up the thread module N-1 left. Write each module's opening so it does the picking up.`,
    checks.length > 0
      ? `4. **Retrieval beats land at module ends.** Modules ${checks.join(', ')} each end with one \`quiz\` scene (or an \`interactive\` scene that requires an action). Place them as the module's last page.`
      : `4. **One retrieval beat is enough.** This course is short enough that a single mid-course \`quiz\` scene carries it.`,
    `5. **Interactive and PBL stay scarce.** At most ${plan.multiCycle ? 3 : 2} \`interactive\` scenes and at most 1 \`pbl\` scene across the whole course. On an hour-long lesson, an interactive scene is a 3-5 minute segment, not a decoration.`,
    `6. **Fill \`estimatedDuration\` on every scene**, in seconds, taken from the page budgets above. It is the only field that lets a later stage check whether the lesson actually runs ${plan.minutes} minutes.`,
    `7. **Fill \`teachingObjective\` on every scene**, in one sentence, starting with a verb the learner can be tested on (derive / predict / distinguish / apply / diagnose). "Understand half-life" is not an objective; "predict which dose reaches steady state first" is. A page with no objective is a page with no reason to exist.`,
    `8. **Every \`description\` ends with where the page hands forward** — one clause naming the question the next page will answer. Not only at module ends: on an hour-long lesson the thread is lost between any two pages, and the reference lesson this budget was calibrated against writes a hand-forward on all ${plan.scenes.length} of its pages.`,
    ``,
    `### The four contracts this course is judged on`,
    ``,
    `These are not stylistic preferences. The outline is reviewed against them after you write it, and sent back with the specific pages that fail.`,
    ``,
    `**A. Derivation — nothing is announced.**`,
    `Every \`keyPoints\` entry is a *step*: a premise, an inference, or a conclusion, in the order the argument runs. A list of true statements about a topic is not a derivation. Concretely:`,
    `- If a point states a result ("the rate saturates"), an earlier point on the same page must be the thing that forces it.`,
    `- The last point of page N is the premise page N+1 starts from. Write them so that chain is visible.`,
    `- In the first module, state the course's spine in one line: what is established first, what is derived from it, what is finally predicted. Every later module hangs off that line.`,
    ``,
    `**B. Systems — pages belong to a map, not a list.**`,
    `Before the first concept page, establish the system: its components, the relations between them, the feedback that makes it a system rather than a heap, and its boundary (what the model does not cover). Then every page's \`description\` names **which node or edge it builds**. A page that cannot name its node is a page that will be forgotten, because it is attached to nothing.`,
    ``,
    `**C. Foundation — assumed knowledge is declared and patched.**`,
    `Every module's first page states what it assumes the learner already has. Modules marked **P** additionally carry one \`slide\` page that pre-trains the specific prerequisite the module's derivation depends on — the one thing that, if missing, makes the whole module unintelligible. Patch the prerequisite, not the topic: "what a rate constant is", not "review of kinetics".`,
    ``,
    `**D. Agency — the learner decides, then sees the cost.**`,
    `Modules marked **D** carry one \`quiz\` scene that is a *decision*, not a recall question: a situation with two or three defensible-looking options, one of which is correct for a reason the course has established. The stem gives the situation and the options; the explanation gives the consequence of each wrong choice. A question whose answer is stated on the previous page is not a decision.`,
    `When the module already ends with a retrieval scene, the decision question **is** that scene — write it as a decision rather than adding a second quiz. An hour should not contain two quizzes per module.`,
    ``,
    `### Module bridges (what each module owes the previous one)`,
    ``,
    ...bridges.map((line) => `- ${line}`),
    ``,
    `### Attention resets`,
    ``,
    `The learner gets a fresh start at ${plan.resetMinutes.map((minute) => formatClock(minute)).join(', ')}. Something must visibly change at each of those marks: a new question, a new medium (chart, simulation, case), or a new voice in the room. Do not let two modules open the same way.`,
  ].join('\n');
}

export interface ScenePositionInput {
  plan: LongFormCoursePlan;
  /** 1-based page number in the outline that was actually produced. */
  pageIndex: number;
  /** Pages the outline actually has. */
  totalPages: number;
  /** Title of the page before this one, in the teaching language. */
  previousTitle?: string;
  /** Title of the page after this one, in the teaching language. */
  nextTitle?: string;
  /**
   * What the course has established before this page, from `buildLedgerText`.
   *
   * The previous page's speech alone is a fifteen-minute lesson's memory. On an
   * hour, a page needs to know what the whole course has already said.
   */
  ledger?: string;
}

/**
 * The module a page belongs to.
 *
 * When the outline came back with the planned number of pages, the plan's own
 * scene-to-module assignment is exact and is used directly. The clock estimate
 * is only for an outline that drifted: page 8 of a 29-page hour is the planned
 * opening of module 3, but its proportional midpoint lands at minute 15.5 —
 * inside module 2, which ends at 16.
 */
export function moduleAtPage(
  plan: LongFormCoursePlan,
  pageIndex: number,
  totalPages: number,
): LongFormModulePlan {
  if (totalPages === plan.scenes.length) {
    const exact = plan.modules.find((module) => module.id === plan.scenes[pageIndex - 1]?.moduleId);
    if (exact) return exact;
  }

  const fraction = totalPages > 0 ? (pageIndex - 0.5) / totalPages : 0;
  const minuteMark = fraction * plan.minutes;
  const byClock = plan.modules.find(
    (module) => minuteMark >= module.startMinute && minuteMark < module.endMinute,
  );
  return byClock ?? plan.modules[plan.modules.length - 1] ?? plan.modules[0];
}

/**
 * What this page owes its module.
 *
 * Same rule as {@link moduleAtPage}: the plan knows that page 4 opens module 2
 * and that page 12 closes it. Falling back to "first page opens, last page
 * closes, everything else develops" tells every later module's opening page to
 * carry the argument forward instead of re-anchoring the module, which is the
 * one thing that page exists to do.
 */
function roleAt(
  plan: LongFormCoursePlan,
  pageIndex: number,
  totalPages: number,
): LongFormSceneSlot['role'] {
  if (totalPages === plan.scenes.length) {
    const slot = plan.scenes[pageIndex - 1];
    if (slot) return slot.role;
  }
  return pageIndex === 1 ? 'open' : pageIndex === totalPages ? 'close' : 'develop';
}

/**
 * Where one page sits, for the narration stage.
 *
 * Without this, every page is written as if it were the first: the model greets
 * the class on page 3, re-explains the definition on page 19, and closes the
 * course on page 12. The coordinates are the cheapest fix available — they cost
 * one paragraph and remove the whole class of errors.
 */
export function buildSceneBrief(input: ScenePositionInput): string {
  const { plan, pageIndex, totalPages, previousTitle, nextTitle, ledger } = input;
  const modulePlan = moduleAtPage(plan, pageIndex, totalPages);
  const unit = speechUnit(plan);

  const secondsPerPage = totalPages > 0 ? (plan.minutes * 60) / totalPages : 0;
  const startSeconds = Math.max(0, pageIndex - 1) * secondsPerPage;
  const endSeconds = startSeconds + secondsPerPage;
  const speechBudget = Math.round((secondsPerPage / 60) * plan.speechRate * SPEECH_DENSITY);

  const neighbours: string[] = [];
  if (previousTitle) neighbours.push(`- Previous page: 「${previousTitle}」`);
  if (nextTitle) neighbours.push(`- Next page: 「${nextTitle}」`);

  const role = roleAt(plan, pageIndex, totalPages);

  return [
    `## Where this page sits in the lesson`,
    ``,
    `- Page **${pageIndex} of ${totalPages}** in a single ${plan.minutes}-minute lesson.`,
    `- Module **${modulePlan.index} of ${plan.modules.length}** — ${modulePlan.title} (${FUNCTION_LABEL[modulePlan.teachingFunction]}).`,
    `- Course clock: **${formatClock(startSeconds / 60)} – ${formatClock(endSeconds / 60)}** of ${formatClock(plan.minutes)}.`,
    `- Page role: ${ROLE_LABEL[role]}.`,
    `- Narration budget: **about ${speechBudget} ${unit}** of speech (${Math.round(secondsPerPage)}s of screen time at a teaching pace). Stay within roughly ±15%: short pages leave dead air, long ones get cut mid-sentence.`,
    `- Module bridge you are continuing: ${modulePlan.bridge}`,
    ...neighbours,
    ``,
    `Speak to this position. Do not greet the class unless this is page 1. Do not re-introduce the course. Do not summarise the whole lesson unless this is the final module. Reference earlier material as "we just built" or "the definition from a few pages back", never as "last class".`,
    ...(ledger ? ['', ledger] : []),
  ].join('\n');
}
