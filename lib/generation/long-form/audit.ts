/**
 * The arithmetic a long-form outline can be checked against without a model.
 *
 * Everything here is a fact the outline either satisfies or does not: the
 * minutes add up to the course length or they do not, a module ends with a
 * retrieval scene or it does not, a page has an objective or it does not. No
 * judgement is required, so none is spent — the critic is handed these as
 * findings and asked only about the things arithmetic cannot see.
 *
 * This is also what finally consumes `estimatedDuration`. Until now the field
 * was carried through the whole pipeline and read by nobody, which meant a
 * model could plan an hour, write twelve pages, claim four minutes each, and
 * nothing anywhere would notice the course runs 48 minutes.
 */

import type { SceneOutline } from '@/lib/types/generation';

import type { LongFormCoursePlan } from './types';

export type AuditCode =
  /** The page count is far from the budget. */
  | 'page-count'
  /** The planned minutes do not add up to the requested length. */
  | 'duration-drift'
  /** A page does not say how long it is. */
  | 'missing-duration'
  /** A page's minutes are far from the budget for that slot. */
  | 'page-duration'
  /** A page has no teaching objective. */
  | 'missing-objective'
  /** A module the budget marks for retrieval has no retrieval page. */
  | 'missing-check'
  /** A module the budget marks for a decision has no decision-capable page. */
  | 'missing-decision';

export interface AuditDefect {
  code: AuditCode;
  /** 1-based page, or null for a course-level finding. */
  pageIndex: number | null;
  detail: string;
}

export interface OutlineAudit {
  pages: number;
  totalSeconds: number;
  targetSeconds: number;
  /** Signed fraction: +0.12 is twelve percent long. */
  driftPct: number;
  defects: AuditDefect[];
  /** The findings as the critic receives them. */
  summary: string;
}

export interface AuditOptions {
  /** Total minutes may differ from the plan by this fraction before it counts. */
  durationTolerance?: number;
  /** Page count may differ from the plan by this fraction before it counts. */
  pageTolerance?: number;
  /** A page's minutes may differ from its slot by this fraction. */
  pageDurationTolerance?: number;
}

const DEFAULTS = {
  /**
   * Fifteen percent, not twenty.
   *
   * At an hour, 20% is twelve minutes — a course that ends while the learner is
   * still waiting for the last third. A 48-minute lesson against a 60-minute
   * budget sits at 19.4% and slipped through the looser bar, which is exactly
   * the case the audit exists to catch. Fifteen percent is nine minutes: still
   * forgiving of estimation noise, no longer forgiving of a missing module.
   */
  durationTolerance: 0.15,
  pageTolerance: 0.25,
  pageDurationTolerance: 0.4,
};

/**
 * Whether a page makes the learner produce something, as the pipeline will build
 * it.
 *
 * An `interactive` page with no config is not one: `applyOutlineFallbacks` turns
 * exactly that page into a slide before content generation runs, so counting it
 * here would report the module as having a retrieval beat that never gets built —
 * and a repair is allowed to add an `interactive` page without widget fields,
 * which is how that false pass arises.
 */
function isRetrievalScene(scene: SceneOutline): boolean {
  if (scene.type === 'quiz') return true;
  if (scene.type !== 'interactive') return false;
  return Boolean(scene.interactiveConfig || (scene.widgetType && scene.widgetOutline));
}

/** Page indices each module owns, in the plan's own numbering. */
function modulePageRanges(plan: LongFormCoursePlan): Map<number, { first: number; last: number }> {
  const ranges = new Map<number, { first: number; last: number }>();
  for (const slot of plan.scenes) {
    const current = ranges.get(slot.moduleIndex);
    if (!current) ranges.set(slot.moduleIndex, { first: slot.index, last: slot.index });
    else current.last = slot.index;
  }
  return ranges;
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
}

/**
 * Check an outline against the plan it was written for.
 *
 * Module-level checks are skipped when the page count has drifted far enough
 * that the plan's page ranges no longer describe this outline: at that point
 * "module 3 has no retrieval page" is an artefact of the mismatch, not a
 * finding, and reporting it would send the rewriter after the wrong page.
 */
export function auditOutline(
  plan: LongFormCoursePlan,
  outlines: readonly SceneOutline[],
  options: AuditOptions = {},
): OutlineAudit {
  const durationTolerance = options.durationTolerance ?? DEFAULTS.durationTolerance;
  const pageTolerance = options.pageTolerance ?? DEFAULTS.pageTolerance;
  const pageDurationTolerance = options.pageDurationTolerance ?? DEFAULTS.pageDurationTolerance;

  const defects: AuditDefect[] = [];
  const targetSeconds = plan.minutes * 60;
  const totalSeconds = outlines.reduce((acc, scene) => acc + (scene.estimatedDuration ?? 0), 0);
  const driftPct = targetSeconds > 0 ? (totalSeconds - targetSeconds) / targetSeconds : 0;

  if (outlines.length === 0) {
    return {
      pages: 0,
      totalSeconds: 0,
      targetSeconds,
      driftPct: -1,
      defects: [{ code: 'page-count', pageIndex: null, detail: 'the outline has no pages' }],
      summary: 'Arithmetic: the outline is empty.',
    };
  }

  const plannedPages = plan.scenes.length;
  const pageDrift = (outlines.length - plannedPages) / Math.max(1, plannedPages);
  const structurallyComparable = Math.abs(pageDrift) <= pageTolerance;

  if (!structurallyComparable) {
    defects.push({
      code: 'page-count',
      pageIndex: null,
      detail: `planned ${plannedPages} pages, outline has ${outlines.length} (${pct(pageDrift)})`,
    });
  }

  if (Math.abs(driftPct) > durationTolerance) {
    defects.push({
      code: 'duration-drift',
      pageIndex: null,
      detail: `the outline runs ${Math.round(totalSeconds / 60)} minutes against a ${plan.minutes}-minute budget (${pct(driftPct)})`,
    });
  }

  outlines.forEach((scene, position) => {
    const pageIndex = position + 1;
    const slot = plan.scenes[position];

    if (!scene.estimatedDuration || scene.estimatedDuration <= 0) {
      defects.push({
        code: 'missing-duration',
        pageIndex,
        detail: 'no estimatedDuration, so this page cannot be checked against its budget',
      });
    } else if (
      slot &&
      Math.abs(scene.estimatedDuration - slot.durationSeconds) / slot.durationSeconds >
        pageDurationTolerance
    ) {
      defects.push({
        code: 'page-duration',
        pageIndex,
        detail: `planned ${slot.durationSeconds}s for this slot, outline says ${scene.estimatedDuration}s`,
      });
    }

    // The streaming parser casts JSON to `SceneOutline` without validating it,
    // and `normalizeSceneOutlines` does not run until the outline step returns.
    // A truthy non-string here (`"teachingObjective": []`) would throw on
    // `.trim()` and lose an otherwise usable draft, so the type is checked
    // rather than assumed.
    if (typeof scene.teachingObjective !== 'string' || !scene.teachingObjective.trim()) {
      defects.push({ code: 'missing-objective', pageIndex, detail: 'no teachingObjective' });
    }
  });

  if (structurallyComparable) {
    const ranges = modulePageRanges(plan);

    for (const modulePlan of plan.modules) {
      const range = ranges.get(modulePlan.index);
      if (!range) continue;
      const pages = outlines.slice(range.first - 1, Math.min(range.last, outlines.length));
      if (pages.length === 0) continue;

      if (modulePlan.endsWithCheck) {
        const last = pages[pages.length - 1];
        if (!isRetrievalScene(last)) {
          defects.push({
            code: 'missing-check',
            pageIndex: range.last,
            detail: `module ${modulePlan.index} must end with a retrieval page; page ${range.last} is a ${last.type}`,
          });
        }
      }

      if (plan.decisionModules.includes(modulePlan.index)) {
        const hasDecision = pages.some((page) => page.type === 'quiz');
        if (!hasDecision) {
          defects.push({
            code: 'missing-decision',
            pageIndex: range.first,
            detail: `module ${modulePlan.index} is marked for a decision but has no quiz page`,
          });
        }
      }
    }
  }

  return {
    pages: outlines.length,
    totalSeconds,
    targetSeconds,
    driftPct,
    defects,
    summary: formatAudit({
      defects,
      totalSeconds,
      targetSeconds,
      driftPct,
      pages: outlines.length,
    }),
  };
}

function formatAudit(
  audit: Pick<OutlineAudit, 'defects' | 'totalSeconds' | 'targetSeconds' | 'driftPct' | 'pages'>,
): string {
  const minutes = Math.round(audit.totalSeconds / 60);
  const target = Math.round(audit.targetSeconds / 60);
  const lines = [
    `Arithmetic: ${audit.pages} pages, ${minutes} minutes against a ${target}-minute budget (${pct(audit.driftPct)}).`,
  ];
  if (audit.defects.length === 0) {
    lines.push(
      'No arithmetic defects: durations, objectives and retrieval placement all match the budget.',
    );
  } else {
    lines.push('Arithmetic defects (already confirmed — do not re-derive, just fix):');
    for (const defect of audit.defects) {
      const where = defect.pageIndex === null ? 'course level' : `page ${defect.pageIndex}`;
      lines.push(`- ${where}: ${defect.detail}`);
    }
  }
  return lines.join('\n');
}

/** True when the outline has no arithmetic defect worth a repair round. */
export function auditIsClean(audit: OutlineAudit): boolean {
  return audit.defects.length === 0;
}
