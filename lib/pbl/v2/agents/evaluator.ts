/**
 * PBL v2 — Evaluator agent.
 *
 * Three modes, one streaming pattern:
 *
 *   runTaskEvaluation       — fires after a microtask completes WITH
 *                             a submission (D1-B). Streams short
 *                             feedback + {strengths, improvements,
 *                             score?} JSON tail.
 *   runMilestoneEvaluation  — fires after the last microtask of a
 *                             milestone advances. Streams a reflection
 *                             card narrative + {learned, performance,
 *                             stars} JSON tail. Drives the
 *                             MilestoneCard UI.
 *   runFinalEvaluation      — fires after the last milestone
 *                             completes. Streams a short intro
 *                             narrative + {stars, what_you_built,
 *                             what_you_learned, whats_next} JSON tail.
 *                             Drives the Completion page hero.
 *
 * Why a separate agent (not a tool on Instructor):
 *   - Different system prompts (reflection / report tone, not
 *     teaching). Same system prompt would fight itself.
 *   - Different output contract (narrative + JSON tail vs
 *     conversational reply with optional tool calls).
 *   - Separate SSE call lets the client display "导师正在生成阶段反
 *     馈…" as a distinct phase, not as a mysterious extra Instructor
 *     turn.
 *
 * All three functions are async generators of PBLSSEEvent — the same
 * shape Instructor uses — so they slot into the same SSE wrapping
 * (`createSSEResponse`) and the same client-side stream consumer
 * (`use-instructor-stream.ts` will get a small additive parser for
 * the `evaluation` patch in PR 6.5).
 *
 * No tool calls. The evaluator does not modify the project mid-stream;
 * it only appends to `project.evaluations` once, at the end, after the
 * JSON tail parses. This keeps the streaming layer simple and means a
 * failed parse leaves the project untouched (the narrative is still
 * shown — the LLM said useful things — just no structured payload to
 * persist).
 */

import { streamText } from 'ai';
import type { LanguageModel } from 'ai';

import { createLogger } from '@/lib/logger';
import { resolveThinkingProviderOptions } from '@/lib/ai/llm';
import { withThinkingDisabled } from './runtime-thinking';
import { buildVisionUserContent } from '@/lib/generation/prompt-formatters';
import type { ThinkingConfig } from '@/lib/types/provider';

import type {
  PBLEvaluation,
  PBLEvaluationKind,
  PBLMicrotask,
  PBLMilestone,
  PBLProjectV2,
} from '../types';
import type { PBLSSEEvent } from '../api/sse';
import { addEvaluation } from '../operations/evaluation';
import { latestSubmissionForMicrotask } from '../operations/submission';
import {
  buildFinalEvalPrompt,
  buildMilestoneEvalPrompt,
  buildTaskEvalPrompt,
} from '../operations/eval-prompts';
import {
  normalizeOptionalString,
  normalizeScore,
  normalizeStars,
  normalizeStringList,
  parseEvaluationTail,
  sanitizeMilestoneEvaluationFeedback,
  stripEvaluationTail,
} from '../operations/eval-tail-parser';
import { normalizeActGoals } from '../operations/completion-stats';

const log = createLogger('PBL v2 Evaluator');

export interface RunTaskEvaluationArgs {
  project: PBLProjectV2;
  milestoneId: string;
  microtaskId: string;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  recentChatSummary?: string;
  /** True when the resolved model can read images. Gates whether an image
   *  submission is sent multimodally (else it degrades to text-only eval). */
  hasVision?: boolean;
  signal?: AbortSignal;
}

export interface RunMilestoneEvaluationArgs {
  project: PBLProjectV2;
  milestoneId: string;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  recentChatSummary?: string;
  signal?: AbortSignal;
}

export interface RunFinalEvaluationArgs {
  project: PBLProjectV2;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  recentChatSummary?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Shared streaming loop
// ---------------------------------------------------------------------------

interface RunSharedArgs {
  project: PBLProjectV2;
  kind: PBLEvaluationKind;
  microtaskId?: string;
  milestoneId?: string;
  systemPrompt: string;
  userPrompt: string;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  /** When set (image submission + vision-capable model), the user turn is sent
   *  as a multimodal message carrying this image instead of a plain prompt.
   *  Accepts an http(s) URL or a base64 data URL. */
  visionImageSrc?: string;
  signal?: AbortSignal;
}

async function* runShared(args: RunSharedArgs): AsyncGenerator<PBLSSEEvent, void, void> {
  const {
    project,
    kind,
    microtaskId,
    milestoneId,
    systemPrompt,
    userPrompt,
    languageModel,
    thinkingConfig,
    visionImageSrc,
    signal,
  } = args;

  let fullText = '';
  // Evaluations are JSON-only and render only after the structured
  // payload is persisted. Do not stream raw JSON into the chat.
  const shouldStreamTokens = false;
  // Milestone evaluations progressively sanitise the streaming text so
  // the learner never sees a flash of "Continue to next stage" / next-
  // milestone setup text before it's stripped by the final sanitizer.
  // We keep `lastSanitizedLength` to yield only the newly-sanitised
  // portion each chunk (avoiding re-sending already-shown text).
  const isMilestone = kind === 'milestone';
  let lastSanitizedLength = 0;
  try {
    const result = withThinkingDisabled(() =>
      streamText({
        model: languageModel,
        system: systemPrompt,
        // Image submission on a vision-capable model → send the picture as a
        // multimodal user turn (reusing OpenMAIC's buildVisionUserContent).
        // Everything else keeps the plain text prompt unchanged.
        ...(visionImageSrc
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: buildVisionUserContent(userPrompt, [
                    { id: 'submission', src: visionImageSrc },
                  ]),
                },
              ],
            }
          : { prompt: userPrompt }),
        ...(thinkingConfig
          ? { providerOptions: resolveThinkingProviderOptions(languageModel, thinkingConfig) }
          : {}),
        ...(signal ? { abortSignal: signal } : {}),
      }),
    );
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          // AI SDK 6.x uses `text` for the chunk content; fall back to
          // legacy `textDelta` for safety with older provider shims.
          const delta =
            (part as unknown as { text?: string; textDelta?: string }).text ??
            (part as unknown as { textDelta?: string }).textDelta ??
            '';
          if (delta) {
            fullText += delta;
            if (!shouldStreamTokens) {
              break;
            }
            if (isMilestone) {
              const sanitized = sanitizeMilestoneEvaluationFeedback(fullText);
              const next = sanitized.slice(lastSanitizedLength);
              if (next) {
                yield { type: 'token', delta: next };
                lastSanitizedLength = sanitized.length;
              }
              // When sanitized is shorter than fullText the LLM has
              // started a disallowed section — stop yielding tokens
              // but keep accumulating so the final evaluation still
              // gets the complete text for structured-tail parsing.
            } else {
              yield { type: 'token', delta };
            }
          }
          break;
        }
        case 'error': {
          const errAny = (part as unknown as { error?: unknown }).error;
          yield {
            type: 'error',
            code: 'LLM_ERROR',
            message: errAny instanceof Error ? errAny.message : String(errAny ?? 'LLM error'),
          };
          yield { type: 'done' };
          return;
        }
        case 'finish':
        default:
          break;
      }
    }
  } catch (err) {
    log.warn(`Evaluator turn threw: ${err instanceof Error ? err.message : String(err)}`);
    yield {
      type: 'error',
      code: 'STREAM_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    yield { type: 'done' };
    return;
  }

  // Parse the structured tail. Failure is non-fatal: we still
  // persist the prose feedback so the user sees what the LLM said,
  // we just don't have structured strengths/stars/etc to render.
  // This is intentional — partial success beats throwing the whole
  // evaluation away on a malformed JSON tail.
  const tail = parseEvaluationTail(fullText) ?? {};
  const evaluation = persistEvaluation({ project, kind, microtaskId, milestoneId, fullText, tail });
  yield {
    type: 'project_patch',
    patch: { kind: 'evaluation', evaluation },
  };
  yield { type: 'done' };
}

function persistEvaluation(args: {
  project: PBLProjectV2;
  kind: PBLEvaluationKind;
  microtaskId?: string;
  milestoneId?: string;
  fullText: string;
  tail: Record<string, unknown>;
}): PBLEvaluation {
  const { project, kind, microtaskId, milestoneId, tail } = args;
  const fullText =
    kind === 'milestone' ? sanitizeMilestoneEvaluationFeedback(args.fullText) : args.fullText;
  // Three kinds share the same Evaluation storage shape; each kind
  // populates a different subset of fields. This funneling lets the
  // UI branch on `kind` instead of three parallel storage paths.
  if (kind === 'milestone') {
    // {learned, performance, stars} — no score, no improvements list.
    // Funnel:
    //   tail.learned       -> Evaluation.strengths
    //   tail.performance   -> Evaluation.improvements[0]
    //                         (single element so the UI doesn't
    //                          need a second field)
    const learned = normalizeStringList(tail.learned, 6);
    const performance = normalizeOptionalString(tail.performance);
    return addEvaluation(project, {
      kind,
      microtaskId,
      milestoneId,
      feedback:
        normalizeOptionalString(tail.feedback) ??
        sanitizeMilestoneEvaluationFeedback(stripEvaluationTail(fullText)),
      strengths: learned,
      improvements: performance ? [performance] : [],
      stars: normalizeStars(tail.stars) ?? undefined,
    });
  }
  if (kind === 'final') {
    // SCENARIO ONLY: overlay the per-act goal verdict onto the authored
    // scaffold. The guard keeps normal projects completely out of this path
    // (they also never emit `act_goals`, but the explicit check makes the
    // isolation obvious and defends against a stray tail field).
    const actGoals = project.scenario ? normalizeActGoals(tail.act_goals, project) : undefined;
    return addEvaluation(project, {
      kind,
      microtaskId,
      milestoneId,
      feedback: normalizeOptionalString(tail.feedback) ?? stripEvaluationTail(fullText),
      strengths: [],
      improvements: [],
      stars: normalizeStars(tail.stars) ?? undefined,
      whatYouBuilt: normalizeStringList(tail.what_you_built, 6),
      whatYouLearned: normalizeStringList(tail.what_you_learned, 6),
      whatsNext: normalizeOptionalString(tail.whats_next) ?? undefined,
      ...(actGoals ? { actGoals } : {}),
    });
  }
  // task
  return addEvaluation(project, {
    kind,
    microtaskId,
    milestoneId,
    feedback: normalizeOptionalString(tail.feedback) ?? stripEvaluationTail(fullText),
    strengths: normalizeStringList(tail.strengths, 4),
    improvements: normalizeStringList(tail.improvements, 4),
    score: normalizeScore(tail.score) ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function* runTaskEvaluation(
  args: RunTaskEvaluationArgs,
): AsyncGenerator<PBLSSEEvent, void, void> {
  const {
    project,
    milestoneId,
    microtaskId,
    languageModel,
    thinkingConfig,
    recentChatSummary,
    signal,
  } = args;
  const lookup = findMilestoneAndTask(project, milestoneId, microtaskId);
  if (!lookup) {
    yield {
      type: 'error',
      code: 'NOT_FOUND',
      message: 'Milestone or microtask not found for task evaluation',
    };
    yield { type: 'done' };
    return;
  }
  const { milestone, microtask } = lookup;
  const { system, user } = buildTaskEvalPrompt(project, milestone, microtask, {
    recentChatSummary,
  });
  // Image submission + vision-capable model → grade the picture itself.
  // Otherwise (text/PDF, or a non-vision model) keep the text-only path.
  const latest = latestSubmissionForMicrotask(project, microtaskId);
  const visionImageSrc =
    args.hasVision && latest?.fileUrl && (latest.mimeType?.startsWith('image/') ?? false)
      ? latest.fileUrl
      : undefined;
  log.info(
    `Task eval start: project=${project.title.slice(0, 40)} milestone=${milestone.title.slice(0, 40)} task=${microtask.title.slice(0, 40)}${visionImageSrc ? ' [vision]' : ''}`,
  );
  for await (const ev of runShared({
    project,
    kind: 'task',
    microtaskId,
    milestoneId,
    systemPrompt: system,
    userPrompt: user,
    languageModel,
    thinkingConfig,
    visionImageSrc,
    signal,
  })) {
    yield ev;
  }
}

export async function* runMilestoneEvaluation(
  args: RunMilestoneEvaluationArgs,
): AsyncGenerator<PBLSSEEvent, void, void> {
  const { project, milestoneId, languageModel, thinkingConfig, recentChatSummary, signal } = args;
  const milestone = project.milestones.find((m) => m.id === milestoneId);
  if (!milestone) {
    yield {
      type: 'error',
      code: 'NOT_FOUND',
      message: 'Milestone not found for milestone evaluation',
    };
    yield { type: 'done' };
    return;
  }
  const { system, user } = buildMilestoneEvalPrompt(project, milestone, { recentChatSummary });
  log.info(
    `Milestone eval start: project=${project.title.slice(0, 40)} milestone=${milestone.title.slice(0, 40)}`,
  );
  for await (const ev of runShared({
    project,
    kind: 'milestone',
    milestoneId,
    systemPrompt: system,
    userPrompt: user,
    languageModel,
    thinkingConfig,
    signal,
  })) {
    yield ev;
  }
}

export async function* runFinalEvaluation(
  args: RunFinalEvaluationArgs,
): AsyncGenerator<PBLSSEEvent, void, void> {
  const { project, languageModel, thinkingConfig, recentChatSummary, signal } = args;
  const { system, user } = buildFinalEvalPrompt(project, { recentChatSummary });
  log.info(`Final eval start: project=${project.title.slice(0, 40)}`);
  for await (const ev of runShared({
    project,
    kind: 'final',
    systemPrompt: system,
    userPrompt: user,
    languageModel,
    thinkingConfig,
    signal,
  })) {
    yield ev;
  }
}

function findMilestoneAndTask(
  project: PBLProjectV2,
  milestoneId: string,
  microtaskId: string,
): { milestone: PBLMilestone; microtask: PBLMicrotask } | null {
  const milestone = project.milestones.find((m) => m.id === milestoneId);
  if (!milestone) return null;
  const microtask = milestone.microtasks.find((t) => t.id === microtaskId);
  if (!microtask) return null;
  return { milestone, microtask };
}
