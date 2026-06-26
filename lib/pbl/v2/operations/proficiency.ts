/**
 * PBL v2 — Adaptive Proficiency Engine.
 *
 * Replaces "Planner LLM guesses a tier once" with a three-stage,
 * evidence-driven assessment:
 *
 *   Stage 1 (Planner-time, `source: 'planner'`)
 *     Static signals only: outline keywords + prior-scene difficulty
 *     gradient + user.bio. Used to seed `PBLProjectV2.proficiency`
 *     so the Planner can dimension microtasks appropriately.
 *
 *   Stage 2 (Hero-time, `source: 'pre-play'`)
 *     Folds in quiz-accuracy snapshots from the learner's localStorage
 *     once they enter the PBL scene. Strongest pre-PBL signal.
 *
 *   Stage 3 (Workspace runtime, `source: 'dynamic'`)
 *     Each Instructor turn translates `record_observation` /
 *     `record_closing_check` / force-advance / microtask completion
 *     speed into a `ProficiencySignal` and folds it into the score
 *     via EWMA. Hysteresis + cooldown + min-signal gating prevent
 *     tier oscillation.
 *
 * **All proficiency arithmetic is pure code, not LLM prompts.** The
 * LLM only classifies observations (the existing `record_observation`
 * tool); converting an observation to a signal is deterministic. This
 * is the explicit fix for the previous "guess via heuristic" approach
 * (see commit history for `lib/pbl/v2/agents/planner.ts`).
 *
 * The default with no evidence is intermediate: a learner who reaches a
 * PBL scene has usually just been taught the material, so seeding beginner
 * over-scaffolds them. The dynamic engine still drops to beginner quickly on
 * the first signs of struggle, and an explicit learner self-report (in the
 * requirement / bio) always overrides this default.
 *
 * The frontend never displays tier or score to the learner — by
 * product decision, proficiency is an internal-only concept. Dev mode
 * (`PBL_V2_DEV_PROFICIENCY_BADGE=true`) surfaces a debug badge.
 */

import type {
  PBLProficiency,
  PBLProficiencyAssessment,
  PBLProjectV2,
  PriorQuizResult,
  ProficiencyAssessmentSource,
  ProficiencySignal,
  ProficiencySignalKind,
  ProficiencyTransition,
} from '../types';
import type { SceneOutline } from '@/lib/types/generation';

// ---------------------------------------------------------------------------
// Tunable constants — keep these grouped so the algorithm's behaviour
// is auditable from one place.
// ---------------------------------------------------------------------------

/** Exponential decay for the EWMA update. Each signal moves the
 *  score by at most `EWMA_ALPHA * direction * weight`. */
const EWMA_ALPHA = 0.2;

/** Per-signal confidence accrual factor. Each signal adds at most
 *  `weight * CONFIDENCE_GAIN` to confidence, capped at 1. */
const CONFIDENCE_GAIN = 0.5;

/** Hard ceiling on `assessment.signals` length to keep
 *  `scene.content` bounded. */
const MAX_SIGNAL_HISTORY = 50;

/** Tier bucket boundaries. A learner must cross the *outer*
 *  boundary to ENTER a tier, but only the *inner* boundary to
 *  LEAVE it — that's the hysteresis. */
const TIER_BOUNDS = {
  /** Conservative enter-advanced threshold. The original hysteresis
   *  design called for 0.33, but early testing showed that a single
   *  strong quiz signal (~0.42) was too easily crossing into advanced,
   *  causing premature tier switches. Raised to 0.50 to require
   *  corroborating evidence before tier-up. */
  enterAdvanced: 0.5,
  leaveAdvanced: 0.2,
  enterBeginner: -0.33,
  leaveBeginner: -0.2,
} as const;

/** Confidence floor below which `shouldRetier` refuses to switch
 *  tier, regardless of where the score is. */
const MIN_CONFIDENCE_FOR_RETIER = 0.4;

/** Minimum number of dynamic signals (not counting pre-play ones)
 *  before the engine is allowed to switch tier dynamically. */
const MIN_DYNAMIC_SIGNALS = 3;

/** Minimum learner-turn count between tier switches. Prevents
 *  oscillation across the boundary on consecutive messages. */
const RETIER_COOLDOWN_TURNS = 5;

/** The teaching tier used when there is NO evidence at all — no explicit
 *  self-report, no static signals (outline / bio / quiz / prior scenes), or an
 *  old project read back without an assessment. A learner reaching a PBL scene
 *  has usually just been taught the material, so starting at beginner
 *  over-scaffolds them; the dynamic engine still drops to beginner quickly on
 *  the first real signs of struggle. Single source of truth — EVERY "no
 *  evidence" fallback (scoreToTier anchor, emptyAssessment, aggregateSignals,
 *  ensureAssessment, tierGuidanceBlock) must resolve through this. */
export const DEFAULT_TIER: PBLProficiency = 'intermediate';

/** Per-signal weight caps.
 *
 *  Rough tiers (kept in lockstep with the shrinkage calibration
 *  table further down):
 *
 *    0.45 – 0.50   strong direct signals: outline keywords, user
 *                  bio, quiz accuracy, submission score,
 *                  concept_confusion (error / struggle — the
 *                  learner is visibly stuck right now)
 *    0.40          medium signals: prior-scene difficulty,
 *                  self_correction (concept_unlocked),
 *                  closing_check_quality
 *    0.30 – 0.35   light signals: help_request, task_speed,
 *                  force_advance
 *
 *  Quiz accuracy was originally the singular strong signal (cap
 *  0.6) but two corroborating cues now matter more — in-PBL
 *  observation signals are direct evidence the engine should weigh
 *  almost as heavily, so quiz drops to 0.5 and concept_confusion
 *  bumps to 0.45. */
const WEIGHT_CAPS: Record<ProficiencySignalKind, number> = {
  outline_keyword: 0.5,
  prior_scene_difficulty: 0.4,
  user_bio: 0.5,
  user_level_explicit: 1,
  quiz_accuracy: 0.5,
  submission_score: 0.5,
  task_speed: 0.3,
  help_request: 0.35,
  concept_confusion: 0.45,
  self_correction: 0.4,
  force_advance: 0.3,
  closing_check_quality: 0.4,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Map a continuous score to a tier bucket, respecting hysteresis.
 *  Advanced is intentionally harder to enter than beginner /
 *  intermediate. One good moment should improve support, not promote
 *  the learner to advanced by itself. When `currentTier` is unset we
 *  anchor on the no-evidence default (`DEFAULT_TIER`) — this path is
 *  defensive only; callers normally pass a concrete tier. */
export function scoreToTier(score: number, currentTier?: PBLProficiency): PBLProficiency {
  const cur = currentTier === '' || !currentTier ? DEFAULT_TIER : currentTier;
  if (cur === 'beginner') {
    if (score > TIER_BOUNDS.leaveBeginner) return 'intermediate';
    return 'beginner';
  }
  if (cur === 'advanced') {
    if (score < TIER_BOUNDS.leaveAdvanced) return 'intermediate';
    return 'advanced';
  }
  // intermediate (current) — needs to cross the outer bound to move
  if (score > TIER_BOUNDS.enterAdvanced) return 'advanced';
  if (score < TIER_BOUNDS.enterBeginner) return 'beginner';
  return 'intermediate';
}

// ---------------------------------------------------------------------------
// Detectors — turn raw inputs into `ProficiencySignal`s.
// All detectors are pure and return `null` when they have no signal
// (rather than a zero-weight signal) so the caller can tell "absent"
// from "neutral".
// ---------------------------------------------------------------------------

const KEYWORDS_ADVANCED: ReadonlyArray<string> = [
  '进阶',
  '深入',
  '高级',
  '实战',
  '精通',
  'advanced',
  'deep dive',
  'production-grade',
  'in-depth',
  'expert',
];

const KEYWORDS_BEGINNER: ReadonlyArray<string> = [
  '入门',
  '基础',
  '初学',
  '小白',
  '零基础',
  '新手',
  'beginner',
  'from scratch',
  'intro',
  'introduction',
  'getting started',
];

function scanKeywords(text: string): { direction: number; weight: number; hits: string[] } {
  const lower = text.toLowerCase();
  let direction = 0;
  let weight = 0;
  const hits: string[] = [];
  for (const kw of KEYWORDS_ADVANCED) {
    if (lower.includes(kw.toLowerCase())) {
      direction += 1;
      weight += 0.1;
      hits.push(kw);
    }
  }
  for (const kw of KEYWORDS_BEGINNER) {
    if (lower.includes(kw.toLowerCase())) {
      direction -= 1;
      weight += 0.1;
      hits.push(kw);
    }
  }
  return { direction, weight, hits };
}

/** Scan the PBL outline's own difficulty cues. */
export function detectOutlineKeywords(outline: SceneOutline): ProficiencySignal | null {
  const parts = [
    outline.description,
    outline.teachingObjective ?? '',
    (outline.keyPoints ?? []).join(' '),
    outline.pblConfig?.projectTopic ?? '',
    outline.pblConfig?.projectDescription ?? '',
    (outline.pblConfig?.targetSkills ?? []).join(' '),
  ];
  const text = parts.filter(Boolean).join(' ').trim();
  if (!text) return null;
  const { direction, weight, hits } = scanKeywords(text);
  if (weight === 0) return null;
  return {
    kind: 'outline_keyword',
    direction: clamp(direction, -1, 1),
    weight: Math.min(weight, WEIGHT_CAPS.outline_keyword),
    note: `Outline keywords: ${hits.join(', ')}`,
    ts: nowIso(),
  };
}

/** Aggregate difficulty cues across the *prior* scenes (i.e. the
 *  PPT/quiz/interactive scenes that come before this PBL in the
 *  course outline). Argues "the course has been pitched at level X". */
export function analyzePriorScenes(
  allOutlines: SceneOutline[],
  currentOutlineId: string,
): ProficiencySignal | null {
  const priorScenes = allOutlines.filter((o) => o.id !== currentOutlineId && o.type !== 'pbl');
  // Only the scenes that come BEFORE this PBL — use `order` if set,
  // else fall back to array index order which is already authored
  // in playback order.
  const me = allOutlines.find((o) => o.id === currentOutlineId);
  const before =
    me && typeof me.order === 'number'
      ? priorScenes.filter((o) => typeof o.order === 'number' && o.order < me.order)
      : priorScenes;
  if (before.length === 0) return null;

  let direction = 0;
  let weight = 0;
  const hits: string[] = [];
  for (const o of before) {
    const text = [o.description, (o.keyPoints ?? []).join(' '), o.teachingObjective ?? '']
      .filter(Boolean)
      .join(' ');
    const r = scanKeywords(text);
    direction += r.direction;
    weight += r.weight * 0.5; // each prior scene contributes half
    hits.push(...r.hits);
  }
  if (weight === 0) return null;
  return {
    kind: 'prior_scene_difficulty',
    direction: clamp(direction / Math.max(before.length, 1), -1, 1),
    weight: Math.min(weight, WEIGHT_CAPS.prior_scene_difficulty),
    note: `Prior ${before.length} scene(s) cues: ${hits.slice(0, 6).join(', ')}`,
    ts: nowIso(),
  };
}

/** Parse the learner's bio for specific experience markers.
 *  Returns null for empty or signal-less bios. */
export function analyzeBio(bio: string | undefined | null): ProficiencySignal | null {
  if (!bio || !bio.trim()) return null;
  const text = bio.trim();
  let direction = 0;
  let weight = 0;
  const hits: string[] = [];

  const yearMatch = text.match(/(\d+)\s*(?:年|years?)/i);
  if (yearMatch) {
    const years = parseInt(yearMatch[1], 10);
    if (Number.isFinite(years)) {
      if (years >= 5) {
        direction += 0.8;
        weight += 0.3;
        hits.push(`${years}年经验`);
      } else if (years >= 2) {
        direction += 0.4;
        weight += 0.2;
        hits.push(`${years}年经验`);
      }
    }
  }
  if (/(博士|phd|高级工程师|架构师|principal|staff engineer|expert)/i.test(text)) {
    direction += 0.8;
    weight += 0.3;
    hits.push('senior role');
  }
  if (/(初学|刚开始|零基础|just started|no background|新手)/i.test(text)) {
    direction -= 0.8;
    weight += 0.3;
    hits.push('beginner cue');
  }
  if (weight === 0) return null;
  return {
    kind: 'user_bio',
    direction: clamp(direction, -1, 1),
    weight: Math.min(weight, WEIGHT_CAPS.user_bio),
    note: `Bio cues: ${hits.join(', ')}`,
    ts: nowIso(),
  };
}

export function detectExplicitProficiency(text: string | undefined | null): PBLProficiency | null {
  if (!text || !text.trim()) return null;
  const s = text.toLowerCase();
  if (
    /(零基础|0基础|小白|新手|初学|刚开始|完全不会|没有基础|没基础|最简单|从零开始|beginner|novice|newbie|from scratch|no background|just started)/i.test(
      s,
    )
  ) {
    return 'beginner';
  }
  if (
    /(中级|有基础|有一点基础|学过一点|会一点|了解基础|intermediate|some experience|basic familiarity)/i.test(
      s,
    )
  ) {
    return 'intermediate';
  }
  if (
    /(高级|进阶学习者|资深|专家|熟练掌握|很熟|advanced learner|expert|senior|experienced|proficient)/i.test(
      s,
    )
  ) {
    return 'advanced';
  }
  return null;
}

/** A learner-issued instruction about the teaching difficulty. Either an
 *  absolute target tier, or a one-step relative nudge. Produced by the
 *  `adjust_difficulty` tool's arg mapping (the LLM decides the intent — there
 *  is no longer any per-message regex detection). */
export type ProficiencyDirective =
  | { kind: 'absolute'; tier: PBLProficiency }
  | { kind: 'relative'; direction: 'up' | 'down' };

/** Shift a tier one step toward harder (`up`) / easier (`down`), clamped at the
 *  ends. Unset tier is treated as intermediate. Pure, for unit testing. */
export function stepProficiency(tier: PBLProficiency, direction: 'up' | 'down'): PBLProficiency {
  const order: PBLProficiency[] = ['beginner', 'intermediate', 'advanced'];
  const idx = order.indexOf(tier === '' ? 'intermediate' : tier);
  const nextIdx = direction === 'up' ? Math.min(2, idx + 1) : Math.max(0, idx - 1);
  return order[nextIdx];
}

/** Map the Instructor `adjust_difficulty` tool's `target` argument to a
 *  directive. The LLM resolves a learner's any-language difficulty request to
 *  one of these targets; this turns it into the `ProficiencyDirective` shape
 *  `applyProficiencyDirective` consumes. Pure. */
export function proficiencyDirectiveFromTarget(
  target: 'beginner' | 'intermediate' | 'advanced' | 'easier' | 'harder',
): ProficiencyDirective {
  if (target === 'easier') return { kind: 'relative', direction: 'down' };
  if (target === 'harder') return { kind: 'relative', direction: 'up' };
  return { kind: 'absolute', tier: target };
}

export function explicitAssessment(
  tier: PBLProficiency,
  source: ProficiencyAssessmentSource,
): PBLProficiencyAssessment {
  const direction = tier === 'advanced' ? 1 : tier === 'intermediate' ? 0 : -1;
  const signal: ProficiencySignal = {
    kind: 'user_level_explicit',
    direction,
    weight: WEIGHT_CAPS.user_level_explicit,
    note: `explicit learner level: ${tier}`,
    ts: nowIso(),
  };
  return {
    tier,
    score: direction,
    confidence: 1,
    source,
    signals: [signal],
    lastUpdatedAt: signal.ts,
    transitions: [],
    dynamicSignalsSinceRetier: 0,
    turnsSinceRetier: 0,
  };
}

/** Re-seat an assessment onto a deliberately chosen tier — used when a
 *  decision-maker overrides the static-signal estimate (e.g. the Planner LLM
 *  picks a tier that differs from the engine's computed one).
 *
 *  Without this, the override would set `tier` but leave the old `score`
 *  in place, so the assessment becomes internally contradictory (e.g.
 *  tier=advanced but score=0.1, which maps to intermediate). Once the dynamic
 *  retier gates later clear, `shouldRetier` reads that stale score and silently
 *  rebounds the learner back toward the old tier regardless of how they
 *  actually performed. We re-centre the score into the chosen tier's band
 *  (using the same direction mapping as an explicit self-report) and reset the
 *  retier counters, so the chosen tier holds until genuine dynamic evidence
 *  moves it. Unlike `explicitAssessment`, this does NOT inject a
 *  `user_level_explicit` signal — it is a heuristic override, not a hard
 *  learner self-report, so it must not lock out future re-evaluation. Pure. */
export function reseatAssessmentTier(
  prev: PBLProficiencyAssessment,
  tier: PBLProficiency,
  source: ProficiencyAssessmentSource,
): PBLProficiencyAssessment {
  const score = tier === 'advanced' ? 1 : tier === 'intermediate' ? 0 : -1;
  return {
    ...prev,
    tier,
    score,
    source,
    dynamicSignalsSinceRetier: 0,
    turnsSinceRetier: 0,
    lastUpdatedAt: nowIso(),
  };
}

/** Aggregate quiz-accuracy across all prior quizzes. */
export function analyzeQuizAccuracy(results: PriorQuizResult[]): ProficiencySignal | null {
  if (!results || results.length === 0) return null;
  let totalScored = 0;
  let totalCorrect = 0;
  for (const r of results) {
    const scored = r.correctCount + r.incorrectCount;
    if (scored <= 0) continue;
    totalScored += scored;
    totalCorrect += r.correctCount;
  }
  if (totalScored === 0) return null;
  const accuracy = totalCorrect / totalScored;
  // Map: 0% → -1 (strong beginner), 50% → 0, 100% → +1 (strong advanced).
  // Cap at ±1 just in case of rounding artefacts.
  const direction = clamp((accuracy - 0.5) * 2, -1, 1);
  return {
    kind: 'quiz_accuracy',
    direction,
    weight: WEIGHT_CAPS.quiz_accuracy,
    note: `${totalCorrect}/${totalScored} correct across ${results.length} quiz(es), accuracy ${(
      accuracy * 100
    ).toFixed(0)}%`,
    ts: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Dynamic signal builders — called from Instructor on each turn.
// Each takes the raw observation and returns a `ProficiencySignal`.
// ---------------------------------------------------------------------------

export function signalFromObservation(
  kind: 'error' | 'concept_unlocked' | 'struggle' | 'question',
  opts: { repeat?: boolean; note?: string } = {},
): ProficiencySignal {
  switch (kind) {
    case 'error':
      return {
        kind: 'concept_confusion',
        direction: opts.repeat ? -0.7 : -0.4,
        weight: opts.repeat ? WEIGHT_CAPS.concept_confusion : WEIGHT_CAPS.concept_confusion * 0.7,
        note: opts.note ?? (opts.repeat ? 'repeat error' : 'first error'),
        ts: nowIso(),
      };
    case 'concept_unlocked':
      return {
        kind: 'self_correction',
        direction: 0.5,
        weight: WEIGHT_CAPS.self_correction,
        note: opts.note ?? 'concept unlocked',
        ts: nowIso(),
      };
    case 'struggle':
      return {
        kind: 'concept_confusion',
        direction: -0.5,
        weight: WEIGHT_CAPS.concept_confusion * 0.8,
        note: opts.note ?? 'struggle',
        ts: nowIso(),
      };
    case 'question':
      return {
        kind: 'help_request',
        direction: -0.3,
        weight: WEIGHT_CAPS.help_request * 0.7,
        note: opts.note ?? 'help question',
        ts: nowIso(),
      };
  }
}

export function signalFromClosingCheck(quality: 'weak' | 'ok' | 'strong'): ProficiencySignal {
  const dir = quality === 'weak' ? -0.6 : quality === 'strong' ? 0.6 : 0;
  return {
    kind: 'closing_check_quality',
    direction: dir,
    // OK quality is neutral but still consumed (with weight) so it
    // contributes to confidence and signal count gating.
    weight: WEIGHT_CAPS.closing_check_quality * (quality === 'ok' ? 0.4 : 1),
    note: `closing check: ${quality}`,
    ts: nowIso(),
  };
}

export function signalFromForceAdvance(): ProficiencySignal {
  return {
    kind: 'force_advance',
    direction: -0.4,
    weight: WEIGHT_CAPS.force_advance * 0.9,
    note: 'force-advance triggered',
    ts: nowIso(),
  };
}

/** Build a signal based on how many learner turns it took to clear a
 *  microtask. Fewer is faster (advanced-leaning); many is slow
 *  (beginner-leaning). The mapping is clamped — extreme outliers
 *  don't get extra weight. */
export function signalFromTaskSpeed(learnerTurns: number): ProficiencySignal | null {
  if (!Number.isFinite(learnerTurns) || learnerTurns < 0) return null;
  let direction = 0;
  if (learnerTurns <= 2) direction = 0.5;
  else if (learnerTurns <= 4) direction = 0.25;
  else if (learnerTurns <= 7) direction = 0;
  else if (learnerTurns <= 10) direction = -0.25;
  else direction = -0.5;
  if (direction === 0) return null;
  return {
    kind: 'task_speed',
    direction,
    weight: WEIGHT_CAPS.task_speed,
    note: `${learnerTurns} learner turn(s) to clear microtask`,
    ts: nowIso(),
  };
}

/** Submission score (0–100). Higher → advanced-leaning. */
export function signalFromSubmissionScore(score: number): ProficiencySignal | null {
  if (!Number.isFinite(score)) return null;
  const normalized = clamp(score, 0, 100) / 100;
  // 50% maps to 0; ≤30% maps to -1; ≥85% maps to +1
  const direction = clamp((normalized - 0.5) * 2, -1, 1);
  return {
    kind: 'submission_score',
    direction,
    weight: WEIGHT_CAPS.submission_score,
    note: `submission score ${score}/100`,
    ts: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Aggregation — combine signals into an assessment.
// ---------------------------------------------------------------------------

/** Bootstrap assessment for a project with no evidence yet: a neutral score
 *  at the no-evidence DEFAULT_TIER, with low confidence. Callers with real
 *  signals (aggregateSignals) or a known tier (ensureAssessment) override
 *  `tier` accordingly. */
export function emptyAssessment(): PBLProficiencyAssessment {
  return {
    tier: DEFAULT_TIER,
    score: 0,
    confidence: 0.1,
    source: 'planner',
    signals: [],
    lastUpdatedAt: nowIso(),
    transitions: [],
    dynamicSignalsSinceRetier: 0,
    turnsSinceRetier: 0,
  };
}

/** Build an assessment from a fresh batch of signals (used by Stage 1
 *  and Stage 2). Confidence accrues from the sum of signal weights;
 *  score is the weighted average of `direction`s. Empty input is
 *  treated as the bootstrap default (intermediate, low confidence). */
export function aggregateSignals(
  signals: ProficiencySignal[],
  source: ProficiencyAssessmentSource,
): PBLProficiencyAssessment {
  if (!signals || signals.length === 0) {
    // No evidence at all — no explicit self-report (handled earlier in
    // computeInitialAssessment) and no outline / prior-scene / bio / quiz
    // cues. Fall back to the no-evidence default (DEFAULT_TIER, via
    // emptyAssessment): see DEFAULT_TIER for the rationale.
    return { ...emptyAssessment(), source };
  }
  // Static batch aggregation is NOT the same maths as the dynamic
  // EWMA. EWMA is designed to resist single-observation flips over
  // time; a static batch of "facts that all hold right now" should
  // settle on a fixed point in one shot.
  //
  // We use weighted-mean direction × shrinkage(weightTotal). The
  // shrinkage factor weightTotal/(weightTotal + SHRINK_K) pulls the
  // score toward 0 when total evidence is thin: one lone bio signal
  // of direction 0.4 / weight 0.2 yields score ≈ 0.07 (well inside
  // intermediate); crossing the +0.50 enter-advanced threshold
  // requires two near-maximal corroborating signals (e.g. quiz 100%
  // + strong outline keywords: dir≈1, weight≈0.5 each → ≈0.59).
  // K=0.7 calibration table (manually verified against the test
  // cases — keep this in sync if K changes or WEIGHT_CAPS shift):
  //   - bio "5 yrs"          → 0.4 × (0.2/0.9) ≈ 0.09  → intermediate
  //   - bio "10 yrs"         → 0.8 × (0.3/1.0) = 0.24  → intermediate
  //   - quiz 100%            → 1.0 × (0.5/1.2) ≈ 0.42  → intermediate
  //   - bio 10y + outline 进阶 → 0.88 × (0.5/1.2) ≈ 0.37 → intermediate
  // The intent: a single strong measurement (e.g. quiz accuracy) is not
  // enough alone to cross the 0.50 enter-advanced threshold; a single self-reported heuristic is
  // not.
  const SHRINK_K = 0.7;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of signals) {
    weightedSum += s.direction * s.weight;
    weightTotal += s.weight;
  }
  const rawDirection = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  const shrink = weightTotal / (weightTotal + SHRINK_K);
  const score = clamp(rawDirection * shrink, -1, 1);
  // Confidence also derives from weightTotal so callers can tell
  // "low evidence intermediate" apart from "strong evidence
  // intermediate". Same K → confidence ≈ shrink, capped at 1.
  const confidence = clamp(shrink, 0, 1);
  const tier = scoreToTier(score, DEFAULT_TIER);
  return {
    tier,
    score,
    confidence,
    source,
    signals: signals.slice(-MAX_SIGNAL_HISTORY),
    lastUpdatedAt: signals[signals.length - 1]?.ts ?? nowIso(),
    transitions: [],
    dynamicSignalsSinceRetier: 0,
    turnsSinceRetier: 0,
  };
}

/** Stage 1 (Planner-time) / Stage 2 (Hero-time) initial assessment.
 *  Static signals only; dynamic ones are folded later via
 *  `applySignal`. */
export function computeInitialAssessment(input: {
  outline: SceneOutline;
  priorScenes: SceneOutline[];
  userBio?: string;
  userRequirement?: string;
  priorQuizResults?: PriorQuizResult[];
  source?: ProficiencyAssessmentSource;
}): PBLProficiencyAssessment {
  const explicit = detectExplicitProficiency(
    [input.userRequirement, input.userBio].filter(Boolean).join('\n'),
  );
  if (explicit) {
    return explicitAssessment(explicit, input.source ?? 'planner');
  }

  const signals: ProficiencySignal[] = [];

  const outlineSignal = detectOutlineKeywords(input.outline);
  if (outlineSignal) signals.push(outlineSignal);

  const priorSceneSignal = analyzePriorScenes(input.priorScenes, input.outline.id);
  if (priorSceneSignal) signals.push(priorSceneSignal);

  const bioSignal = analyzeBio(input.userBio);
  if (bioSignal) signals.push(bioSignal);

  const quizSignal = analyzeQuizAccuracy(input.priorQuizResults ?? []);
  if (quizSignal) signals.push(quizSignal);

  return aggregateSignals(signals, input.source ?? 'planner');
}

// ---------------------------------------------------------------------------
// EWMA update + tier-switch decision (Stage 3).
// ---------------------------------------------------------------------------

/** Fold one new signal into the EWMA score. Pure: returns a new
 *  assessment, does not mutate. */
export function applySignal(
  current: PBLProficiencyAssessment,
  signal: ProficiencySignal,
): PBLProficiencyAssessment {
  const contribution = signal.direction * signal.weight;
  const newScore = clamp(EWMA_ALPHA * contribution + (1 - EWMA_ALPHA) * current.score, -1, 1);
  const newConfidence = clamp(current.confidence + signal.weight * CONFIDENCE_GAIN, 0, 1);
  return {
    ...current,
    score: newScore,
    confidence: newConfidence,
    signals: [...current.signals, signal].slice(-MAX_SIGNAL_HISTORY),
    lastUpdatedAt: signal.ts,
    dynamicSignalsSinceRetier: current.dynamicSignalsSinceRetier + 1,
  };
}

/** Increment the learner-turn counter on the assessment. Called on
 *  every assistant turn so `shouldRetier` can enforce a cooldown. */
export function tickTurn(current: PBLProficiencyAssessment): PBLProficiencyAssessment {
  return { ...current, turnsSinceRetier: current.turnsSinceRetier + 1 };
}

export interface RetierDecision {
  switch: boolean;
  newTier?: PBLProficiency;
  reason?: string;
}

/** Decide whether the current score warrants a tier switch right now.
 *  Cooldown / min-signal gates only apply to `dynamic` sources —
 *  pre-play / planner refreshes are always allowed to set the tier. */
export function shouldRetier(assessment: PBLProficiencyAssessment): RetierDecision {
  const desired = scoreToTier(assessment.score, assessment.tier);
  if (desired === assessment.tier) {
    return { switch: false, reason: 'same tier' };
  }
  if (assessment.confidence < MIN_CONFIDENCE_FOR_RETIER) {
    return { switch: false, reason: 'low confidence' };
  }
  if (assessment.source === 'dynamic') {
    if (assessment.dynamicSignalsSinceRetier < MIN_DYNAMIC_SIGNALS) {
      return { switch: false, reason: 'min-signal gate' };
    }
    if (assessment.turnsSinceRetier < RETIER_COOLDOWN_TURNS) {
      return { switch: false, reason: 'cooldown' };
    }
  }
  return { switch: true, newTier: desired, reason: 'crossed bucket boundary' };
}

/** Commit a tier switch decision: returns a new assessment with the
 *  new tier, appended transition, and the gating counters reset.
 *  Caller is responsible for syncing `PBLProjectV2.proficiency` and
 *  appending a `proficiency_changed` engagement event. */
export function commitTierSwitch(
  current: PBLProficiencyAssessment,
  newTier: PBLProficiency,
  reason: string,
): { next: PBLProficiencyAssessment; transition: ProficiencyTransition } {
  const ts = nowIso();
  const transition: ProficiencyTransition = {
    from: current.tier,
    to: newTier,
    ts,
    reason,
  };
  return {
    next: {
      ...current,
      tier: newTier,
      transitions: [...current.transitions, transition],
      dynamicSignalsSinceRetier: 0,
      turnsSinceRetier: 0,
      lastUpdatedAt: ts,
    },
    transition,
  };
}

/** Top-level convenience used by Instructor: fold one signal and
 *  return the next assessment + optional tier transition. */
export function processDynamicSignal(
  current: PBLProficiencyAssessment,
  signal: ProficiencySignal,
): { next: PBLProficiencyAssessment; transition?: ProficiencyTransition } {
  const dynamicAssessment: PBLProficiencyAssessment = {
    ...applySignal(current, signal),
    source: 'dynamic',
  };
  const decision = shouldRetier(dynamicAssessment);
  if (decision.switch && decision.newTier) {
    return commitTierSwitch(dynamicAssessment, decision.newTier, decision.reason ?? 'unknown');
  }
  return { next: dynamicAssessment };
}

/** Glue used by Stage 2 / pre-play recalibration: applies a fresh
 *  quiz snapshot to an existing assessment, preserving the planner-time
 *  history but bumping the source to `'pre-play'`. */
export function applyQuizSnapshot(
  current: PBLProficiencyAssessment,
  results: PriorQuizResult[],
): PBLProficiencyAssessment {
  const quizSignal = analyzeQuizAccuracy(results);
  if (!quizSignal) return current;
  const next = applySignal(current, quizSignal);
  const newTier = scoreToTier(next.score, current.tier);
  if (newTier === next.tier) {
    return { ...next, source: 'pre-play' };
  }
  // Pre-play recalibration is allowed to skip the dynamic gates —
  // quiz results are a high-quality measured behaviour, not noise.
  const ts = nowIso();
  return {
    ...next,
    tier: newTier,
    source: 'pre-play',
    transitions: [
      ...next.transitions,
      { from: current.tier, to: newTier, ts, reason: 'pre-play quiz recalibration' },
    ],
    dynamicSignalsSinceRetier: 0,
    turnsSinceRetier: 0,
    lastUpdatedAt: ts,
  };
}

// ---------------------------------------------------------------------------
// Project-level helpers — these mutate-in-place to fit the existing
// operations module style (engagement.ts, progress.ts).
// ---------------------------------------------------------------------------

/** Ensure `project.proficiencyAssessment` exists and is in sync with
 *  `project.proficiency`. Used as a safety net when older v2 projects
 *  (pre-adaptive-engine) are read back. */
export function ensureAssessment(project: PBLProjectV2): PBLProficiencyAssessment {
  if (project.proficiencyAssessment) {
    return project.proficiencyAssessment;
  }
  const seed: PBLProficiencyAssessment = {
    ...emptyAssessment(),
    tier: project.proficiency === '' ? DEFAULT_TIER : project.proficiency,
  };
  project.proficiencyAssessment = seed;
  return seed;
}

/** Single entry point used by Instructor to fold one dynamic signal:
 *  mutates the project's assessment, syncs `project.proficiency`
 *  on a tier switch, and returns whether a switch happened (so the
 *  caller can append a `proficiency_changed` engagement event). */
export function updateProjectAssessment(
  project: PBLProjectV2,
  signal: ProficiencySignal,
): { transition?: ProficiencyTransition } {
  const current = ensureAssessment(project);
  const { next, transition } = processDynamicSignal(current, signal);
  project.proficiencyAssessment = next;
  if (transition) {
    project.proficiency = transition.to;
  }
  project.updatedAt = next.lastUpdatedAt;
  return { transition };
}

/** Public read-only view — what the dev badge consumes. */
export function describeAssessment(assessment: PBLProficiencyAssessment): {
  tier: PBLProficiency;
  score: number;
  confidence: number;
  source: ProficiencyAssessmentSource;
  lastSignalKind?: ProficiencySignalKind;
} {
  return {
    tier: assessment.tier,
    score: assessment.score,
    confidence: assessment.confidence,
    source: assessment.source,
    lastSignalKind: assessment.signals[assessment.signals.length - 1]?.kind,
  };
}
