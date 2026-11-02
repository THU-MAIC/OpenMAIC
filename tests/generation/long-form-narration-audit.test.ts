import { describe, expect, it } from 'vitest';

import {
  auditNarration,
  narrationIsClean,
  planLongFormCourse,
  type LongFormCoursePlan,
} from '@/lib/generation/long-form';

const plan = planLongFormCourse({ minutes: 60, language: 'zh' });
const budgets = () => plan.scenes.map((slot) => slot.speechBudget);

/**
 * Unique text of roughly the requested length.
 *
 * A template repeated with only a number changed shares twelve-character runs
 * with itself, which is exactly what the repeat check looks for — so the filler
 * interleaves a digit every couple of characters, the way real prose does not.
 */
const POOL = '受体占据率效应增强心率下降血压呼吸抑制镇痛阿片激动拮抗耐受成瘾剂量曲线饱和';

function narration(index: number, chars: number, connective = '因为'): string {
  let out = `${connective}`;
  let seed = index * 7919 + 13;
  while (out.length < chars) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += POOL[seed % POOL.length];
    out += POOL[Math.floor(seed / 7) % POOL.length];
    out += String(seed % 97);
    out += '。';
  }
  return out;
}

/** A speech for every slot, each at its own budget. */
function fullNarration(target: LongFormCoursePlan = plan): string[] {
  return target.scenes.map((slot, index) => narration(index + 1, slot.speechBudget));
}

describe('auditNarration', () => {
  it('passes a course whose pages fill their budgets', () => {
    const audit = auditNarration(fullNarration(), budgets());

    expect(audit.pages).toBe(plan.scenes.length);
    expect(audit.defects).toEqual([]);
    expect(narrationIsClean(audit)).toBe(true);
    expect(audit.derivationDensity).toBeGreaterThan(0);
  });

  it('catches the page that came back short', () => {
    // p14 of the reference run was 668 of 800 characters and shipped anyway,
    // because nothing compared the narration to the budget it was written for.
    const speeches = fullNarration();
    const slot = plan.scenes[13]!;
    speeches[13] = narration(14, Math.round(slot.speechBudget * 0.5));

    const audit = auditNarration(speeches, budgets());
    const defect = audit.defects.find((candidate) => candidate.code === 'short-page')!;

    expect(defect.pageIndex).toBe(14);
    expect(defect.detail).toContain(String(slot.speechBudget));
    expect(audit.defects).toHaveLength(1);
  });

  it('names the earlier page a later one repeats', () => {
    const speeches = fullNarration();
    const reused = speeches[1]!.slice(0, 24);
    speeches[7] = `${reused}${speeches[7]!.slice(0, 400)}`;

    const audit = auditNarration(speeches, budgets());
    const defect = audit.defects.find((candidate) => candidate.code === 'repeated-content')!;

    expect(defect.pageIndex).toBe(8);
    expect(defect.detail).toContain('page 2');
  });

  it('catches a long page that never says why', () => {
    // 400 characters of assertion with no causal connective is the shape the
    // long-form contract names: the conclusion is announced, not derived.
    const speeches = fullNarration();
    speeches[4] = Array.from(
      { length: 12 },
      (_, n) => `第5页第${n}句受体${n * 37 + 11}号位点占据率${n * 13}效应增强心率减慢。`,
    ).join('');

    const audit = auditNarration(speeches, budgets());
    const defect = audit.defects.find((candidate) => candidate.code === 'no-derivation')!;

    expect(defect.pageIndex).toBe(5);
    expect(defect.detail).toContain('does not derive');
  });

  it('does not call a short transition page underivable', () => {
    // A 120-character page is a transition or a question; it owes no argument,
    // and flagging it would make the check fire on every well-built course.
    const speeches = fullNarration();
    speeches[2] = '我们先把上一页的结论放一放，回到最初那个问题。';

    const audit = auditNarration(speeches, budgets());
    expect(audit.defects.some((defect) => defect.code === 'no-derivation')).toBe(false);
  });

  it('reports connective density so a rewrite can be compared', () => {
    const sparse = auditNarration(
      fullNarration().map((speech) => speech.replace(/因为/g, '并且')),
      budgets(),
    );
    const dense = auditNarration(fullNarration(), budgets());

    expect(sparse.derivationDensity).toBeLessThan(dense.derivationDensity);
    expect(dense.summary).toContain('causal connectives per 100 characters');
  });
});
