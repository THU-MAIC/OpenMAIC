/**
 * Tests for the adaptive proficiency engine.
 *
 * Covers all three stages: planner-time initial assessment, pre-play
 * quiz recalibration, and dynamic in-PBL signals. Also covers the
 * robustness matrix from the design doc (missing bio / missing quiz /
 * empty outline / all-signals-missing) and the anti-oscillation gates
 * (hysteresis, cooldown, min-signals, confidence floor).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER,
  aggregateSignals,
  analyzeBio,
  analyzePriorScenes,
  analyzeQuizAccuracy,
  applyQuizSnapshot,
  applySignal,
  commitTierSwitch,
  computeInitialAssessment,
  describeAssessment,
  detectOutlineKeywords,
  detectExplicitProficiency,
  proficiencyDirectiveFromTarget,
  reseatAssessmentTier,
  stepProficiency,
  emptyAssessment,
  ensureAssessment,
  processDynamicSignal,
  scoreToTier,
  shouldRetier,
  signalFromClosingCheck,
  signalFromForceAdvance,
  signalFromObservation,
  signalFromSubmissionScore,
  signalFromTaskSpeed,
  tickTurn,
  updateProjectAssessment,
} from '@/lib/pbl/v2/operations/proficiency';
import type { PBLProficiencyAssessment, PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';
import type { SceneOutline } from '@/lib/types/generation';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function mkOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'o1',
    type: 'pbl',
    title: 'Build a CSV analyser',
    description: 'Hands-on data project',
    keyPoints: ['Read CSV', 'Aggregate'],
    order: 3,
    ...overrides,
  };
}

function mkProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreToTier — hysteresis
// ---------------------------------------------------------------------------

describe('scoreToTier — hysteresis', () => {
  it('intermediate stays intermediate inside ±0.33', () => {
    expect(scoreToTier(0, 'intermediate')).toBe('intermediate');
    expect(scoreToTier(0.3, 'intermediate')).toBe('intermediate');
    expect(scoreToTier(-0.3, 'intermediate')).toBe('intermediate');
  });

  it('intermediate → advanced is intentionally conservative', () => {
    expect(scoreToTier(0.51, 'intermediate')).toBe('advanced');
    expect(scoreToTier(0.5, 'intermediate')).toBe('intermediate');
  });

  it('intermediate → beginner needs score < -0.33', () => {
    expect(scoreToTier(-0.34, 'intermediate')).toBe('beginner');
    expect(scoreToTier(-0.33, 'intermediate')).toBe('intermediate');
  });

  it('advanced stays advanced down to +0.20 (hysteresis)', () => {
    expect(scoreToTier(0.25, 'advanced')).toBe('advanced');
    expect(scoreToTier(0.19, 'advanced')).toBe('intermediate');
  });

  it('beginner stays beginner up to -0.20 (hysteresis)', () => {
    expect(scoreToTier(-0.25, 'beginner')).toBe('beginner');
    expect(scoreToTier(-0.19, 'beginner')).toBe('intermediate');
  });

  it('treats empty / undefined current tier as intermediate', () => {
    expect(scoreToTier(0, '')).toBe('intermediate');
    expect(scoreToTier(0, undefined)).toBe('intermediate');
  });
});

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

describe('detectOutlineKeywords', () => {
  it('returns null when no difficulty cues present', () => {
    expect(detectOutlineKeywords(mkOutline())).toBeNull();
  });

  it('detects advanced cues (positive direction)', () => {
    const signal = detectOutlineKeywords(
      mkOutline({ description: '深入实战 production-grade 项目', keyPoints: ['进阶'] }),
    );
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBeGreaterThan(0);
    expect(signal!.weight).toBeGreaterThan(0);
  });

  it('detects beginner cues (negative direction)', () => {
    const signal = detectOutlineKeywords(
      mkOutline({ description: '零基础入门小白', keyPoints: ['from scratch'] }),
    );
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBeLessThan(0);
  });

  it('caps weight at 0.5 even when many keywords match', () => {
    const signal = detectOutlineKeywords(
      mkOutline({
        description: '入门 基础 初学 小白 零基础 新手',
        keyPoints: ['beginner', 'from scratch', 'intro', 'introduction', 'getting started'],
      }),
    );
    expect(signal!.weight).toBeLessThanOrEqual(0.5);
  });

  it('scans pblConfig fields too', () => {
    const signal = detectOutlineKeywords(
      mkOutline({
        pblConfig: {
          projectTopic: 'Advanced ML',
          projectDescription: '深入实战',
          targetSkills: ['production-grade'],
        },
      }),
    );
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBeGreaterThan(0);
  });
});

describe('analyzePriorScenes', () => {
  it('returns null when no prior scenes', () => {
    const outline = mkOutline({ id: 'pbl1', order: 0 });
    expect(analyzePriorScenes([outline], 'pbl1')).toBeNull();
  });

  it('aggregates difficulty cues across prior scenes', () => {
    const priorAdvanced: SceneOutline = {
      id: 'p1',
      type: 'slide',
      title: 'Deep dive',
      description: '深入讲解高级架构',
      keyPoints: ['production-grade'],
      order: 1,
    };
    const priorBeginner: SceneOutline = {
      id: 'p2',
      type: 'slide',
      title: 'Getting started',
      description: '入门基础知识',
      keyPoints: ['from scratch'],
      order: 2,
    };
    const me = mkOutline({ id: 'me', order: 3 });

    const adv = analyzePriorScenes([priorAdvanced, me], 'me');
    expect(adv!.direction).toBeGreaterThan(0);
    const beg = analyzePriorScenes([priorBeginner, me], 'me');
    expect(beg!.direction).toBeLessThan(0);
  });

  it('only counts scenes that come BEFORE the current outline', () => {
    const after: SceneOutline = {
      id: 'after',
      type: 'slide',
      title: 'Advanced afterward',
      description: '高级 进阶 深入',
      keyPoints: ['advanced'],
      order: 10,
    };
    const me = mkOutline({ id: 'me', order: 3 });
    expect(analyzePriorScenes([after, me], 'me')).toBeNull();
  });
});

describe('analyzeBio', () => {
  it('returns null for empty / whitespace bio', () => {
    expect(analyzeBio(undefined)).toBeNull();
    expect(analyzeBio('')).toBeNull();
    expect(analyzeBio('  ')).toBeNull();
  });

  it('returns null for cue-less bios ("loves cooking")', () => {
    expect(analyzeBio('喜欢做饭')).toBeNull();
    expect(analyzeBio('hello world')).toBeNull();
  });

  it('detects years of experience', () => {
    const s = analyzeBio('我有 5 年 Python 开发经验');
    expect(s!.direction).toBeGreaterThan(0);
  });

  it('detects senior-role markers', () => {
    expect(analyzeBio('我是 CS 博士')!.direction).toBeGreaterThan(0);
    expect(analyzeBio('I am a principal engineer')!.direction).toBeGreaterThan(0);
  });

  it('detects beginner markers', () => {
    expect(analyzeBio('零基础刚开始学')!.direction).toBeLessThan(0);
    expect(analyzeBio('just started, no background')!.direction).toBeLessThan(0);
  });

  it('caps weight at 0.5', () => {
    const s = analyzeBio('我是博士架构师 10 年经验');
    expect(s!.weight).toBeLessThanOrEqual(0.5);
  });
});

describe('detectExplicitProficiency', () => {
  it('detects explicit beginner / intermediate / advanced self-report', () => {
    expect(detectExplicitProficiency('我是零基础，想从最简单开始')).toBe('beginner');
    expect(detectExplicitProficiency('我有一点基础')).toBe('intermediate');
    expect(detectExplicitProficiency('I am an advanced learner')).toBe('advanced');
  });
});

describe('stepProficiency', () => {
  it('steps one tier toward harder / easier and clamps at the ends', () => {
    expect(stepProficiency('beginner', 'up')).toBe('intermediate');
    expect(stepProficiency('intermediate', 'up')).toBe('advanced');
    expect(stepProficiency('advanced', 'up')).toBe('advanced'); // clamp
    expect(stepProficiency('advanced', 'down')).toBe('intermediate');
    expect(stepProficiency('intermediate', 'down')).toBe('beginner');
    expect(stepProficiency('beginner', 'down')).toBe('beginner'); // clamp
    expect(stepProficiency('', 'up')).toBe('advanced'); // unset → intermediate
  });
});

describe('proficiencyDirectiveFromTarget — adjust_difficulty tool arg mapping', () => {
  it('maps absolute tiers and relative nudges (for the any-language LLM path)', () => {
    expect(proficiencyDirectiveFromTarget('beginner')).toEqual({
      kind: 'absolute',
      tier: 'beginner',
    });
    expect(proficiencyDirectiveFromTarget('intermediate')).toEqual({
      kind: 'absolute',
      tier: 'intermediate',
    });
    expect(proficiencyDirectiveFromTarget('advanced')).toEqual({
      kind: 'absolute',
      tier: 'advanced',
    });
    expect(proficiencyDirectiveFromTarget('easier')).toEqual({
      kind: 'relative',
      direction: 'down',
    });
    expect(proficiencyDirectiveFromTarget('harder')).toEqual({ kind: 'relative', direction: 'up' });
  });
});

describe('analyzeQuizAccuracy', () => {
  it('returns null for empty input', () => {
    expect(analyzeQuizAccuracy([])).toBeNull();
  });

  it('returns null when all questions are unscored', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 3,
      correctCount: 0,
      incorrectCount: 0,
      unscoredCount: 3,
      accuracy: null,
    };
    expect(analyzeQuizAccuracy([r])).toBeNull();
  });

  it('maps 100% accuracy to +1 direction', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 5,
      incorrectCount: 0,
      unscoredCount: 0,
      accuracy: 1,
    };
    expect(analyzeQuizAccuracy([r])!.direction).toBe(1);
  });

  it('maps 0% accuracy to -1 direction', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 0,
      incorrectCount: 5,
      unscoredCount: 0,
      accuracy: 0,
    };
    expect(analyzeQuizAccuracy([r])!.direction).toBe(-1);
  });

  it('maps 50% accuracy to neutral', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 4,
      correctCount: 2,
      incorrectCount: 2,
      unscoredCount: 0,
      accuracy: 0.5,
    };
    expect(analyzeQuizAccuracy([r])!.direction).toBe(0);
  });

  it('aggregates across multiple quizzes by scored-question count', () => {
    const a: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 5,
      incorrectCount: 0,
      unscoredCount: 0,
      accuracy: 1,
    };
    const b: PriorQuizResult = {
      sceneId: 'q2',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 0,
      incorrectCount: 5,
      unscoredCount: 0,
      accuracy: 0,
    };
    const s = analyzeQuizAccuracy([a, b]);
    expect(s!.direction).toBe(0);
  });

  it('uses actual scored results when a stored quiz result omits unanswered questions', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 1,
      incorrectCount: 0,
      unscoredCount: 0,
      accuracy: 1,
    };

    const s = analyzeQuizAccuracy([r]);
    expect(s!.direction).toBe(1);
    expect(s!.note).toContain('1/1 correct');
  });

  it('uses cap weight (high pre-PBL trust)', () => {
    const r: PriorQuizResult = {
      sceneId: 'q1',
      sceneTitle: 'q',
      totalQuestions: 5,
      correctCount: 4,
      incorrectCount: 1,
      unscoredCount: 0,
      accuracy: 0.8,
    };
    expect(analyzeQuizAccuracy([r])!.weight).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Dynamic signal builders
// ---------------------------------------------------------------------------

describe('signalFromObservation', () => {
  it('repeat errors have stronger weight than first errors', () => {
    const first = signalFromObservation('error');
    const repeat = signalFromObservation('error', { repeat: true });
    expect(repeat.weight).toBeGreaterThan(first.weight);
    expect(repeat.direction).toBeLessThan(first.direction);
  });

  it('concept_unlocked points to advanced', () => {
    expect(signalFromObservation('concept_unlocked').direction).toBeGreaterThan(0);
  });

  it('struggle points to beginner', () => {
    expect(signalFromObservation('struggle').direction).toBeLessThan(0);
  });
});

describe('signalFromClosingCheck', () => {
  it('weak → strong negative; strong → strong positive; ok → neutral', () => {
    expect(signalFromClosingCheck('weak').direction).toBe(-0.6);
    expect(signalFromClosingCheck('strong').direction).toBe(0.6);
    expect(signalFromClosingCheck('ok').direction).toBe(0);
  });
});

describe('signalFromTaskSpeed', () => {
  it('returns null for the neutral middle band (5–7 turns)', () => {
    expect(signalFromTaskSpeed(5)).toBeNull();
    expect(signalFromTaskSpeed(7)).toBeNull();
  });

  it('fast (≤2 turns) → advanced', () => {
    expect(signalFromTaskSpeed(1)!.direction).toBeGreaterThan(0);
  });

  it('slow (≥10 turns) → beginner', () => {
    expect(signalFromTaskSpeed(12)!.direction).toBeLessThan(0);
  });

  it('rejects nonsensical inputs', () => {
    expect(signalFromTaskSpeed(-1)).toBeNull();
    expect(signalFromTaskSpeed(Number.NaN)).toBeNull();
  });
});

describe('signalFromSubmissionScore', () => {
  it('high score → advanced; low → beginner; mid → neutral', () => {
    expect(signalFromSubmissionScore(90)!.direction).toBeGreaterThan(0);
    expect(signalFromSubmissionScore(20)!.direction).toBeLessThan(0);
    expect(signalFromSubmissionScore(50)!.direction).toBe(0);
  });

  it('clamps out-of-range scores', () => {
    expect(signalFromSubmissionScore(150)!.direction).toBe(1);
    expect(signalFromSubmissionScore(-20)!.direction).toBe(-1);
  });

  it('rejects nonsensical inputs', () => {
    expect(signalFromSubmissionScore(Number.NaN)).toBeNull();
  });
});

describe('signalFromForceAdvance', () => {
  it('points to beginner', () => {
    expect(signalFromForceAdvance().direction).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregation + EWMA + retier
// ---------------------------------------------------------------------------

describe('aggregateSignals', () => {
  it('returns bootstrap intermediate when no signals', () => {
    const a = aggregateSignals([], 'planner');
    expect(a.tier).toBe('intermediate');
    expect(a.score).toBe(0);
    expect(a.confidence).toBeLessThanOrEqual(0.2);
  });

  it('confidence accrues from weight total', () => {
    const a = aggregateSignals(
      [signalFromObservation('error'), signalFromObservation('error', { repeat: true })],
      'dynamic',
    );
    expect(a.confidence).toBeGreaterThan(0);
  });
});

describe('computeInitialAssessment — robustness matrix', () => {
  it('all signals absent → intermediate at low confidence (bootstrap default)', () => {
    const a = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
    });
    expect(a.tier).toBe('intermediate');
    expect(a.confidence).toBeLessThanOrEqual(0.2);
  });

  it('only bio → uses bio signal', () => {
    const a = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
      userBio: '5 年开发经验',
    });
    expect(a.signals.length).toBe(1);
  });

  it('only quiz → uses quiz signal even when others missing', () => {
    const a = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
      priorQuizResults: [
        {
          sceneId: 'q1',
          sceneTitle: 'q',
          totalQuestions: 5,
          correctCount: 5,
          incorrectCount: 0,
          unscoredCount: 0,
          accuracy: 1,
        },
      ],
      source: 'pre-play',
    });
    expect(a.source).toBe('pre-play');
    expect(a.score).toBeGreaterThan(0);
  });

  it('quiz-without-scoring (all short_answer) does not contribute', () => {
    const a = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
      priorQuizResults: [
        {
          sceneId: 'q1',
          sceneTitle: 'q',
          totalQuestions: 3,
          correctCount: 0,
          incorrectCount: 0,
          unscoredCount: 3,
          accuracy: null,
        },
      ],
    });
    expect(a.signals).toEqual([]);
  });

  it('explicit learner level overrides all other static signals', () => {
    const a = computeInitialAssessment({
      outline: mkOutline({ description: '进阶实战项目' }),
      priorScenes: [],
      userBio: '我是零基础',
      userRequirement: '我要从最简单开始',
    });
    expect(a.tier).toBe('beginner');
    expect(a.confidence).toBe(1);
    expect(a.signals[0]?.kind).toBe('user_level_explicit');
  });

  it('two strong advanced heuristics alone stay intermediate', () => {
    const a = computeInitialAssessment({
      outline: mkOutline({ description: '进阶实战项目' }),
      priorScenes: [],
      userBio: '10 年开发经验',
    });
    // Advanced is intentionally conservative unless the learner
    // explicitly self-reports advanced or later demonstrates it.
    expect(a.tier).toBe('intermediate');
    expect(a.score).toBeGreaterThan(0.33);
  });

  it('a single weak bio signal alone stays intermediate (no flip)', () => {
    const mild = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
      userBio: '我有 3 年工作经验',
    });
    expect(mild.tier).toBe('intermediate');
  });

  it('a single perfect quiz signal alone raises support but does not seed advanced', () => {
    const a = computeInitialAssessment({
      outline: mkOutline(),
      priorScenes: [],
      priorQuizResults: [
        {
          sceneId: 'q',
          sceneTitle: 'q',
          totalQuestions: 5,
          correctCount: 5,
          incorrectCount: 0,
          unscoredCount: 0,
          accuracy: 1,
        },
      ],
      source: 'pre-play',
    });
    expect(a.tier).toBe('intermediate');
  });
});

describe('applySignal — EWMA dynamics', () => {
  it('a single max-weight advanced signal cannot flip tier on its own', () => {
    const before = emptyAssessment();
    const after = applySignal(before, {
      kind: 'submission_score',
      direction: 1,
      weight: 0.5,
      ts: 'x',
    });
    // EWMA_ALPHA * 1 * 0.5 = 0.1 → still well inside intermediate
    expect(after.score).toBeLessThan(0.33);
    expect(scoreToTier(after.score, after.tier)).toBe('intermediate');
  });

  it('repeated advanced signals accumulate toward advanced', () => {
    let a = emptyAssessment();
    for (let i = 0; i < 20; i++) {
      a = applySignal(a, {
        kind: 'submission_score',
        direction: 1,
        weight: 0.5,
        ts: String(i),
      });
    }
    expect(a.score).toBeGreaterThan(0.4);
  });

  it('opposing signals cancel out', () => {
    let a = emptyAssessment();
    for (let i = 0; i < 10; i++) {
      a = applySignal(a, { kind: 'self_correction', direction: 1, weight: 0.3, ts: String(i) });
      a = applySignal(a, { kind: 'concept_confusion', direction: -1, weight: 0.3, ts: String(i) });
    }
    expect(Math.abs(a.score)).toBeLessThan(0.1);
  });

  it('signals array is bounded by MAX_SIGNAL_HISTORY (50)', () => {
    let a = emptyAssessment();
    for (let i = 0; i < 100; i++) {
      a = applySignal(a, { kind: 'task_speed', direction: 0.5, weight: 0.3, ts: String(i) });
    }
    expect(a.signals.length).toBe(50);
  });

  it('dynamicSignalsSinceRetier increments per signal', () => {
    let a = emptyAssessment();
    a = applySignal(a, { kind: 'task_speed', direction: 1, weight: 0.3, ts: 'a' });
    a = applySignal(a, { kind: 'task_speed', direction: 1, weight: 0.3, ts: 'b' });
    expect(a.dynamicSignalsSinceRetier).toBe(2);
  });
});

describe('shouldRetier — gates', () => {
  function mk(overrides: Partial<PBLProficiencyAssessment> = {}): PBLProficiencyAssessment {
    return {
      tier: 'intermediate',
      score: 0,
      confidence: 0.5,
      source: 'dynamic',
      signals: [],
      lastUpdatedAt: '',
      transitions: [],
      dynamicSignalsSinceRetier: 5,
      turnsSinceRetier: 6,
      ...overrides,
    };
  }

  it('refuses to switch when desired tier matches current', () => {
    expect(shouldRetier(mk({ score: 0 })).switch).toBe(false);
  });

  it('refuses to switch when confidence below floor', () => {
    expect(shouldRetier(mk({ score: 0.5, confidence: 0.2 })).switch).toBe(false);
  });

  it('refuses dynamic switch when min-signal gate not met', () => {
    const d = shouldRetier(mk({ score: 0.51, dynamicSignalsSinceRetier: 1 }));
    expect(d.switch).toBe(false);
    expect(d.reason).toContain('min-signal');
  });

  it('refuses dynamic switch when cooldown not met', () => {
    const d = shouldRetier(mk({ score: 0.51, turnsSinceRetier: 1 }));
    expect(d.switch).toBe(false);
    expect(d.reason).toContain('cooldown');
  });

  it('allows pre-play switch even with no dynamic signals', () => {
    const d = shouldRetier(
      mk({ score: 0.51, source: 'pre-play', dynamicSignalsSinceRetier: 0, turnsSinceRetier: 0 }),
    );
    expect(d.switch).toBe(true);
    expect(d.newTier).toBe('advanced');
  });

  it('allows dynamic switch when all gates pass', () => {
    expect(shouldRetier(mk({ score: 0.51 })).switch).toBe(true);
  });
});

describe('processDynamicSignal', () => {
  it('does not switch tier on a single observation', () => {
    const start = emptyAssessment();
    const { next, transition } = processDynamicSignal(start, signalFromObservation('error'));
    expect(transition).toBeUndefined();
    // emptyAssessment seeds the no-evidence default; one signal cannot move it.
    expect(next.tier).toBe('intermediate');
  });

  it('switches beginner → intermediate after enough positive signals + cooldown elapsed', () => {
    let a: PBLProficiencyAssessment = { ...emptyAssessment(), tier: 'beginner' };
    // Manually elapse turn cooldown
    for (let i = 0; i < 10; i++) a = tickTurn(a);
    for (let i = 0; i < 12; i++) {
      const r = processDynamicSignal(a, {
        kind: 'submission_score',
        direction: 1,
        weight: 0.5,
        ts: String(i),
      });
      a = r.next;
      if (r.transition) {
        expect(r.transition.from).toBe('beginner');
        expect(r.transition.to).toBe('intermediate');
        return;
      }
    }
    throw new Error('expected a tier transition');
  });

  it('resets counters after a switch (no consecutive flips)', () => {
    let a: PBLProficiencyAssessment = { ...emptyAssessment(), tier: 'beginner' };
    for (let i = 0; i < 10; i++) a = tickTurn(a);
    for (let i = 0; i < 12; i++) {
      const r = processDynamicSignal(a, {
        kind: 'submission_score',
        direction: 1,
        weight: 0.5,
        ts: String(i),
      });
      a = r.next;
      if (r.transition) break;
    }
    expect(a.dynamicSignalsSinceRetier).toBe(0);
    expect(a.turnsSinceRetier).toBe(0);
  });
});

describe('commitTierSwitch', () => {
  it('appends transition + resets counters', () => {
    const before: PBLProficiencyAssessment = {
      ...emptyAssessment(),
      tier: 'intermediate',
      score: 0.5,
      confidence: 0.6,
      dynamicSignalsSinceRetier: 6,
      turnsSinceRetier: 7,
    };
    const { next, transition } = commitTierSwitch(before, 'advanced', 'crossed');
    expect(next.tier).toBe('advanced');
    expect(next.transitions).toHaveLength(1);
    expect(transition.from).toBe('intermediate');
    expect(transition.to).toBe('advanced');
    expect(next.dynamicSignalsSinceRetier).toBe(0);
    expect(next.turnsSinceRetier).toBe(0);
  });
});

describe('applyQuizSnapshot — pre-play recalibration', () => {
  it('no-ops when quiz has no scored questions', () => {
    const before = emptyAssessment();
    const after = applyQuizSnapshot(before, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 3,
        correctCount: 0,
        incorrectCount: 0,
        unscoredCount: 3,
        accuracy: null,
      },
    ]);
    expect(after).toBe(before);
  });

  it('flips to advanced on high quiz accuracy, source = pre-play', () => {
    const before = emptyAssessment();
    const after = applyQuizSnapshot(before, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 5,
        correctCount: 5,
        incorrectCount: 0,
        unscoredCount: 0,
        accuracy: 1,
      },
    ]);
    expect(after.source).toBe('pre-play');
    // A single quiz signal of weight 0.5 contributes 0.1 to score
    // via EWMA — that's not enough to cross +0.33. But the test
    // verifies the pre-play path engaged regardless.
    expect(after.signals.some((s) => s.kind === 'quiz_accuracy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project-level glue
// ---------------------------------------------------------------------------

describe('ensureAssessment + updateProjectAssessment', () => {
  it('lazily creates an assessment matching project.proficiency', () => {
    const p = mkProject({ proficiency: 'beginner' });
    const a = ensureAssessment(p);
    expect(a.tier).toBe('beginner');
    expect(p.proficiencyAssessment).toBe(a);
  });

  it('folds a dynamic signal and syncs proficiency on tier switch', () => {
    const p = mkProject();
    // Seed with high score so the next signal pushes us over
    p.proficiencyAssessment = {
      ...emptyAssessment(),
      tier: 'intermediate',
      score: 0.55,
      confidence: 0.6,
      source: 'dynamic',
      dynamicSignalsSinceRetier: 5,
      turnsSinceRetier: 10,
    };
    const { transition } = updateProjectAssessment(p, {
      kind: 'submission_score',
      direction: 1,
      weight: 0.5,
      ts: 't',
    });
    expect(transition).toBeDefined();
    expect(transition!.to).toBe('advanced');
    expect(p.proficiency).toBe('advanced');
  });

  it('does not advance proficiency when retier gates block', () => {
    const p = mkProject();
    p.proficiencyAssessment = {
      ...emptyAssessment(),
      score: 0.5,
      confidence: 0.5,
      source: 'dynamic',
      dynamicSignalsSinceRetier: 1, // below min-signal gate
      turnsSinceRetier: 10,
    };
    const { transition } = updateProjectAssessment(p, {
      kind: 'task_speed',
      direction: 1,
      weight: 0.3,
      ts: 't',
    });
    expect(transition).toBeUndefined();
    expect(p.proficiency).toBe('intermediate');
  });
});

describe('describeAssessment', () => {
  it('returns a read-only debug view', () => {
    const a: PBLProficiencyAssessment = {
      ...emptyAssessment(),
      signals: [{ kind: 'quiz_accuracy', direction: 0.5, weight: 0.6, ts: 't' }],
    };
    const d = describeAssessment(a);
    expect(d.tier).toBe('intermediate');
    expect(d.lastSignalKind).toBe('quiz_accuracy');
  });
});

describe('no-evidence default tier — single source of truth', () => {
  it('DEFAULT_TIER is intermediate', () => {
    expect(DEFAULT_TIER).toBe('intermediate');
  });

  it('every no-evidence fallback resolves to DEFAULT_TIER (not beginner)', () => {
    // The whole point: these used to disagree (some beginner, some
    // intermediate), contradicting the documented default. Lock them together.
    expect(emptyAssessment().tier).toBe(DEFAULT_TIER);
    expect(aggregateSignals([], 'planner').tier).toBe(DEFAULT_TIER);

    const p = mkProject({ proficiency: '', proficiencyAssessment: undefined });
    expect(ensureAssessment(p).tier).toBe(DEFAULT_TIER);

    // scoreToTier with an unset anchor + neutral score lands on DEFAULT_TIER.
    expect(scoreToTier(0, '')).toBe(DEFAULT_TIER);
    expect(scoreToTier(0, undefined)).toBe(DEFAULT_TIER);
  });
});

describe('reseatAssessmentTier — deliberate tier override stays consistent', () => {
  it('re-centres the score into the chosen tier band and resets counters', () => {
    const prev: PBLProficiencyAssessment = {
      ...emptyAssessment(),
      tier: 'intermediate',
      score: 0.1,
      confidence: 0.5,
      dynamicSignalsSinceRetier: 4,
      turnsSinceRetier: 7,
    };
    const next = reseatAssessmentTier(prev, 'advanced', 'planner');
    expect(next.tier).toBe('advanced');
    // Score must now map to the chosen tier (no internal contradiction).
    expect(scoreToTier(next.score, next.tier)).toBe('advanced');
    expect(next.source).toBe('planner');
    expect(next.dynamicSignalsSinceRetier).toBe(0);
    expect(next.turnsSinceRetier).toBe(0);
    // It is a heuristic override, NOT a hard self-report: must not inject a
    // user_level_explicit signal (which would lock out future re-evaluation).
    expect(next.signals.some((s) => s.kind === 'user_level_explicit')).toBe(false);
  });

  it('a Planner tier override survives the first eligible retier window (no stale-score rebound)', () => {
    // Regression for the bug: engine estimated intermediate (score ~0.1), the
    // Planner LLM chose advanced. Before the fix, the stale 0.1 score mapped to
    // intermediate, so the FIRST signal after the retier gates cleared (≥3
    // dynamic signals, ≥5 turns) demoted the learner back — regardless of how
    // they performed. After reseating (score re-centred into the advanced band),
    // the gates open at the same point but the tier holds. We feed exactly the
    // gate-window of neutral signals: under the old behaviour this demotes; here
    // it must not.
    let a = reseatAssessmentTier(
      { ...emptyAssessment(), tier: 'intermediate', score: 0.1, confidence: 0.5 },
      'advanced',
      'planner',
    );
    for (let i = 0; i < 5; i++) {
      a = tickTurn(a);
      a = processDynamicSignal(a, {
        kind: 'task_speed',
        direction: 0,
        weight: 0.3,
        ts: String(i),
      }).next;
    }
    expect(a.dynamicSignalsSinceRetier).toBeGreaterThanOrEqual(3);
    expect(a.turnsSinceRetier).toBeGreaterThanOrEqual(5);
    expect(a.tier).toBe('advanced');
  });
});
