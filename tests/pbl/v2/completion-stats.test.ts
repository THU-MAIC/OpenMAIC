import { describe, expect, it } from 'vitest';

import {
  computeCompletionStats,
  humanizeConceptSignature,
  normalizeActGoals,
  scenarioActGoalsScaffold,
} from '@/lib/pbl/v2/operations/completion-stats';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function baseProject(): PBLProjectV2 {
  return {
    uiPhase: 'completed',
    title: 'Test Project',
    description: 'A test project',
    language: 'zh-CN',
    proficiency: 'beginner',
    tags: [],
    status: 'completed',
    roles: [{ id: 'r1', type: 'instructor', name: 'Teacher' }],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Compute stats and assert the STANDARD variant, returning it narrowed so the
 *  knowledge-project tests below can read standard-only fields directly. */
function standardStats(project: PBLProjectV2) {
  const stats = computeCompletionStats(project);
  if (stats.kind !== 'standard') throw new Error('expected a standard (non-scenario) project');
  return stats;
}

describe('computeCompletionStats', () => {
  it('returns a standard variant with zeros/empties for an empty project', () => {
    const stats = computeCompletionStats(baseProject());
    expect(stats.kind).toBe('standard');
    if (stats.kind !== 'standard') throw new Error('expected standard');
    expect(stats.conceptsUnlocked).toEqual([]);
    expect(stats.independenceRate).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.totalSubmissions).toBe(0);
    expect(stats.toughestMilestone).toBeNull();
    expect(stats.stageDetails).toEqual([]);
    expect(stats.highlights).toHaveLength(1);
    expect(stats.highlights[0].kind).toBe('completion');
  });

  it('FIELD ISOLATION: a normal project is the standard variant — no scenario fields exist on it', () => {
    const stats = computeCompletionStats(baseProject());
    expect(stats.kind).toBe('standard');
    // The discriminated union makes scenario-only keys absent at runtime.
    expect('acts' in stats).toBe(false);
    expect('goalCoverage' in stats).toBe(false);
    expect('characterNames' in stats).toBe(false);
  });

  it('FIELD ISOLATION: a scenario project is the scenario variant — no knowledge fields exist on it', () => {
    const p = baseProject();
    p.scenario = {
      setting: '德州扑克牌桌',
      sceneVisual: { caption: '牌桌现金局' },
      characters: [{ id: 'c1', name: '老周', persona: '牌手' }],
    };
    p.milestones = [
      {
        id: 'ms-rp',
        title: '第一手牌',
        status: 'completed',
        order: 0,
        scenarioStage: 'roleplay',
        microtasks: [
          {
            id: 'b1',
            title: '翻前',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            successWhen: '做出翻前决定',
            engagement: { learnerTurnCount: 1, durationSeconds: 30 },
          },
        ],
        documents: [],
      },
    ];
    const stats = computeCompletionStats(p);
    expect(stats.kind).toBe('scenario');
    if (stats.kind !== 'scenario') throw new Error('expected scenario');
    expect(stats.acts).toEqual({ completed: 1, total: 1 });
    expect(stats.totalTurns).toBe(1);
    expect(stats.sceneCaption).toBe('牌桌现金局');
    expect(stats.characterNames).toEqual(['老周']);
    // No knowledge-project metrics leak onto the scenario variant.
    expect('conceptsUnlocked' in stats).toBe(false);
    expect('stageDetails' in stats).toBe(false);
    expect('highlights' in stats).toBe(false);
    expect('totalSubmissions' in stats).toBe(false);
    // The dead choice-decision scoreboard is gone entirely.
    expect('decisions' in stats).toBe(false);
    // No final eval with actGoals → no goalCoverage (graceful omit).
    expect(stats.goalCoverage).toBeUndefined();
  });

  it('builds scenario goalCoverage from the final eval actGoals', () => {
    const p = baseProject();
    p.scenario = {
      setting: '客户投诉处理',
      characters: [{ id: 'c1', name: '王女士', persona: '客户' }],
    };
    p.milestones = [
      {
        id: 'ms-rp',
        title: '安抚客户',
        status: 'completed',
        order: 0,
        scenarioStage: 'roleplay',
        microtasks: [
          {
            id: 'b1',
            title: '倾听',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            successWhen: '对客户的情绪做出共情回应',
            skillFocus: '积极倾听',
            engagement: { learnerTurnCount: 2, durationSeconds: 60 },
          },
          {
            id: 'b2',
            title: '澄清',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            successWhen: '问出问题的根本原因',
            engagement: { learnerTurnCount: 1, durationSeconds: 30 },
          },
        ],
        documents: [],
      },
    ];
    p.evaluations = [
      {
        id: 'ev-final',
        kind: 'final',
        feedback: 'nice',
        strengths: [],
        improvements: [],
        actGoals: [
          {
            milestoneId: 'ms-rp',
            actTitle: '安抚客户',
            goals: [
              { goal: '对客户的情绪做出共情回应', skillFocus: '积极倾听', status: 'achieved' },
              { goal: '问出问题的根本原因', status: 'missed' },
            ],
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const stats = computeCompletionStats(p);
    expect(stats.kind).toBe('scenario');
    if (stats.kind !== 'scenario') throw new Error('expected scenario');
    expect(stats.acts).toEqual({ completed: 1, total: 1 });
    expect(stats.goalCoverage!.achieved).toBe(1);
    expect(stats.goalCoverage!.partial).toBe(0);
    expect(stats.goalCoverage!.missed).toBe(1);
    expect(stats.goalCoverage!.total).toBe(2);
    expect(stats.goalCoverage!.acts).toHaveLength(1);
    // When the scored coverage is present, the read-only scaffold fallback
    // must NOT also be set (mutually exclusive).
    expect(stats.goalScaffold).toBeUndefined();
  });

  it('FALLBACK: older scenario project without actGoals exposes a read-only goalScaffold', () => {
    const p = baseProject();
    p.scenario = {
      setting: '客户投诉处理',
      characters: [{ id: 'c1', name: '王女士', persona: '客户' }],
    };
    p.milestones = [
      {
        id: 'ms-rp',
        title: '安抚客户',
        status: 'completed',
        order: 0,
        scenarioStage: 'roleplay',
        microtasks: [
          {
            id: 'b1',
            title: '倾听',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            successWhen: '对客户的情绪做出共情回应',
            skillFocus: '积极倾听',
            engagement: { learnerTurnCount: 2, durationSeconds: 60 },
          },
        ],
        documents: [],
      },
    ];
    // No final eval at all → no actGoals (this is exactly the pre-actGoals
    // historical project shape).
    const stats = computeCompletionStats(p);
    expect(stats.kind).toBe('scenario');
    if (stats.kind !== 'scenario') throw new Error('expected scenario');
    expect(stats.goalCoverage).toBeUndefined();
    // The structured review survives as an unscored scaffold.
    expect(stats.goalScaffold).toEqual([
      {
        milestoneId: 'ms-rp',
        actTitle: '安抚客户',
        goals: [{ goal: '对客户的情绪做出共情回应', skillFocus: '积极倾听' }],
      },
    ]);
  });

  it('collects unique concepts across milestones', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['loop', 'list'] },
          },
        ],
        documents: [],
      },
      {
        id: 'ms2',
        title: 'S2',
        status: 'completed',
        order: 1,
        microtasks: [
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['loop', 'dict'] },
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    expect(stats.conceptsUnlocked).toEqual(['loop', 'list', 'dict']);
  });

  it('computes independence rate from concept_unlocked vs closing_check', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['a'] },
          },
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            engagement: { conceptsUnlocked: ['b'] },
          },
          {
            id: 'mt3',
            title: 't3',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 2,
            engagement: { closingQuestion: 'why?' },
          },
          {
            id: 'mt4',
            title: 't4',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 3,
            engagement: {},
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    // 2 concept_unlocked, 1 closing_check → 2/3 = 0.667
    expect(stats.independenceRate).toBeCloseTo(2 / 3, 2);
  });

  it('counts total errors across all microtasks', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { errorCount: 3 },
          },
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            engagement: { errorCount: 1 },
          },
        ],
        documents: [],
      },
    ];
    expect(standardStats(p).totalErrors).toBe(4);
  });

  it('finds the toughest milestone with ≥3 errors', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'Easy',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { errorCount: 1 },
          },
        ],
        documents: [],
      },
      {
        id: 'ms2',
        title: 'Hard',
        status: 'completed',
        order: 1,
        microtasks: [
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { errorCount: 4 },
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    expect(stats.toughestMilestone).toEqual({ title: 'Hard', errors: 4 });
  });

  it('does not flag a milestone with fewer than 3 errors as toughest', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'Light',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { errorCount: 2 },
          },
        ],
        documents: [],
      },
    ];
    expect(standardStats(p).toughestMilestone).toBeNull();
  });

  it('produces independence highlight when rate ≥ 0.6 with ≥ 2 evidence', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['a'] },
          },
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            engagement: { conceptsUnlocked: ['b'] },
          },
          {
            id: 'mt3',
            title: 't3',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 2,
            engagement: { conceptsUnlocked: ['c'] },
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    expect(stats.highlights.some((h) => h.kind === 'independence')).toBe(true);
  });

  it('produces resilience highlight when a tough milestone exists', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'Grind',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { errorCount: 5 },
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    expect(stats.highlights.some((h) => h.kind === 'resilience')).toBe(true);
  });

  it('falls back to completion highlight when nothing else qualifies', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: {},
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    expect(stats.highlights).toHaveLength(1);
    expect(stats.highlights[0].kind).toBe('completion');
  });

  it('builds stage details with core stage and synthesis quality', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'Core Stage',
        status: 'completed',
        order: 0,
        synthesisCheck: { coreConcept: 'why loops matter' },
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['loop'] },
          },
        ],
        documents: [],
      },
    ];
    p.engagementEvents = [
      {
        id: 'e1',
        kind: 'stage_synthesis_check',
        milestoneId: 'ms1',
        microtaskId: 'mt1',
        ts: '2026-01-01T00:00:00Z',
        payload: { quality: 'strong' },
      },
    ];
    p.submissions = [
      {
        id: 's1',
        microtaskId: 'mt1',
        kind: 'text',
        content: 'code',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const stats = standardStats(p);
    expect(stats.stageDetails).toHaveLength(1);
    expect(stats.stageDetails[0].isCoreStage).toBe(true);
    expect(stats.stageDetails[0].coreConcept).toBe('why loops matter');
    expect(stats.stageDetails[0].synthesisQuality).toBe('strong');
    expect(stats.stageDetails[0].conceptsInStage).toEqual(['loop']);
    expect(stats.stageDetails[0].submissionsInStage).toBe(1);
  });

  it('does not double-count a stage_synthesis_check absorbed into closingQuestion', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'Core',
        status: 'completed',
        order: 0,
        synthesisCheck: { coreConcept: 'recursion' },
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: { conceptsUnlocked: ['a'] },
          },
          {
            id: 'mt2',
            title: 't2',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            engagement: { conceptsUnlocked: ['b'] },
          },
          {
            // Last microtask: microtaskEngagement() already absorbed the
            // stage_synthesis_check into closingQuestion → it is the cache's
            // single record of that check.
            id: 'mt3',
            title: 't3',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 2,
            engagement: { closingQuestion: 'why does recursion work?' },
          },
        ],
        documents: [],
      },
    ];
    // The SAME synthesis check also lives in the append-only ledger; it
    // must not be counted a second time on top of the cache.
    p.engagementEvents = [
      {
        id: 'e1',
        kind: 'stage_synthesis_check',
        milestoneId: 'ms1',
        microtaskId: 'mt3',
        ts: '2026-01-01T00:00:00Z',
        payload: { quality: 'strong' },
      },
    ];
    const stats = standardStats(p);
    // 2 concept_unlocked + exactly 1 check (the absorbed synthesis) → 2/3,
    // NOT 2/4 (which is what the old ledger double-count produced).
    expect(stats.independenceRate).toBeCloseTo(2 / 3, 2);
    // Independence highlight should still surface (0.667 ≥ 0.6, evidence ≥ 2).
    expect(stats.highlights.some((h) => h.kind === 'independence')).toBe(true);
  });

  it('shows human-readable, localised concept labels in the stage review', () => {
    const p = baseProject();
    p.milestones = [
      {
        id: 'ms1',
        title: 'S1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt1',
            title: 't1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            engagement: {
              // signatures are machine tags; labels are what the learner sees.
              conceptsUnlocked: ['set_dedup', 'print_empty_set_verified'],
              conceptUnlockLabels: { set_dedup: '为什么 set 能自动去重' },
            },
          },
        ],
        documents: [],
      },
    ];
    const stats = standardStats(p);
    // Labelled signature → localised label; unlabelled signature → humanised
    // fallback (spaced words, never the raw snake_case token).
    expect(stats.stageDetails[0].conceptsInStage).toEqual([
      '为什么 set 能自动去重',
      'print empty set verified',
    ]);
  });
});

describe('humanizeConceptSignature', () => {
  it('turns a snake/kebab machine tag into spaced words', () => {
    expect(humanizeConceptSignature('print_empty_set_verified')).toBe('print empty set verified');
    expect(humanizeConceptSignature('if-else-basic')).toBe('if else basic');
  });

  it('collapses repeats and trims', () => {
    expect(humanizeConceptSignature('__case__selection__')).toBe('case selection');
  });
});

describe('scenarioActGoalsScaffold + normalizeActGoals', () => {
  function rpProjectWithGoals(): PBLProjectV2 {
    const p = baseProject();
    p.scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: '客户', persona: 'p' }],
    };
    p.milestones = [
      {
        id: 'ms-rp',
        title: '安抚客户',
        status: 'completed',
        order: 0,
        scenarioStage: 'roleplay',
        documents: [],
        microtasks: [
          {
            id: 'b1',
            title: '倾听',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
            successWhen: '共情回应',
            skillFocus: '积极倾听',
          },
          {
            id: 'b2',
            title: '澄清',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 1,
            successWhen: '问出根因',
          },
        ],
      },
    ];
    return p;
  }

  it('scaffold pulls goal text + skillFocus straight from project data', () => {
    const scaffold = scenarioActGoalsScaffold(rpProjectWithGoals());
    expect(scaffold).toEqual([
      {
        milestoneId: 'ms-rp',
        actTitle: '安抚客户',
        goals: [{ goal: '共情回应', skillFocus: '积极倾听' }, { goal: '问出根因' }],
      },
    ]);
  });

  it('overlays the LLM status/note onto the authored scaffold (text from data, never the model)', () => {
    const p = rpProjectWithGoals();
    const raw = [
      {
        milestoneId: 'ms-rp',
        // The model tries to rewrite the goal text — it must be IGNORED.
        goals: [
          { goalIndex: 0, status: 'achieved', note: '开场就共情', goal: 'HACKED' },
          { goalIndex: 1, status: 'partial' },
        ],
      },
    ];
    const result = normalizeActGoals(raw, p)!;
    expect(result).toHaveLength(1);
    expect(result[0].goals[0]).toEqual({
      goal: '共情回应',
      skillFocus: '积极倾听',
      status: 'achieved',
      note: '开场就共情',
    });
    expect(result[0].goals[1]).toEqual({ goal: '问出根因', status: 'partial' });
  });

  it('aligns verdicts by goalIndex even when the model REORDERS goals within an act', () => {
    const p = rpProjectWithGoals(); // goal[0]=共情回应, goal[1]=问出根因
    // Model emitted the two goals in REVERSE array order, but each carries its
    // true goalIndex. Position would mis-pin (共情=missed, 根因=achieved); index
    // alignment must restore the correct mapping.
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 1, status: 'missed', note: '没问到根因' },
          { goalIndex: 0, status: 'achieved', note: '共情到位' },
        ],
      },
    ];
    const result = normalizeActGoals(raw, p)!;
    expect(result[0].goals[0]).toEqual({
      goal: '共情回应',
      skillFocus: '积极倾听',
      status: 'achieved',
      note: '共情到位',
    });
    expect(result[0].goals[1]).toEqual({ goal: '问出根因', status: 'missed', note: '没问到根因' });
  });

  it('STRICT: aborts to undefined when a goal is missing its goalIndex', () => {
    const p = rpProjectWithGoals();
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [{ goalIndex: 0, status: 'achieved' }, { status: 'partial' }],
      },
    ];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('STRICT: aborts to undefined on a duplicate goalIndex (and a gap it implies)', () => {
    const p = rpProjectWithGoals();
    // Two verdicts both claim index 0 → index 1 never covered → abort.
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 0, status: 'achieved' },
          { goalIndex: 0, status: 'partial' },
        ],
      },
    ];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('STRICT: aborts to undefined on an out-of-range goalIndex', () => {
    const p = rpProjectWithGoals(); // valid indices are 0,1
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 0, status: 'achieved' },
          { goalIndex: 5, status: 'partial' },
        ],
      },
    ];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('STRICT: aborts to undefined when any goal carries an invalid/unjudged status', () => {
    const p = rpProjectWithGoals();
    // goal[0] valid but goal[1] has a junk status → the whole overlay is
    // untrustworthy (likely a truncated/misaligned model output), so we must
    // NOT silently back-fill goal[1] as `missed`. Fall back to undefined.
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 0, status: 'achieved' },
          { goalIndex: 1, status: 'nonsense' },
        ],
      },
    ];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('STRICT: aborts to undefined when an act returns the wrong goal count (truncated tail)', () => {
    const p = rpProjectWithGoals(); // scaffold has 2 goals for ms-rp
    // Model truncated and returned only the first goal. Back-filling goal[1]
    // would tell the learner they failed a goal the model never judged → abort.
    const raw = [{ milestoneId: 'ms-rp', goals: [{ goalIndex: 0, status: 'achieved' }] }];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('STRICT: aborts to undefined when an authored act is missing from the model output', () => {
    const p = rpProjectWithGoals();
    p.milestones.push({
      id: 'ms-rp2',
      title: '第二幕',
      status: 'completed',
      order: 1,
      scenarioStage: 'roleplay',
      documents: [],
      microtasks: [
        {
          id: 'b3',
          title: 'x',
          status: 'completed',
          assignee: 'user',
          hints: [],
          order: 0,
          successWhen: '收尾',
        },
      ],
    });
    // Model returned a verdict for ms-rp but dropped ms-rp2 entirely → abort,
    // do not mark the whole second act as missed.
    const raw = [
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 0, status: 'achieved' },
          { goalIndex: 1, status: 'partial' },
        ],
      },
    ];
    expect(normalizeActGoals(raw, p)).toBeUndefined();
  });

  it('tolerates act-level reordering (matches by milestoneId, not array position)', () => {
    const p = rpProjectWithGoals();
    p.milestones.push({
      id: 'ms-rp2',
      title: '第二幕',
      status: 'completed',
      order: 1,
      scenarioStage: 'roleplay',
      documents: [],
      microtasks: [
        {
          id: 'b3',
          title: 'x',
          status: 'completed',
          assignee: 'user',
          hints: [],
          order: 0,
          successWhen: '收尾',
        },
      ],
    });
    // Model returned the two acts in REVERSE order — milestoneId lookup must
    // still align each verdict to the right act.
    const raw = [
      { milestoneId: 'ms-rp2', goals: [{ goalIndex: 0, status: 'missed' }] },
      {
        milestoneId: 'ms-rp',
        goals: [
          { goalIndex: 0, status: 'achieved' },
          { goalIndex: 1, status: 'partial' },
        ],
      },
    ];
    const result = normalizeActGoals(raw, p)!;
    expect(result.map((a) => a.milestoneId)).toEqual(['ms-rp', 'ms-rp2']);
    expect(result[0].goals.map((g) => g.status)).toEqual(['achieved', 'partial']);
    expect(result[1].goals.map((g) => g.status)).toEqual(['missed']);
  });

  it('returns undefined when the model emitted no usable verdict at all (graceful fallback)', () => {
    const p = rpProjectWithGoals();
    expect(normalizeActGoals(undefined, p)).toBeUndefined();
    expect(normalizeActGoals([], p)).toBeUndefined();
    expect(normalizeActGoals('garbage', p)).toBeUndefined();
  });

  it('returns undefined when the project authored no roleplay goals', () => {
    expect(
      normalizeActGoals(
        [{ milestoneId: 'x', goals: [{ goalIndex: 0, status: 'achieved' }] }],
        baseProject(),
      ),
    ).toBeUndefined();
  });
});
