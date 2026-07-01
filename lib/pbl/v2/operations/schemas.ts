/**
 * PBL v2 — operation schemas (Zod) and tool definitions.
 *
 * These schemas validate operation arguments shared by Instructor tools and
 * legacy/progress helpers. The active Instructor now exposes only
 * `record_observation` and `adjust_difficulty`; completion readiness is owned
 * by the right-side submission evaluation flow.
 */

import { z } from 'zod';
import type { PBLClosingQuality } from '../types';

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

/** `record_closing_check` — Instructor's evidence that the learner
 *  internalised the core point of the active microtask. */
export const RecordClosingCheckArgs = z.object({
  question: z.string().min(1).describe('The reverse question you (Instructor) asked the learner.'),
  learner_answer: z
    .string()
    .min(1)
    .describe("The learner's actual answer text. Quote it as-is — do not paraphrase."),
  quality: z
    .enum(['weak', 'ok', 'strong'])
    .describe(
      'Your honest judgement of how completely the learner showed they understood. Not a flattery score.',
    ),
});
export type RecordClosingCheckInput = z.infer<typeof RecordClosingCheckArgs>;

/** `record_stage_synthesis_check` — milestone-scope integrative
 *  evidence. Recorded ONCE at the end of a `synthesisCheck` stage:
 *  the learner's answer to a question about the WHOLE stage's core
 *  concept (not a single microtask). Satisfies both the last
 *  microtask's evidence gate and the milestone seal gate. */
export const RecordStageSynthesisCheckArgs = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'The ONE integrative question you asked about the whole stage / core concept (not about a single microtask).',
    ),
  learner_answer: z
    .string()
    .min(1)
    .describe(
      "The learner's actual answer text. Quote it as-is. If the learner had already articulated the concept spontaneously (the escape hatch — you did not need to ask), quote that articulation here.",
    ),
  quality: z
    .enum(['weak', 'ok', 'strong'])
    .describe(
      'Your honest judgement of how completely the learner showed integrative understanding.',
    ),
});
export type RecordStageSynthesisCheckInput = z.infer<typeof RecordStageSynthesisCheckArgs>;

/** `record_observation` — analytics only: log a notable learning event
 *  (repeat error, struggle, substantive question) for the evaluator. This does
 *  NOT gate readiness or trigger advancement. */
export const RecordObservationArgs = z.object({
  kind: z
    .enum(['error', 'struggle', 'question'])
    .describe(
      'error: learner hit a real bug worth tracking. ' +
        'struggle: learner is stuck longer than expected without an explicit error. ' +
        'question: learner asked a substantive, non-routine question.',
    ),
  signature: z
    .string()
    .min(1)
    .describe(
      'Short stable MACHINE tag identifying the event so duplicates can be deduped ' +
        "(e.g. 'undefined_variable', 'off_by_one'). " +
        'This is never shown to the learner — use `label` for the human-readable name.',
    ),
  label: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Optional short human-readable name of the event in the learner's content language."),
  note: z
    .string()
    .max(500)
    .optional()
    .describe(
      'One sentence quoting / referencing the learner action that justifies this observation.',
    ),
});
export type RecordObservationInput = z.infer<typeof RecordObservationArgs>;

/** `adjust_difficulty` — apply a learner's explicit difficulty / level request,
 *  in ANY language. The LLM resolves the request to one of these targets. */
export const AdjustDifficultyArgs = z.object({
  target: z
    .enum(['beginner', 'intermediate', 'advanced', 'easier', 'harder'])
    .describe(
      "The level the learner asked for. Use the absolute tiers (beginner/intermediate/advanced) when they name a level or describe their own ('I'm a beginner', '改成中级', '上級者向けに'); use easier/harder for a relative nudge ('简单一点', 'сделай сложнее', 'too hard') — that shifts one step from the current level.",
    ),
});
export type AdjustDifficultyInput = z.infer<typeof AdjustDifficultyArgs>;

/** `advance_micro_task` — mark the current microtask complete. Server
 *  refuses to advance unless evidence has been recorded for the
 *  microtask (closing_check OR concept_unlocked observation). */
export const AdvanceMicrotaskArgs = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      'One-sentence summary of what the learner produced / showed that lets you mark this task done.',
    ),
  assessment: z
    .object({
      problems: z
        .string()
        .describe('Specific friction or misconceptions encountered. Empty string if none.'),
      resolution: z
        .string()
        .describe('How the friction was resolved (or "not encountered" if `problems` is empty).'),
      performance: z
        .string()
        .describe(
          'Short read on the learner: speed, engagement, depth of grasp. Honest, internal — never shown to learner.',
        ),
    })
    .describe(
      'Internal teaching record — never surfaced to the learner. Three short fields used by the evaluator.',
    ),
});
export type AdvanceMicrotaskInput = z.infer<typeof AdvanceMicrotaskArgs>;

// ---------------------------------------------------------------------------
// Quality / kind helpers
// ---------------------------------------------------------------------------

export const CLOSING_QUALITY_VALUES: PBLClosingQuality[] = ['weak', 'ok', 'strong'];
