/**
 * Tests for the Stage 3 dynamic signal pipeline.
 *
 * Each `trackXxx` helper is exercised against a real (in-memory)
 * project. The assertions focus on:
 *   - the project's assessment getting folded forward,
 *   - SSE patches being emitted in the expected order,
 *   - `proficiency_changed` engagement event being appended when a
 *     tier transition fires.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProficiencyDirective,
  tickTurnOnProject,
  trackClosingCheck,
  trackForceAdvance,
  trackMicrotaskCompletion,
  trackObservation,
  trackSubmissionScore,
} from '@/lib/pbl/v2/operations/dynamic-signals';
import { emptyAssessment } from '@/lib/pbl/v2/operations/proficiency';
import type { PBLProficiencyAssessment } from '@/lib/pbl/v2/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function mkProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    proficiencyAssessment: emptyAssessment(),
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [
      {
        id: 'm1',
        title: 'M1',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 't1',
            title: 'T1',
            status: 'in_progress',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('trackObservation', () => {
  it('emits a proficiency patch even when no tier transition fires', () => {
    const p = mkProject();
    const r = trackObservation(p, 'struggle');
    expect(r.transition).toBeUndefined();
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0]).toMatchObject({
      type: 'project_patch',
      patch: { kind: 'proficiency', tierChanged: false },
    });
  });

  it('flags repeat-error as a stronger negative push than first-error', () => {
    const a = mkProject();
    trackObservation(a, 'error');
    const aScore = a.proficiencyAssessment!.score;

    const b = mkProject();
    trackObservation(b, 'error', { repeat: true });
    const bScore = b.proficiencyAssessment!.score;

    expect(bScore).toBeLessThan(aScore); // repeat push more negative
  });
});

describe('trackClosingCheck', () => {
  it.each(['weak', 'ok', 'strong'] as const)('handles %s quality', (quality) => {
    const p = mkProject();
    const r = trackClosingCheck(p, quality);
    expect(r.patches.length).toBeGreaterThan(0);
    expect(p.proficiencyAssessment!.signals[0].kind).toBe('closing_check_quality');
  });
});

describe('trackForceAdvance', () => {
  it('records a beginner-leaning signal', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment!.score;
    trackForceAdvance(p);
    expect(p.proficiencyAssessment!.score).toBeLessThan(before);
    expect(p.proficiencyAssessment!.signals[0].kind).toBe('force_advance');
  });
});

describe('trackMicrotaskCompletion', () => {
  it('returns just a snapshot patch in the neutral speed band', () => {
    const p = mkProject();
    // Seed engagement so learnerTurnCount = 6 (neutral band).
    for (let i = 0; i < 6; i++) {
      p.engagementEvents.push({
        id: 'e' + i,
        kind: 'learner_turn',
        microtaskId: 't1',
        milestoneId: 'm1',
        ts: '',
      });
    }
    const r = trackMicrotaskCompletion(p, 't1');
    expect(r.transition).toBeUndefined();
    expect(r.patches).toHaveLength(1);
    expect(p.proficiencyAssessment!.signals.some((s) => s.kind === 'task_speed')).toBe(false);
  });

  it('records an advanced-leaning task_speed signal on fast completion', () => {
    const p = mkProject();
    for (let i = 0; i < 2; i++) {
      p.engagementEvents.push({
        id: 'e' + i,
        kind: 'learner_turn',
        microtaskId: 't1',
        milestoneId: 'm1',
        ts: '',
      });
    }
    trackMicrotaskCompletion(p, 't1');
    expect(p.proficiencyAssessment!.signals.some((s) => s.kind === 'task_speed')).toBe(true);
  });
});

describe('applyProficiencyDirective (the adjust_difficulty tool apply path / any language)', () => {
  const withTier = (
    tier: PBLProficiencyAssessment['tier'],
    extra: Partial<PBLProficiencyAssessment> = {},
  ) =>
    mkProject({
      proficiency: tier,
      proficiencyAssessment: { ...emptyAssessment(), tier, ...extra },
    });

  it('applies an absolute target immediately and decisively, emitting an event', () => {
    const p = withTier('beginner');
    const r = applyProficiencyDirective(p, { kind: 'absolute', tier: 'advanced' });
    expect(p.proficiency).toBe('advanced');
    expect(p.proficiencyAssessment!.tier).toBe('advanced');
    expect(p.proficiencyAssessment!.confidence).toBe(1);
    expect(p.proficiencyAssessment!.source).toBe('self-report');
    expect(p.proficiencyAssessment!.signals[0]?.kind).toBe('user_level_explicit');
    expect(r.transition).toMatchObject({ from: 'beginner', to: 'advanced' });
    expect(p.engagementEvents.some((e) => e.kind === 'proficiency_changed')).toBe(true);
  });

  it('applies a relative nudge as one step and clamps at the ends', () => {
    const up = withTier('beginner');
    const upR = applyProficiencyDirective(up, { kind: 'relative', direction: 'up' });
    expect(up.proficiency).toBe('intermediate');
    expect(upR.transition).toMatchObject({
      to: 'intermediate',
      reason: 'learner difficulty request',
    });

    // "harder" at the ceiling clamps to advanced (== current). The learner
    // still expressed an explicit preference, so it anchors the tier (no
    // fabricated transition, but a proficiency patch + locked self-report).
    const capped = withTier('advanced');
    const r = applyProficiencyDirective(capped, { kind: 'relative', direction: 'up' });
    expect(capped.proficiency).toBe('advanced');
    expect(r.transition).toBeUndefined();
    expect(r.patches).toHaveLength(1);
    expect(capped.proficiencyAssessment!.source).toBe('self-report');
    expect(capped.proficiencyAssessment!.confidence).toBe(1);
  });

  it("overrides even when the dynamic retier gates would block (learner's word wins)", () => {
    // Zero confidence + fresh counters → a dynamic signal could never retier
    // here; the explicit directive must still switch immediately.
    const p = withTier('intermediate', {
      confidence: 0,
      turnsSinceRetier: 0,
      dynamicSignalsSinceRetier: 0,
    });
    applyProficiencyDirective(p, { kind: 'absolute', tier: 'beginner' });
    expect(p.proficiency).toBe('beginner');
  });

  it('anchors the current tier (locks self-report, resets counters, NO transition/event) when the directive resolves to the current tier', () => {
    // Reviewer finding (#593, point 2): the old code early-returned
    // `{ patches: [] }` here, so a learner re-stating their current level was
    // silently ignored — confidence stayed low, the retier counters kept
    // climbing, and a couple of good answers could flip the tier right after
    // the learner explicitly anchored it. Now a same-tier self-report is a
    // real anchor: it locks confidence to 1, marks the source as self-report,
    // and resets the cooldown counters — WITHOUT fabricating a "tier changed"
    // transition or engagement event (the tier value did not move).
    const p = withTier('beginner', {
      confidence: 0.3,
      turnsSinceRetier: 4,
      dynamicSignalsSinceRetier: 3,
    });
    const beforeTransitions = p.proficiencyAssessment!.transitions.length;

    const r = applyProficiencyDirective(p, { kind: 'absolute', tier: 'beginner' });

    // Tier value unchanged, but the self-report is now anchored.
    expect(p.proficiency).toBe('beginner');
    expect(p.proficiencyAssessment!.tier).toBe('beginner');
    expect(p.proficiencyAssessment!.source).toBe('self-report');
    expect(p.proficiencyAssessment!.confidence).toBe(1);
    expect(p.proficiencyAssessment!.signals[0]?.kind).toBe('user_level_explicit');
    expect(p.proficiencyAssessment!.turnsSinceRetier).toBe(0);
    expect(p.proficiencyAssessment!.dynamicSignalsSinceRetier).toBe(0);

    // No fabricated tier change.
    expect(r.transition).toBeUndefined();
    expect(p.engagementEvents.some((e) => e.kind === 'proficiency_changed')).toBe(false);
    expect(p.proficiencyAssessment!.transitions).toHaveLength(beforeTransitions);

    // A proficiency patch IS emitted (dev badge / state sync) with tierChanged:false.
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0]).toMatchObject({
      type: 'project_patch',
      patch: { kind: 'proficiency', tierChanged: false },
    });
  });
});

describe('trackSubmissionScore', () => {
  it('high score → advanced direction', () => {
    const p = mkProject();
    trackSubmissionScore(p, 90);
    expect(p.proficiencyAssessment!.score).toBeGreaterThan(0);
  });

  it('low score → beginner direction', () => {
    const p = mkProject();
    trackSubmissionScore(p, 20);
    expect(p.proficiencyAssessment!.score).toBeLessThan(0);
  });

  it('non-finite scores are ignored', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment!.score;
    trackSubmissionScore(p, Number.NaN);
    expect(p.proficiencyAssessment!.score).toBe(before);
  });
});

describe('tickTurnOnProject', () => {
  it('increments turnsSinceRetier', () => {
    const p = mkProject();
    tickTurnOnProject(p);
    tickTurnOnProject(p);
    expect(p.proficiencyAssessment!.turnsSinceRetier).toBe(2);
  });

  it('is a no-op when the assessment is missing', () => {
    const p = mkProject({ proficiencyAssessment: undefined });
    expect(() => tickTurnOnProject(p)).not.toThrow();
    expect(p.proficiencyAssessment).toBeUndefined();
  });
});

describe('tier transition path', () => {
  it('emits proficiency_changed engagement event when score crosses', () => {
    const p = mkProject();
    // Seed: beginner with a near-boundary score, high confidence, gates clear,
    // so one strong submission tips it over to intermediate.
    p.proficiencyAssessment = {
      ...emptyAssessment(),
      tier: 'beginner',
      score: 0.32,
      confidence: 0.6,
      source: 'dynamic',
      dynamicSignalsSinceRetier: 5,
      turnsSinceRetier: 10,
    };
    const r = trackSubmissionScore(p, 100);
    expect(r.transition).toBeDefined();
    expect(p.engagementEvents.some((e) => e.kind === 'proficiency_changed')).toBe(true);
    // Should emit BOTH the engagement-event patch and the
    // proficiency-snapshot patch.
    expect(
      r.patches.find((e) => e.type === 'project_patch' && e.patch.kind === 'engagement_event'),
    ).toBeDefined();
    expect(
      r.patches.find(
        (e) =>
          e.type === 'project_patch' &&
          e.patch.kind === 'proficiency' &&
          e.patch.tierChanged === true,
      ),
    ).toBeDefined();
  });
});
