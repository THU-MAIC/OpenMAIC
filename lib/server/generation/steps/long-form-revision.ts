/**
 * The revision loop: draft → critique → repair → critique again.
 *
 * This lives outside the streaming outline step because it is a different kind
 * of work. Streaming is one long model turn that the browser watches appear;
 * revision is two short turns whose output replaces the draft wholesale. Keeping
 * them apart means a failed critique cannot corrupt a good draft, and a failed
 * repair cannot leave the course half-rewritten.
 *
 * The loop is deliberately conservative in one direction: it only ever adopts a
 * revision that survives `isSafeRevision`, and it stops the moment a critique
 * cannot be parsed. An hour-long course that is structurally sound but shallow
 * is worth more than a rewritten one nobody reviewed.
 */

import { callLLM } from '@/lib/ai/llm';
import {
  CRITIQUE_MIN_MS,
  MAX_REVISION_ROUNDS,
  REVISE_MIN_MS,
  auditOutline,
  buildLongFormBrief,
  critiquePasses,
  defectPages,
  applyRevisionPatch,
  formatCritiqueForRevision,
  hasTimeFor,
  isSafeRevision,
  mergeAuditIntoCritique,
  parseCritique,
  parseRevisionPatch,
  serializeOutlineForCritic,
  shouldRevise,
  type Critique,
  type LongFormCoursePlan,
} from '@/lib/generation/long-form';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

import type { StepContext, StepLanguageModel } from './context';
import type { OutlineEvent, OutlineResult } from './outline';

export interface LongFormRevisionInput {
  draft: OutlineResult;
  requirement: string;
  plan: LongFormCoursePlan;
  model: StepLanguageModel;
  ctx: StepContext<OutlineEvent>;
  /**
   * Epoch ms after which no further call may start.
   *
   * The step's deadline aborts the whole outline, draft included, so the loop
   * has to know when to stop rather than be stopped. Absent means unbounded.
   */
  deadlineAt?: number;
}

async function runPrompt(
  promptId: (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS],
  variables: Record<string, unknown>,
  input: LongFormRevisionInput,
): Promise<string | null> {
  const prompts = buildPrompt(promptId, variables);
  if (!prompts) return null;

  const result = await callLLM(
    {
      model: input.model.model,
      abortSignal: input.ctx.signal,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      maxRetries: 0,
    },
    promptId,
    undefined,
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );
  return result.text;
}

async function critiqueOnce(
  current: OutlineResult,
  auditSummary: string,
  input: LongFormRevisionInput,
): Promise<Critique | null> {
  const text = await runPrompt(
    PROMPT_IDS.LONG_FORM_CRITIQUE,
    {
      requirement: input.requirement,
      budget: buildLongFormBrief(input.plan),
      outline: serializeOutlineForCritic(current.outlines),
      // The critic is told what arithmetic already found so it spends its
      // reading on judgement instead of re-counting minutes.
      audit: auditSummary,
    },
    input,
  );
  return text ? parseCritique(text) : null;
}

async function reviseOnce(
  current: OutlineResult,
  critique: Critique,
  input: LongFormRevisionInput,
): Promise<OutlineResult | null> {
  const text = await runPrompt(
    PROMPT_IDS.LONG_FORM_REVISE,
    {
      requirement: input.requirement,
      budget: buildLongFormBrief(input.plan),
      outline: serializeOutlineForCritic(current.outlines),
      defects: formatCritiqueForRevision(critique),
    },
    input,
  );
  if (!text) return null;

  const patch = parseRevisionPatch(text);
  if (!patch) {
    input.ctx.log.warn('long-form revision: the repair described no change');
    return null;
  }

  const applied = applyRevisionPatch(current.outlines, patch);
  if (!applied.ok) {
    input.ctx.log.warn(`long-form revision: unusable patch (${applied.reason})`);
    return null;
  }

  return {
    outlines: applied.outlines,
    // The directive and title are the course's identity; a repair pass has no
    // business changing either, and a patch cannot express it anyway.
    languageDirective: current.languageDirective,
    courseTitle: current.courseTitle,
    taskEngineMode: current.taskEngineMode,
    // A repair cannot turn a long-form outline into something else, or the
    // reverse; the flag describes how the draft was planned.
    ...(current.longForm ? { longForm: true } : {}),
  };
}

/**
 * Run the critique/repair loop over a drafted outline.
 *
 * Returns the draft unchanged when the requirement is not long-form, when the
 * critic cannot be parsed, when the critic passes, or when a repair fails its
 * safety check. Every one of those is a normal outcome, not an error.
 */
export async function reviseLongFormOutline(input: LongFormRevisionInput): Promise<OutlineResult> {
  const { log } = input.ctx;
  let current = input.draft;

  for (let round = 1; round <= MAX_REVISION_ROUNDS; round += 1) {
    if (input.ctx.signal?.aborted) return current;
    if (!hasTimeFor(input.deadlineAt, CRITIQUE_MIN_MS)) {
      log.info(`long-form revision: no time left for round ${round}, shipping the draft`);
      return current;
    }

    // Arithmetic runs first: it is certain, it is cheap, and the critic is
    // handed its findings so it spends its reading on judgement.
    const audit = auditOutline(input.plan, current.outlines);
    if (audit.defects.length > 0) {
      log.info(
        `long-form revision round ${round}: arithmetic — ${Math.round(audit.totalSeconds / 60)}/${Math.round(audit.targetSeconds / 60)} min, ${audit.defects.length} defect(s)`,
      );
    }

    let critique: Critique | null;
    try {
      critique = await critiqueOnce(current, audit.summary, input);
    } catch (error) {
      log.warn(`long-form revision: critique failed, keeping the draft`, error);
      return current;
    }

    if (!critique) {
      log.warn('long-form revision: critique was unusable, keeping the draft');
      return current;
    }

    // Certain findings enter the loop whether or not the critic noticed them.
    critique = mergeAuditIntoCritique(critique, audit);

    const scores = Object.entries(critique.scores)
      .map(([dimension, score]) => `${dimension}=${score}`)
      .join(' ');
    log.info(
      `long-form revision round ${round}: ${scores} · ${critique.defects.length} defect(s)` +
        (critique.defects.length > 0
          ? ` on pages ${defectPages(critique).join(',') || 'course level'}`
          : ''),
    );

    // `round` counts critiques; `shouldRevise` counts repairs already applied.
    // Passing the loop counter made the second round refuse to repair — the
    // course got one pass, not the two the budget allows.
    if (critiquePasses(critique) || !shouldRevise(critique, round - 1)) {
      log.info(`long-form revision: stopping after round ${round} (${critique.verdict})`);
      return current;
    }

    if (!hasTimeFor(input.deadlineAt, REVISE_MIN_MS)) {
      log.info(`long-form revision: no time left to repair in round ${round}, shipping the draft`);
      return current;
    }

    let revised: OutlineResult | null;
    try {
      revised = await reviseOnce(current, critique, input);
    } catch (error) {
      log.warn('long-form revision: repair failed, keeping the previous outline', error);
      return current;
    }
    if (!revised) return current;

    const safety = isSafeRevision(current.outlines, revised.outlines);
    if (!safety.ok) {
      log.warn(`long-form revision: rejected the repair — ${safety.reason}`);
      return current;
    }

    log.info(
      `long-form revision round ${round}: adopted ${revised.outlines.length} pages (was ${current.outlines.length})`,
    );
    current = revised;
  }

  return current;
}
