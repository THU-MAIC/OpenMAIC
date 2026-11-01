import { describe, expect, it } from 'vitest';
import { auditIsClean, auditOutline, planLongFormCourse } from '@/lib/generation/long-form';
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
