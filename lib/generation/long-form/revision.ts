/**
 * Revision: the part of long-form generation that is allowed to disagree with
 * itself.
 *
 * A single pass cannot fix a structural mistake, because the pass that would
 * fix it is the pass that made it. An hour-long outline is written once, in one
 * direction, and every defect in it — a claim that was never derived, a module
 * that hangs off no system node, a prerequisite nobody supplied, a course that
 * never asks the learner to decide anything — is invisible from inside that
 * direction.
 *
 * So the outline is drafted, then read back by a critic that did not write it,
 * then revised against the specific defects it found. This module is the
 * arithmetic of that loop: what a critique has to contain to be usable, when it
 * is good enough to stop, and when a revision has to be thrown away.
 *
 * The last one matters most. A revision that loses pages, duplicates ids or
 * quietly drops a third of the course is worse than the draft it replaced, so
 * every revision is checked against the draft before it is adopted.
 */

import type { SceneOutline } from '@/lib/types/generation';

import type { AuditCode, OutlineAudit } from './audit';
import { auditIsClean } from './audit';

/** The five things a long-form outline is reviewed on. */
export const CRITIQUE_DIMENSIONS = [
  'derivation',
  'systems',
  'foundation',
  'agency',
  'structure',
] as const;

export type CritiqueDimension = (typeof CRITIQUE_DIMENSIONS)[number];

export const DIMENSION_LABEL: Readonly<Record<CritiqueDimension, string>> = {
  derivation: '逻辑推导性 — every claim has the step that forces it',
  systems: '系统思维 — every page builds a named node or edge of one system',
  foundation: '基础补强 — assumed knowledge is declared and patched',
  agency: '自主决策 — the learner chooses and sees the consequence',
  structure: '结构与节奏 — modules, minutes and page budgets as specified',
};

export interface CritiqueDefect {
  /** 1-based page the defect sits on, or null for a course-level defect. */
  pageIndex: number | null;
  dimension: CritiqueDimension;
  problem: string;
  fix: string;
}

export interface Critique {
  verdict: 'pass' | 'revise';
  scores: Record<CritiqueDimension, number>;
  defects: CritiqueDefect[];
}

/** Rounds of critique-and-revise after the draft. Two is where returns flatten. */
export const MAX_REVISION_ROUNDS = 2;

/** A dimension at or above this is not worth another round. */
export const CRITIQUE_PASS_SCORE = 4;

/** No revision is asked to fix more than this; past it the outline is rewritten, not patched. */
export const MAX_DEFECTS = 12;

/** A revision may not change the page count by more than this fraction. */
export const MAX_REVISION_DRIFT = 0.25;

/**
 * Wall clock a critique needs before it is worth starting.
 *
 * Both figures exist so the loop never begins a call it cannot finish: the
 * step's deadline kills the whole outline when it fires, and a killed step
 * takes the draft with it. A round that is skipped costs a round; a round that
 * overruns costs the course.
 */
export const CRITIQUE_MIN_MS = 45_000;

/** Wall clock a repair needs: it re-emits the entire outline. */
export const REVISE_MIN_MS = 90_000;

const SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The first balanced JSON object in a model response, fences and prose removed. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseDefect(value: unknown): CritiqueDefect | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const dimension = textOf(raw.dimension) as CritiqueDimension;
  if (!CRITIQUE_DIMENSIONS.includes(dimension)) return null;
  const problem = textOf(raw.problem);
  if (!problem) return null;

  const page = raw.pageIndex;
  const pageIndex = typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : null;

  return { pageIndex, dimension, problem, fix: textOf(raw.fix) };
}

/**
 * Read a critique, or `null` when the response cannot be used.
 *
 * `null` is deliberately not "fail the step". A critic that returns prose, or
 * JSON with no scores, has told us nothing about the outline — and revising on
 * nothing is how a revision loop makes a course worse. The caller keeps the
 * draft and moves on.
 */
export function parseCritique(text: string): Critique | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const scoreRecord =
    typeof record.scores === 'object' && record.scores !== null
      ? (record.scores as Record<string, unknown>)
      : null;
  if (!scoreRecord) return null;

  const present = CRITIQUE_DIMENSIONS.filter(
    (dimension) => typeof scoreRecord[dimension] === 'number',
  );
  if (present.length < 4) return null;

  const scores = Object.fromEntries(
    CRITIQUE_DIMENSIONS.map((dimension) => [dimension, clampScore(scoreRecord[dimension])]),
  ) as Record<CritiqueDimension, number>;

  const defects = Array.isArray(record.defects)
    ? record.defects
        .map(parseDefect)
        .filter((defect): defect is CritiqueDefect => defect !== null)
        .slice(0, MAX_DEFECTS)
    : [];

  return {
    verdict: textOf(record.verdict) === 'pass' ? 'pass' : 'revise',
    scores,
    defects,
  };
}

/** Every dimension clears the bar. */
export function critiquePasses(critique: Critique): boolean {
  // Scores alone are not a pass. `mergeAuditIntoCritique` appends the certain
  // arithmetic defects and flips the verdict to `revise` without touching the
  // scores, so a critic that liked the draft would otherwise be read as a pass
  // and ship it with a missing module, a page with no objective, or a course
  // that runs eight minutes short.
  if (critique.verdict !== 'pass') return false;
  if (critique.defects.length > 0) return false;
  return CRITIQUE_DIMENSIONS.every(
    (dimension) => critique.scores[dimension] >= CRITIQUE_PASS_SCORE,
  );
}

/**
 * Whether to spend another round.
 *
 * `round` is the number of revisions already applied. A critic that says pass,
 * or that found nothing to fix, ends the loop even if its scores are low: there
 * is no instruction to give the rewriter, and a rewriter with no instruction
 * rewrites the course.
 */
export function shouldRevise(critique: Critique, round: number): boolean {
  if (round >= MAX_REVISION_ROUNDS) return false;
  if (critique.verdict === 'pass') return false;
  if (critique.defects.length === 0) return false;
  return true;
}

/** The defect list as the rewriter receives it. */
export function formatCritiqueForRevision(critique: Critique): string {
  const lines = critique.defects.map((defect, index) => {
    const where = defect.pageIndex === null ? 'course level' : `page ${defect.pageIndex}`;
    const fix = defect.fix ? ` Fix: ${defect.fix}` : '';
    return `${index + 1}. [${defect.dimension}] ${where} — ${defect.problem}${fix}`;
  });

  const scores = CRITIQUE_DIMENSIONS.map(
    (dimension) => `${dimension} ${critique.scores[dimension]}/5`,
  ).join(' · ');

  return [`Scores: ${scores}`, '', 'Defects to fix, in priority order:', ...lines].join('\n');
}

export type RevisionSafety = { ok: true } | { ok: false; reason: string };

/**
 * Whether there is still time to start a call that needs `needMs`.
 *
 * No deadline means no limit — the caller is running outside a step budget
 * (a test, a script) and the loop may use its full rounds.
 */
export function hasTimeFor(
  deadlineAt: number | undefined,
  needMs: number,
  now = Date.now(),
): boolean {
  if (deadlineAt === undefined) return true;
  return now + needMs < deadlineAt;
}

/**
 * A repair, expressed as changes to the draft rather than as a new draft.
 *
 * The first version of this asked the rewriter to return the whole outline. It
 * read well and was wrong: an outline carries `quizConfig`, `pblConfig`,
 * `suggestedImageIds` and `mediaGenerations`, none of which the critic ever
 * mentions and all of which a re-emitted outline silently loses. A course whose
 * quizzes come back without question counts is worse than a shallow one.
 *
 * So a repair is a patch. Everything not named is preserved byte for byte, which
 * makes "patch, don't rewrite" a property of the protocol instead of an
 * instruction the model may ignore — and keeps the response small enough that a
 * hundred-page course can still be repaired inside one call.
 */
export interface RevisionPatch {
  /** Changes to existing pages, by 1-based page index in the draft. */
  edits: Array<{ pageIndex: number; changes: Partial<SceneOutline> }>;
  /** New pages, inserted after `afterPage` (0 inserts at the front). */
  inserts: Array<{ afterPage: number; scene: Partial<SceneOutline> }>;
  /** Pages to drop, 1-based. */
  removals: number[];
}

/** The only fields a repair may change. Everything else round-trips untouched. */
const EDITABLE_FIELDS = [
  'type',
  'title',
  'description',
  'keyPoints',
  'teachingObjective',
  'estimatedDuration',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

function isEditableField(key: string): key is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(key);
}

function coerceChanges(value: unknown): Partial<SceneOutline> | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const changes: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(raw)) {
    if (!isEditableField(key) || field === undefined) continue;
    if (key === 'keyPoints') {
      if (!Array.isArray(field)) continue;
      const points = field.filter((point): point is string => typeof point === 'string');
      if (points.length > 0) changes.keyPoints = points;
      continue;
    }
    if (key === 'estimatedDuration') {
      if (typeof field === 'number' && Number.isFinite(field) && field > 0) {
        changes.estimatedDuration = Math.round(field);
      }
      continue;
    }
    if (key === 'type') {
      if (typeof field === 'string' && SCENE_TYPES.has(field)) changes.type = field;
      continue;
    }
    if (typeof field === 'string' && field.trim()) changes[key] = field;
  }

  return Object.keys(changes).length > 0 ? (changes as Partial<SceneOutline>) : null;
}

function coerceNewScene(value: unknown): Partial<SceneOutline> | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === 'string' && SCENE_TYPES.has(raw.type) ? raw.type : null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints.filter((point): point is string => typeof point === 'string')
    : [];

  if (!type || !title || !description || keyPoints.length === 0) return null;

  const scene: Partial<SceneOutline> = {
    type: type as SceneOutline['type'],
    title,
    description,
    keyPoints,
  };
  const objective = typeof raw.teachingObjective === 'string' ? raw.teachingObjective.trim() : '';
  if (objective) scene.teachingObjective = objective;
  if (typeof raw.estimatedDuration === 'number' && raw.estimatedDuration > 0) {
    scene.estimatedDuration = Math.round(raw.estimatedDuration);
  }
  return scene;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Read a patch, or `null` when the response describes no change. */
export function parseRevisionPatch(text: string): RevisionPatch | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const edits: RevisionPatch['edits'] = [];
  if (Array.isArray(record.edits)) {
    for (const entry of record.edits.slice(0, MAX_DEFECTS * 2)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const pageIndex = integer(item.pageIndex);
      const changes = coerceChanges(item.changes);
      if (pageIndex === null || !changes) continue;
      edits.push({ pageIndex, changes });
    }
  }

  const inserts: RevisionPatch['inserts'] = [];
  if (Array.isArray(record.inserts)) {
    for (const entry of record.inserts.slice(0, MAX_DEFECTS)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const afterPage = integer(item.afterPage);
      const scene = coerceNewScene(item.scene);
      if (afterPage === null || !scene) continue;
      inserts.push({ afterPage, scene });
    }
  }

  const removals: number[] = [];
  if (Array.isArray(record.removals)) {
    for (const entry of record.removals) {
      const page = integer(entry);
      if (page !== null) removals.push(page);
    }
  }

  if (edits.length === 0 && inserts.length === 0 && removals.length === 0) return null;
  return { edits, inserts, removals };
}

/**
 * Apply a patch to the draft.
 *
 * Refuses rather than guesses: an index outside the draft, a removal of more
 * than a quarter of the course, or a net change beyond the drift limit all mean
 * the patch is describing a different course, and the draft is what the learner
 * should get.
 */
export function applyRevisionPatch(
  draft: readonly SceneOutline[],
  patch: RevisionPatch,
): { ok: true; outlines: SceneOutline[] } | { ok: false; reason: string } {
  const total = draft.length;
  if (total === 0) return { ok: false, reason: 'the draft has no pages to patch' };

  const removed = new Set<number>();
  for (const page of patch.removals) {
    if (page < 1 || page > total) {
      return { ok: false, reason: `removal of page ${page} is out of range` };
    }
    removed.add(page);
  }
  if (removed.size / total > MAX_REVISION_DRIFT) {
    return { ok: false, reason: `the patch removes ${removed.size} of ${total} pages` };
  }

  const editsByPage = new Map<number, Partial<SceneOutline>>();
  for (const edit of patch.edits) {
    if (edit.pageIndex < 1 || edit.pageIndex > total) {
      return { ok: false, reason: `edit of page ${edit.pageIndex} is out of range` };
    }
    editsByPage.set(edit.pageIndex, { ...editsByPage.get(edit.pageIndex), ...edit.changes });
  }

  const insertsAfter = new Map<number, Array<Partial<SceneOutline>>>();
  for (const insert of patch.inserts) {
    if (insert.afterPage < 0 || insert.afterPage > total) {
      return { ok: false, reason: `insert after page ${insert.afterPage} is out of range` };
    }
    const list = insertsAfter.get(insert.afterPage) ?? [];
    list.push(insert.scene);
    insertsAfter.set(insert.afterPage, list);
  }

  const usedIds = new Set(draft.map((scene) => scene.id));
  let counter = 1;
  const nextId = (): string => {
    let id = `scene_added_${counter}`;
    while (usedIds.has(id)) {
      counter += 1;
      id = `scene_added_${counter}`;
    }
    counter += 1;
    usedIds.add(id);
    return id;
  };

  const out: SceneOutline[] = [];

  const pushInserts = (afterPage: number) => {
    for (const scene of insertsAfter.get(afterPage) ?? []) {
      out.push({
        id: nextId(),
        type: (scene.type ?? 'slide') as SceneOutline['type'],
        title: scene.title ?? 'Untitled',
        description: scene.description ?? '',
        keyPoints: scene.keyPoints ?? [],
        ...(scene.teachingObjective ? { teachingObjective: scene.teachingObjective } : {}),
        ...(scene.estimatedDuration ? { estimatedDuration: scene.estimatedDuration } : {}),
        order: 0,
      });
    }
  };

  pushInserts(0);
  draft.forEach((scene, position) => {
    const page = position + 1;
    if (!removed.has(page)) {
      const changes = editsByPage.get(page);
      out.push(changes ? { ...scene, ...changes } : { ...scene });
    }
    pushInserts(page);
  });

  if (out.length === 0) return { ok: false, reason: 'the patch leaves no pages' };

  const drift = Math.abs(out.length - total) / total;
  if (drift > MAX_REVISION_DRIFT) {
    return { ok: false, reason: `the patch changes the page count by ${Math.round(drift * 100)}%` };
  }

  return { ok: true, outlines: out.map((scene, position) => ({ ...scene, order: position + 1 })) };
}

/**
 * Whether a revision may replace the draft it was derived from.
 *
 * A rewriter is asked to fix defects, not to rewrite the course. When it
 * returns something that lost pages, duplicated ids or invented a scene type,
 * the honest conclusion is that the revision failed — and the draft, which is
 * at least structurally sound, is what the learner should get.
 */
export function isSafeRevision(previous: SceneOutline[], next: SceneOutline[]): RevisionSafety {
  if (next.length === 0) return { ok: false, reason: 'revision returned no scenes' };

  const drift = Math.abs(next.length - previous.length) / Math.max(1, previous.length);
  if (drift > MAX_REVISION_DRIFT) {
    return {
      ok: false,
      reason: `revision changed the page count by ${Math.round(drift * 100)}% (${previous.length} → ${next.length})`,
    };
  }

  const ids = new Set<string>();
  for (const scene of next) {
    if (!SCENE_TYPES.has(scene.type)) {
      return {
        ok: false,
        reason: `revision introduced unknown scene type ${JSON.stringify(scene.type)}`,
      };
    }
    if (!scene.id || ids.has(scene.id)) {
      return {
        ok: false,
        reason: `revision duplicated or dropped scene id ${JSON.stringify(scene.id)}`,
      };
    }
    ids.add(scene.id);
  }

  return { ok: true };
}

/** Which pages the critic named, for the run log. */
export function defectPages(critique: Critique): number[] {
  return [...new Set(critique.defects.map((defect) => defect.pageIndex))]
    .filter((page): page is number => page !== null)
    .sort((a, b) => a - b);
}

/**
 * The outline as the critic and the rewriter see it.
 *
 * Only the fields both stages reason about: media requests and widget configs
 * are tokens the critic cannot judge, and every one of them is attention not
 * spent on the argument. The repair is a patch, so nothing here is lost on the
 * way back.
 */
export function serializeOutlineForCritic(outlines: readonly SceneOutline[]): string {
  const scenes = outlines.map((scene, index) => ({
    page: index + 1,
    id: scene.id,
    type: scene.type,
    title: scene.title,
    description: scene.description,
    keyPoints: scene.keyPoints,
    ...(scene.teachingObjective ? { teachingObjective: scene.teachingObjective } : {}),
    ...(scene.estimatedDuration ? { estimatedDuration: scene.estimatedDuration } : {}),
  }));
  return JSON.stringify(scenes, null, 1);
}

/** What to do about each arithmetic defect, in the rewriter's language. */
const AUDIT_FIX: Readonly<Record<AuditCode, string>> = {
  'page-count':
    'Bring the page count back to the budget: merge or split pages, do not delete teaching.',
  'duration-drift':
    'Bring the total minutes back to the budget by correcting estimatedDuration per page to the page budgets you were given.',
  'missing-duration': "Set estimatedDuration from this page's slot in the budget.",
  'page-duration':
    'Set estimatedDuration to the page budget for this slot, or rebalance the content of the page.',
  'missing-objective':
    'Write a teachingObjective in one sentence starting with a testable verb (derive / predict / distinguish / apply).',
  'missing-check':
    "Make this module's last page a retrieval scene: a quiz, or an interactive that requires an action.",
  'missing-decision':
    'Add a decision question to this module — or convert its existing quiz into one: a situation, two or three plausible options, and the consequence of each wrong choice.',
};

/**
 * Fold the arithmetic findings into a critique.
 *
 * The critic reads for judgement; it should not also be the auditor. When the
 * arithmetic found something the critic missed — a course that runs 48 minutes
 * against a 60-minute budget, a module with no retrieval page — that finding is
 * a defect whether or not the critic noticed, and the repair round has to see
 * it. So audit defects are prepended, phrased as instructions, and the verdict
 * becomes `revise`.
 *
 * Arithmetic defects come first because they are certain: a rewriter with room
 * for three fixes should spend them on the things that are definitely wrong.
 */
export function mergeAuditIntoCritique(critique: Critique, audit: OutlineAudit): Critique {
  if (auditIsClean(audit)) return critique;

  const fromAudit: CritiqueDefect[] = audit.defects.slice(0, 6).map((defect) => ({
    pageIndex: defect.pageIndex,
    dimension: 'structure',
    problem: defect.detail,
    fix: AUDIT_FIX[defect.code],
  }));

  return {
    ...critique,
    verdict: 'revise',
    defects: [...fromAudit, ...critique.defects].slice(0, MAX_DEFECTS),
  };
}
