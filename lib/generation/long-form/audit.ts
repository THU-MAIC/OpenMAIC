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

import { modulePageRanges } from './brief';
import type { LongFormCoursePlan, LongFormSceneSlot } from './types';

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
 * The most pages this plan can be built from without the outline being a
 * different course.
 *
 * The audit's own tolerance, used as a hard bound at the edge of the pipeline:
 * a 240-minute request plans 108 pages, and a model that ignores the budget and
 * emits one page per minute produces 240. The audit reports that as a defect, but
 * a repair may not remove more than a quarter of the pages, so nothing downstream
 * can shrink it — and the engine then schedules content, actions and narration
 * for all 240. Refusing it at normalization is the last point where that is still
 * cheap.
 */
export function pageCeilingFor(plan: LongFormCoursePlan): number {
  return Math.ceil(plan.scenes.length * (1 + DEFAULTS.pageTolerance));
}

/**
 * The fewest pages this plan can be built from without being a different course.
 *
 * The same tolerance at the other end. An hour-long outline that comes back with
 * one page is treated as a success by the stream — it parsed, it has an id — and
 * the repair loop cannot save it either: turning one page into two exceeds
 * `MAX_REVISION_DRIFT`, so the repair is rejected as unsafe. The engine then
 * schedules a one-page course for an explicit hour. Refusing it at normalization
 * is the only place left that can.
 */
export function pageFloorFor(plan: LongFormCoursePlan): number {
  return Math.max(1, Math.floor(plan.scenes.length * (1 - DEFAULTS.pageTolerance)));
}

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

/**
 * A page's own duration, when it has a usable one.
 *
 * The streaming parser casts JSON to `SceneOutline` without validating it, so
 * `"estimatedDuration": "120 seconds"` reaches this module as a truthy string.
 * Summing it concatenates into the accumulator and makes the drift NaN, and
 * every per-page comparison against it is NaN and therefore false — so a page
 * with no usable duration would report clean on both checks at once.
 */
function durationOf(scene: SceneOutline): number | null {
  const value = scene.estimatedDuration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The plan slot this page is measured against.
 *
 * When the counts agree it is the page's own slot. When they do not, the extra
 * pages have no slot at all and the per-page duration check used to be skipped
 * for exactly those: 35 pages against a 29-page plan left pages 30-35 unchecked,
 * so six pages could claim one second each and the total still read clean while
 * the narration stage budgeted them at a hundred. Projecting the slot by the same
 * proportional rule as the module ranges keeps both stages measuring the same
 * page against the same expectation.
 */
function effectiveSlot(
  plan: LongFormCoursePlan,
  pageIndex: number,
  totalPages: number,
): LongFormSceneSlot | undefined {
  if (totalPages === plan.scenes.length) return plan.scenes[pageIndex - 1];
  const projected = Math.min(
    plan.scenes.length,
    Math.max(1, Math.round(((pageIndex - 0.5) / totalPages) * plan.scenes.length)),
  );
  return plan.scenes[projected - 1];
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
  const totalSeconds = outlines.reduce((acc, scene) => acc + (durationOf(scene) ?? 0), 0);
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
    const slot = effectiveSlot(plan, pageIndex, outlines.length);
    const duration = durationOf(scene);

    if (duration === null) {
      defects.push({
        code: 'missing-duration',
        pageIndex,
        detail: 'no usable estimatedDuration, so this page cannot be checked against its budget',
      });
    } else if (
      slot &&
      Math.abs(duration - slot.durationSeconds) / slot.durationSeconds > pageDurationTolerance
    ) {
      defects.push({
        code: 'page-duration',
        pageIndex,
        detail: `planned ${slot.durationSeconds}s for this slot, outline says ${duration}s`,
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
    const ranges = modulePageRanges(plan, outlines.length);

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

/**
 * How much a defect matters when the list has to be shortened.
 *
 * A missing retrieval page or a course that runs eight minutes short is a
 * structural failure; a single page with no objective is a detail. The repair
 * prompt takes a capped list, so the order is what decides whether the
 * structural ones survive.
 */
const CODE_PRIORITY: Readonly<Record<AuditCode, number>> = {
  'page-count': 0,
  'duration-drift': 1,
  'missing-check': 2,
  'missing-decision': 3,
  'missing-objective': 4,
  'missing-duration': 5,
  'page-duration': 6,
};

/** Page-level findings of one code kept before the rest are folded together. */
const PER_CODE_KEPT = 2;

/**
 * The audit's findings, shortened without losing the ones that matter.
 *
 * A draft where every page omits its objective produces 29 `missing-objective`
 * findings, and appending the module findings after them meant a prefix of six
 * carried nothing but page 1-6 objectives. The critic is told not to repeat the
 * arithmetic, so a confirmed missing retrieval page then shipped: it never
 * reached the rewriter. Structural codes go in first and in full; page-level
 * codes get what is left, collapsed into one finding per code once they repeat.
 */
export function prioritizeDefects(defects: readonly AuditDefect[], limit: number): AuditDefect[] {
  const structural = defects
    .filter((defect) => CODE_PRIORITY[defect.code] <= CODE_PRIORITY['missing-decision'])
    .sort((a, b) => CODE_PRIORITY[a.code] - CODE_PRIORITY[b.code]);

  const byCode = new Map<AuditCode, AuditDefect[]>();
  for (const defect of defects) {
    if (CODE_PRIORITY[defect.code] <= CODE_PRIORITY['missing-decision']) continue;
    const list = byCode.get(defect.code);
    if (list) list.push(defect);
    else byCode.set(defect.code, [defect]);
  }

  const pageLevel: AuditDefect[] = [];
  for (const code of [...byCode.keys()].sort((a, b) => CODE_PRIORITY[a] - CODE_PRIORITY[b])) {
    const list = byCode.get(code)!;
    if (list.length <= PER_CODE_KEPT + 1) {
      pageLevel.push(...list);
      continue;
    }
    pageLevel.push(...list.slice(0, PER_CODE_KEPT));
    const rest = list.slice(PER_CODE_KEPT);
    pageLevel.push({
      code,
      pageIndex: null,
      detail: `${rest.length} more pages have the same finding: ${rest
        .map((defect) => defect.pageIndex)
        .join(', ')}`,
    });
  }

  return [...structural, ...pageLevel].slice(0, limit);
}
