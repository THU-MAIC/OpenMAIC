import { describe, expect, it } from 'vitest';
import {
  CRITIQUE_MIN_MS,
  CRITIQUE_PASS_SCORE,
  MAX_DEFECTS,
  MAX_REVISION_ROUNDS,
  REVISE_MIN_MS,
  applyRevisionPatch,
  auditOutline,
  critiquePasses,
  defectPages,
  extractJsonObject,
  formatCritiqueForRevision,
  hasTimeFor,
  isSafeRevision,
  mergeAuditIntoCritique,
  parseCritique,
  parseRevisionPatch,
  planLongFormCourse,
  shouldRevise,
} from '@/lib/generation/long-form';
import type { SceneOutline } from '@/lib/types/generation';

function scene(id: string, type: SceneOutline['type'] = 'slide'): SceneOutline {
  return {
    id,
    type,
    title: id,
    description: '',
    keyPoints: ['a'],
    order: Number(id.replace(/\D/g, '')) || 1,
  };
}

const ALL_FOURS = {
  derivation: 4,
  systems: 4,
  foundation: 4,
  agency: 4,
  structure: 4,
};

function critiqueJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'revise',
    scores: ALL_FOURS,
    defects: [],
    ...overrides,
  });
}

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('ignores prose and code fences around the object', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":{"b":[1,2]}}\n```\nDone.')).toEqual({
      a: { b: [1, 2] },
    });
  });

  it('is not fooled by braces inside strings', () => {
    expect(extractJsonObject('{"note":"a } b","n":2}')).toEqual({ note: 'a } b', n: 2 });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"broken": ')).toBeNull();
  });
});

describe('parseCritique', () => {
  it('reads a complete critique', () => {
    const parsed = parseCritique(
      critiqueJson({
        verdict: 'pass',
        scores: { ...ALL_FOURS, derivation: 5 },
        defects: [
          { pageIndex: 7, dimension: 'derivation', problem: 'asserts it', fix: 'derive it' },
        ],
      }),
    )!;
    expect(parsed.verdict).toBe('pass');
    expect(parsed.scores.derivation).toBe(5);
    expect(parsed.defects[0]).toEqual({
      pageIndex: 7,
      dimension: 'derivation',
      problem: 'asserts it',
      fix: 'derive it',
    });
  });

  it('accepts a course-level defect with no page', () => {
    const parsed = parseCritique(
      critiqueJson({
        defects: [{ pageIndex: null, dimension: 'systems', problem: 'no map', fix: 'draw it' }],
      }),
    )!;
    expect(parsed.defects[0].pageIndex).toBeNull();
  });

  it('returns null when the critic gave no scores', () => {
    expect(parseCritique('{"verdict":"revise","defects":[]}')).toBeNull();
    expect(parseCritique('The outline is fine.')).toBeNull();
  });

  it('tolerates one missing dimension but not two', () => {
    const fourOfFive = parseCritique(
      critiqueJson({ scores: { derivation: 4, systems: 4, foundation: 4, agency: 4 } }),
    );
    expect(fourOfFive).not.toBeNull();
    expect(fourOfFive!.scores.structure).toBe(3);

    const threeOfFive = parseCritique(
      critiqueJson({ scores: { derivation: 4, systems: 4, foundation: 4 } }),
    );
    expect(threeOfFive).toBeNull();
  });

  it('clamps out-of-range scores into 1-5', () => {
    const parsed = parseCritique(
      critiqueJson({ scores: { ...ALL_FOURS, derivation: 9, systems: -2 } }),
    )!;
    expect(parsed.scores.derivation).toBe(5);
    expect(parsed.scores.systems).toBe(1);
  });

  it('drops defects it cannot act on and caps the list', () => {
    const defects = [
      ...Array.from({ length: 20 }, (_, index) => ({
        pageIndex: index + 1,
        dimension: 'derivation',
        problem: `p${index}`,
        fix: 'f',
      })),
      { pageIndex: 3, dimension: 'nonsense', problem: 'unknown dimension', fix: 'x' },
      { pageIndex: 3, dimension: 'agency', problem: '', fix: 'no problem stated' },
      'not an object',
    ];
    const parsed = parseCritique(critiqueJson({ defects }))!;
    expect(parsed.defects).toHaveLength(MAX_DEFECTS);
    expect(parsed.defects.every((defect) => defect.dimension === 'derivation')).toBe(true);
  });

  it('treats anything but an explicit pass as revise', () => {
    expect(parseCritique(critiqueJson({ verdict: 'maybe' }))!.verdict).toBe('revise');
  });
});

describe('critiquePasses', () => {
  it('needs a pass verdict and every dimension at the bar', () => {
    const strong = parseCritique(critiqueJson({ verdict: 'pass' }))!;
    expect(critiquePasses(strong)).toBe(true);

    const weak = parseCritique(
      critiqueJson({ verdict: 'pass', scores: { ...ALL_FOURS, agency: 3 } }),
    )!;
    expect(critiquePasses(weak)).toBe(false);
    expect(CRITIQUE_PASS_SCORE).toBe(4);
  });

  it('is not a pass while the verdict still says revise', () => {
    // Arithmetic findings flip the verdict without touching the scores. A critic
    // that liked the draft therefore scores it 4/5 everywhere and still says
    // revise; reading the scores alone shipped it with the certain defects intact.
    const scored = parseCritique(critiqueJson({ scores: ALL_FOURS }))!;
    expect(scored.verdict).toBe('revise');
    expect(critiquePasses(scored)).toBe(false);
  });

  it('is not a pass while a defect is still listed', () => {
    const withDefect = parseCritique(
      critiqueJson({
        verdict: 'pass',
        defects: [{ pageIndex: 2, dimension: 'agency', problem: 'no decision', fix: 'add one' }],
      }),
    )!;
    expect(critiquePasses(withDefect)).toBe(false);
  });
});

describe('shouldRevise', () => {
  const withDefects = parseCritique(
    critiqueJson({
      defects: [{ pageIndex: 2, dimension: 'agency', problem: 'no decision', fix: 'add one' }],
    }),
  )!;

  it('revises a failing outline that named something to fix', () => {
    expect(shouldRevise(withDefects, 0)).toBe(true);
  });

  it('stops when the critic says pass', () => {
    const passed = parseCritique(critiqueJson({ verdict: 'pass' }))!;
    expect(shouldRevise(passed, 0)).toBe(false);
  });

  it('stops when there is nothing to fix, however low the scores', () => {
    // A rewriter with no instruction rewrites the course.
    const vague = parseCritique(critiqueJson({ scores: { ...ALL_FOURS, derivation: 1 } }))!;
    expect(shouldRevise(vague, 0)).toBe(false);
  });

  it('stops when the rounds are spent', () => {
    expect(shouldRevise(withDefects, MAX_REVISION_ROUNDS)).toBe(false);
  });
});

describe('formatCritiqueForRevision', () => {
  it('gives the rewriter the scores and one line per defect', () => {
    const critique = parseCritique(
      critiqueJson({
        defects: [
          { pageIndex: 7, dimension: 'derivation', problem: 'asserts it', fix: 'derive it' },
          { pageIndex: null, dimension: 'systems', problem: 'no map', fix: '' },
        ],
      }),
    )!;
    const text = formatCritiqueForRevision(critique);

    expect(text).toContain('derivation 4/5');
    expect(text).toContain('1. [derivation] page 7 — asserts it Fix: derive it');
    expect(text).toContain('2. [systems] course level — no map');
  });
});

describe('defectPages', () => {
  it('dedupes, sorts and drops course-level defects', () => {
    const critique = parseCritique(
      critiqueJson({
        defects: [
          { pageIndex: 9, dimension: 'derivation', problem: 'a', fix: 'b' },
          { pageIndex: null, dimension: 'systems', problem: 'c', fix: 'd' },
          { pageIndex: 4, dimension: 'agency', problem: 'e', fix: 'f' },
          { pageIndex: 9, dimension: 'foundation', problem: 'g', fix: 'h' },
        ],
      }),
    )!;
    expect(defectPages(critique)).toEqual([4, 9]);
  });
});

describe('hasTimeFor', () => {
  const now = 1_000_000;

  it('has no limit when the caller gave no deadline', () => {
    expect(hasTimeFor(undefined, 10 ** 9, now)).toBe(true);
  });

  it('declines a call that would run past the deadline', () => {
    // The step's deadline aborts the whole outline, draft included, so a round
    // that cannot finish must not start.
    expect(hasTimeFor(now + 30_000, CRITIQUE_MIN_MS, now)).toBe(false);
    expect(hasTimeFor(now + 60_000, CRITIQUE_MIN_MS, now)).toBe(true);
    expect(hasTimeFor(now + 60_000, REVISE_MIN_MS, now)).toBe(false);
    expect(hasTimeFor(now + 120_000, REVISE_MIN_MS, now)).toBe(true);
  });
});

describe('mergeAuditIntoCritique', () => {
  const plan = planLongFormCourse({ minutes: 60, language: 'zh' });

  function scenePage(index: number): SceneOutline {
    return {
      id: `scene_${index}`,
      type: 'slide',
      title: `P${index}`,
      description: '',
      keyPoints: ['a'],
      teachingObjective: 'predict',
      estimatedDuration: 120,
      order: index,
    };
  }

  const passing = parseCritique(critiqueJson({ verdict: 'pass' }))!;

  it('leaves a clean audit alone', () => {
    // A clean outline: every page at its slot's duration, and a quiz wherever
    // the plan puts a retrieval beat.
    const clean = plan.scenes.map((slot, index) => ({
      ...scenePage(index + 1),
      type: slot.role === 'check' ? ('quiz' as const) : ('slide' as const),
      estimatedDuration: slot.durationSeconds,
    }));
    const cleanAudit = auditOutline(plan, clean);
    expect(cleanAudit.defects).toEqual([]);
    expect(mergeAuditIntoCritique(passing, cleanAudit)).toBe(passing);
  });

  it('forces a repair when arithmetic found something the critic missed', () => {
    // Twelve pages against a twenty-nine page budget: the critic may or may not
    // notice, the count does.
    const short = Array.from({ length: 12 }, (_, index) => scenePage(index + 1));
    const audit = auditOutline(plan, short);
    const merged = mergeAuditIntoCritique(passing, audit);

    expect(merged.verdict).toBe('revise');
    expect(merged.defects.length).toBeGreaterThan(0);
    expect(merged.defects[0].dimension).toBe('structure');
    expect(merged.defects[0].problem).toContain('planned');
  });

  it('gives each arithmetic defect an instruction the rewriter can execute', () => {
    const short = Array.from({ length: 12 }, (_, index) => scenePage(index + 1));
    const merged = mergeAuditIntoCritique(passing, auditOutline(plan, short));
    expect(merged.defects.every((defect) => defect.fix.length > 0)).toBe(true);
  });

  it("keeps the critic's own defects behind the certain ones", () => {
    const critic = parseCritique(
      critiqueJson({
        defects: [
          { pageIndex: 5, dimension: 'systems', problem: 'floats free', fix: 'name its node' },
        ],
      }),
    )!;
    const short = Array.from({ length: 12 }, (_, index) => scenePage(index + 1));
    const merged = mergeAuditIntoCritique(critic, auditOutline(plan, short));

    expect(merged.defects.at(-1)?.problem).toBe('floats free');
  });

  it('never exceeds the defect cap', () => {
    const short = Array.from({ length: 3 }, (_, index) => scenePage(index + 1));
    const critic = parseCritique(
      critiqueJson({
        defects: Array.from({ length: 20 }, (_, index) => ({
          pageIndex: index + 1,
          dimension: 'derivation',
          problem: `p${index}`,
          fix: 'f',
        })),
      }),
    )!;
    const merged = mergeAuditIntoCritique(critic, auditOutline(plan, short));
    expect(merged.defects.length).toBeLessThanOrEqual(MAX_DEFECTS);
  });
});

describe('parseRevisionPatch', () => {
  it('reads edits, inserts and removals', () => {
    const patch = parseRevisionPatch(
      JSON.stringify({
        edits: [{ pageIndex: 7, changes: { keyPoints: ['a', 'b'] } }],
        inserts: [
          {
            afterPage: 4,
            scene: {
              type: 'slide',
              title: '前置知识',
              description: '补一个前置',
              keyPoints: ['x'],
              estimatedDuration: 140,
            },
          },
        ],
        removals: [9],
      }),
    )!;

    expect(patch.edits).toHaveLength(1);
    expect(patch.edits[0].pageIndex).toBe(7);
    expect(patch.inserts[0].afterPage).toBe(4);
    expect(patch.inserts[0].scene.title).toBe('前置知识');
    expect(patch.removals).toEqual([9]);
  });

  it('drops fields a repair is not allowed to touch', () => {
    const patch = parseRevisionPatch(
      JSON.stringify({
        edits: [
          {
            pageIndex: 2,
            changes: {
              keyPoints: ['a'],
              id: 'hacked',
              order: 99,
              quizConfig: { questionCount: 9 },
            },
          },
        ],
      }),
    )!;
    expect(patch.edits[0].changes).toEqual({ keyPoints: ['a'] });
  });

  it('returns null when nothing would change', () => {
    expect(parseRevisionPatch('{"edits":[],"inserts":[],"removals":[]}')).toBeNull();
    expect(parseRevisionPatch('I fixed it.')).toBeNull();
  });

  it('rejects an insert with no usable scene', () => {
    const patch = parseRevisionPatch(
      JSON.stringify({ inserts: [{ afterPage: 1, scene: { type: 'slide', title: 'x' } }] }),
    );
    expect(patch).toBeNull();
  });
});

describe('applyRevisionPatch', () => {
  const draft: SceneOutline[] = [
    {
      ...scene('scene_1'),
      quizConfig: { questionCount: 3, difficulty: 'medium', questionTypes: ['single'] },
    },
    scene('scene_2'),
    scene('scene_3'),
    scene('scene_4'),
  ];

  it('keeps every field the patch does not name', () => {
    // The bug this protocol exists for: a repair that re-emits the outline
    // silently loses quizConfig, and a quiz with no question count is worse
    // than a shallow page.
    const applied = applyRevisionPatch(draft, {
      edits: [{ pageIndex: 1, changes: { description: 'now names its node' } }],
      inserts: [],
      removals: [],
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.outlines[0].description).toBe('now names its node');
    expect(applied.outlines[0].quizConfig).toEqual({
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    });
    expect(applied.outlines[0].id).toBe('scene_1');
  });

  it('inserts a page at the front and in the middle', () => {
    // Ten pages, so two inserts stay inside the drift limit; on a four-page
    // draft the same two inserts would be a 50% change and are refused.
    const ten = Array.from({ length: 10 }, (_, index) => scene(`scene_${index + 1}`));
    const applied = applyRevisionPatch(ten, {
      edits: [],
      inserts: [
        {
          afterPage: 0,
          scene: { type: 'slide', title: '开场', description: 'd', keyPoints: ['a'] },
        },
        {
          afterPage: 2,
          scene: { type: 'slide', title: '补丁', description: 'd', keyPoints: ['a'] },
        },
      ],
      removals: [],
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.outlines.map((s) => s.title).slice(0, 4)).toEqual([
      '开场',
      'scene_1',
      'scene_2',
      '补丁',
    ]);
    expect(applied.outlines).toHaveLength(12);
    expect(new Set(applied.outlines.map((s) => s.id)).size).toBe(12);
    expect(applied.outlines.map((s) => s.order)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it('drops a removed page', () => {
    const applied = applyRevisionPatch(draft, { edits: [], inserts: [], removals: [2] });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.outlines.map((s) => s.title)).toEqual(['scene_1', 'scene_3', 'scene_4']);
  });

  it('refuses an out-of-range page', () => {
    const applied = applyRevisionPatch(draft, {
      edits: [{ pageIndex: 99, changes: { title: 'x' } }],
      inserts: [],
      removals: [],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.reason).toContain('out of range');
  });

  it('refuses a patch that removes most of the course', () => {
    const applied = applyRevisionPatch(draft, { edits: [], inserts: [], removals: [1, 2, 3] });
    expect(applied.ok).toBe(false);
  });

  it('refuses a patch that grows the course past the drift limit', () => {
    const applied = applyRevisionPatch(draft, {
      edits: [],
      inserts: Array.from({ length: 4 }, (_, index) => ({
        afterPage: 0,
        scene: { type: 'slide' as const, title: `n${index}`, description: 'd', keyPoints: ['a'] },
      })),
      removals: [],
    });
    expect(applied.ok).toBe(false);
  });

  it('merges two edits to the same page', () => {
    const applied = applyRevisionPatch(draft, {
      edits: [
        { pageIndex: 1, changes: { title: 'A' } },
        { pageIndex: 1, changes: { description: 'B' } },
      ],
      inserts: [],
      removals: [],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.outlines[0].title).toBe('A');
    expect(applied.outlines[0].description).toBe('B');
  });
});

describe('isSafeRevision', () => {
  const draft = Array.from({ length: 10 }, (_, index) => scene(`scene_${index + 1}`));

  it('accepts a repair that keeps the course', () => {
    expect(isSafeRevision(draft, draft)).toEqual({ ok: true });
  });

  it('accepts a patch page being added', () => {
    const revised = [...draft, scene('scene_11')];
    expect(isSafeRevision(draft, revised)).toEqual({ ok: true });
  });

  it('rejects a rewrite that changes the page count by more than a quarter', () => {
    const rewritten = Array.from({ length: 16 }, (_, index) => scene(`scene_${index + 1}`));
    const result = isSafeRevision(draft, rewritten);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('page count');
  });

  it('rejects an empty revision', () => {
    expect(isSafeRevision(draft, []).ok).toBe(false);
  });

  it('rejects duplicated ids', () => {
    const revised = [...draft.slice(0, 9), scene('scene_1')];
    const result = isSafeRevision(draft, revised);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('id');
  });

  it('rejects an invented scene type', () => {
    const revised = [...draft.slice(0, 9), scene('scene_10', 'whiteboard' as SceneOutline['type'])];
    const result = isSafeRevision(draft, revised);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('scene type');
  });
});
