import { describe, expect, it } from 'vitest';
import {
  auditIsClean,
  auditOutline,
  pageCeilingFor,
  pageFloorFor,
  planLongFormCourse,
} from '@/lib/generation/long-form';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import type { SceneOutline } from '@/lib/types/generation';

const plan = planLongFormCourse({ minutes: 60, language: 'zh' });

/** An outline that satisfies the plan exactly. */
function goodOutline(): SceneOutline[] {
  return plan.scenes.map((slot, index) => ({
    id: `scene_${index + 1}`,
    // Retrieval at module ends, quiz inside decision modules.
    type:
      plan.modules.find((module) => module.index === slot.moduleIndex)?.endsWithCheck &&
      slot.role === 'check'
        ? 'quiz'
        : 'slide',
    title: `Page ${index + 1}`,
    description: 'does a thing',
    keyPoints: ['a premise', 'an inference'],
    teachingObjective: 'predict the outcome',
    estimatedDuration: slot.durationSeconds,
    order: index + 1,
  }));
}

describe('auditOutline', () => {
  it('passes an outline that meets the budget', () => {
    const audit = auditOutline(plan, goodOutline());
    expect(audit.defects).toEqual([]);
    expect(auditIsClean(audit)).toBe(true);
    expect(audit.pages).toBe(29);
    expect(audit.totalSeconds).toBe(3600);
    expect(audit.driftPct).toBe(0);
  });

  it('catches a course that claims an hour and runs 48 minutes', () => {
    // The failure this exists for: estimatedDuration was carried through the
    // pipeline and read by nobody, so a short course shipped as a long one.
    const short = goodOutline().map((scene) => ({ ...scene, estimatedDuration: 100 }));
    const audit = auditOutline(plan, short);

    expect(audit.totalSeconds).toBe(2900);
    expect(audit.driftPct).toBeLessThan(-0.15);
    const drift = audit.defects.find((defect) => defect.code === 'duration-drift')!;
    expect(drift.pageIndex).toBeNull();
    expect(drift.detail).toContain('48 minutes');
    expect(drift.detail).toContain('60-minute budget');
  });

  it('catches pages that never said how long they are', () => {
    const missing = goodOutline();
    delete missing[3].estimatedDuration;
    const audit = auditOutline(plan, missing);

    const defect = audit.defects.find((candidate) => candidate.code === 'missing-duration')!;
    expect(defect.pageIndex).toBe(4);
  });

  it('catches a page that is nothing like its slot', () => {
    const skewed = goodOutline();
    skewed[0] = { ...skewed[0], estimatedDuration: 600 };
    const audit = auditOutline(plan, skewed);

    expect(audit.defects.some((defect) => defect.code === 'page-duration')).toBe(true);
  });

  it('catches a page with no objective', () => {
    const noObjective = goodOutline();
    delete noObjective[6].teachingObjective;
    const audit = auditOutline(plan, noObjective);

    const defect = audit.defects.find((candidate) => candidate.code === 'missing-objective')!;
    expect(defect.pageIndex).toBe(7);
  });

  it('reports a malformed objective instead of throwing on it', () => {
    // The streaming parser casts JSON to SceneOutline without validating it, so a
    // truthy non-string reaches the audit before `normalizeSceneOutlines` runs.
    // Throwing here would discard an otherwise usable draft.
    const malformed = goodOutline();
    (malformed[2] as unknown as { teachingObjective: unknown }).teachingObjective = [];
    const audit = auditOutline(plan, malformed);

    const defect = audit.defects.find((candidate) => candidate.code === 'missing-objective')!;
    expect(defect.pageIndex).toBe(3);
  });

  it('reports a malformed duration instead of letting it poison the totals', () => {
    // `"120 seconds"` is truthy, so the old guard accepted it; summing it
    // concatenated into the accumulator, which made the drift NaN — and NaN
    // fails every comparison, so the page reported clean on both duration checks
    // at once while the drift silently stopped being checked.
    const malformed = goodOutline();
    (malformed[5] as unknown as { estimatedDuration: unknown }).estimatedDuration = '120 seconds';
    const audit = auditOutline(plan, malformed);

    expect(Number.isNaN(audit.driftPct)).toBe(false);
    const defect = audit.defects.find((candidate) => candidate.code === 'missing-duration')!;
    expect(defect.pageIndex).toBe(6);
  });

  it('keeps module findings on pages the outline actually has', () => {
    // 24 pages against a 29-page plan is inside the page tolerance, so module
    // checks still run. Using plan indices named page 25 — which this outline
    // does not have — and the rewriter's patch for it was rejected as out of
    // range, taking the whole repair with it.
    const drifted = goodOutline()
      .slice(0, 24)
      .map((scene, index) => ({ ...scene, estimatedDuration: 150, order: index + 1 }));
    const audit = auditOutline(plan, drifted);

    expect(audit.pages).toBe(24);
    for (const defect of audit.defects) {
      if (defect.pageIndex === null) continue;
      expect(defect.pageIndex).toBeGreaterThanOrEqual(1);
      expect(defect.pageIndex).toBeLessThanOrEqual(24);
    }
  });

  it('checks the pages the plan has no slot for', () => {
    // 35 pages against 29 is still inside the tolerance. The six extra pages had
    // no slot, so their duration check was skipped: they could claim one second
    // each while the narration stage budgeted them at a hundred, and the total
    // still read clean.
    const extra = Array.from({ length: 35 }, (_, index) => ({
      ...goodOutline()[0]!,
      id: `scene_${index + 1}`,
      estimatedDuration: 1,
      order: index + 1,
    }));
    const audit = auditOutline(plan, extra);

    expect(audit.pages).toBe(35);
    expect(audit.defects.some((defect) => defect.pageIndex === 30)).toBe(true);
    expect(audit.defects.some((defect) => defect.code === 'page-duration')).toBe(true);
  });

  it('does not count an interactive page the pipeline would turn into a slide', () => {
    // `applyOutlineFallbacks` converts an interactive page with no widget config
    // into a slide before content generation, and the patch protocol lets a
    // repair add exactly that page. Counting it as the module's retrieval beat
    // reports a check that never gets built.
    const moduleWithCheck = plan.modules.find((module) => module.endsWithCheck)!;
    const lastPage = plan.scenes
      .filter((slot) => slot.moduleIndex === moduleWithCheck.index)
      .pop()!;
    const bare = goodOutline().map((scene, index) =>
      index + 1 === lastPage.index ? { ...scene, type: 'interactive' as const } : scene,
    );

    const audit = auditOutline(plan, bare);
    expect(audit.defects.some((defect) => defect.code === 'missing-check')).toBe(true);
  });

  it('catches a module that forgot its retrieval page', () => {
    const noCheck = goodOutline().map((scene, index) =>
      index === 6 ? { ...scene, type: 'slide' as const } : scene,
    );
    const audit = auditOutline(plan, noCheck);

    const defect = audit.defects.find((candidate) => candidate.code === 'missing-check')!;
    expect(defect.detail).toContain('module 2');
  });

  it('catches a module marked for a decision with no quiz', () => {
    // Hand-built plan: in a 60-minute course every decision module also ends
    // with a check, so the check quiz would mask a missing decision. This plan
    // separates the two to test the decision rule on its own.
    const plan2 = {
      ...plan,
      minutes: 20,
      modules: [
        { ...plan.modules[0], index: 1, durationMinutes: 10, sceneBudget: 2, endsWithCheck: false },
        { ...plan.modules[1], index: 2, durationMinutes: 10, sceneBudget: 2, endsWithCheck: false },
      ],
      scenes: [
        {
          ...plan.scenes[0],
          index: 1,
          moduleIndex: 1,
          durationSeconds: 300,
          role: 'open' as const,
        },
        {
          ...plan.scenes[0],
          index: 2,
          moduleIndex: 1,
          durationSeconds: 300,
          role: 'close' as const,
        },
        {
          ...plan.scenes[0],
          index: 3,
          moduleIndex: 2,
          durationSeconds: 300,
          role: 'open' as const,
        },
        {
          ...plan.scenes[0],
          index: 4,
          moduleIndex: 2,
          durationSeconds: 300,
          role: 'close' as const,
        },
      ],
      decisionModules: [2],
      patchModules: [],
    };

    const slides: SceneOutline[] = plan2.scenes.map((slot, index) => ({
      id: `s${index + 1}`,
      type: 'slide',
      title: `P${index + 1}`,
      description: '',
      keyPoints: ['a'],
      teachingObjective: 'predict',
      estimatedDuration: slot.durationSeconds,
      order: index + 1,
    }));

    const audit = auditOutline(plan2, slides);
    expect(audit.defects.some((defect) => defect.code === 'missing-decision')).toBe(true);
    expect(audit.defects.some((defect) => defect.code === 'missing-check')).toBe(false);
  });

  it('skips module checks when the page count is too far off to compare', () => {
    // At that point "module 3 has no retrieval page" is an artefact of the
    // mismatch, and reporting it sends the rewriter after the wrong page.
    const half = goodOutline().slice(0, 12);
    const audit = auditOutline(plan, half);

    expect(audit.defects.some((defect) => defect.code === 'page-count')).toBe(true);
    expect(audit.defects.some((defect) => defect.code === 'missing-check')).toBe(false);
  });

  it('reports an empty outline rather than dividing by zero', () => {
    const audit = auditOutline(plan, []);
    expect(audit.pages).toBe(0);
    expect(audit.defects[0].code).toBe('page-count');
    expect(audit.summary).toContain('empty');
  });

  it('summarises its findings for the critic', () => {
    const short = goodOutline().map((scene) => ({ ...scene, estimatedDuration: 100 }));
    const audit = auditOutline(plan, short);

    expect(audit.summary).toContain('Arithmetic:');
    expect(audit.summary).toContain('already confirmed');
    expect(audit.summary).toContain('course level');
  });
});

describe('pageCeilingFor', () => {
  it('bounds a long-form outline at the page tolerance', () => {
    // A 240-minute request plans 108 pages. A model that ignores the budget and
    // emits one page per minute produces 240; the audit would call that a defect,
    // but a repair may not remove more than a quarter of the pages, so nothing
    // downstream can shrink it.
    const fourHours = planLongFormCourse({ minutes: 240, language: 'zh' });
    expect(fourHours.scenes.length).toBeLessThan(120);
    expect(pageCeilingFor(fourHours)).toBe(Math.ceil(fourHours.scenes.length * 1.25));
    expect(pageCeilingFor(plan)).toBe(Math.ceil(plan.scenes.length * 1.25));
  });

  it('refuses an outline the plan cannot account for', () => {
    const fourHours = planLongFormCourse({ minutes: 240, language: 'zh' });
    const onePagePerMinute = Array.from({ length: 240 }, (_, index) => ({
      id: `scene_${index + 1}`,
      type: 'slide',
      title: `P${index + 1}`,
      description: '',
      keyPoints: ['a'],
      order: index + 1,
    }));

    // The shared cap still accepts it, which is why the caller has to narrow it.
    expect(normalizeSceneOutlines(onePagePerMinute).ok).toBe(true);
    expect(
      normalizeSceneOutlines(onePagePerMinute, { maxScenes: pageCeilingFor(fourHours) }).ok,
    ).toBe(false);
  });
});

describe('pageFloorFor', () => {
  it('refuses an hour-long outline that came back as one page', () => {
    // The stream treats a single parsed scene as success, and the repair loop
    // cannot rescue it: turning one page into two exceeds MAX_REVISION_DRIFT, so
    // the repair is rejected as unsafe. The engine would then schedule a one-page
    // course for an explicit hour.
    const onePage = [
      {
        id: 'scene_1',
        type: 'slide',
        title: 'P1',
        description: '',
        keyPoints: ['a'],
        order: 1,
      },
    ];

    expect(pageFloorFor(plan)).toBe(Math.floor(plan.scenes.length * 0.75));
    expect(normalizeSceneOutlines(onePage).ok).toBe(true);
    expect(normalizeSceneOutlines(onePage, { minScenes: pageFloorFor(plan) }).ok).toBe(false);
  });
});
