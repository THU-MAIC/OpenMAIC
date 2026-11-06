/**
 * One linear undo/redo line per course, in memory only.
 *
 * An entry is a diff: for each scene it touched, the top-level fields it changed
 * (a scene it added or removed is held whole, as it last left the document), plus
 * the page order, the page in
 * focus and the video manifest when those moved. Undoing an entry therefore
 * touches only what the entry changed. Every change to a course's content lands
 * on the line, hand edits and agent edits alike, so steps replay strictly in
 * order and need no invalidation rule.
 *
 * This module is pure apart from the zustand store at the bottom. Reading and
 * writing the stage store is `lib/edit/course-edit.ts`'s job.
 */

import { create } from 'zustand';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import { pblSceneAsPersisted } from '@/lib/pbl/v2/runtime/persisted-scene';
import type { Scene, Stage } from '@/lib/types/stage';

export const MAX_TIMELINE_STEPS = 100;
/**
 * Bytes a document no longer references are reclaimed after the asset
 * collector's grace, one hour by default. A step that would bring such a
 * reference back leaves the line well before that.
 */
export const ASSET_RETENTION_MS = 45 * 60 * 1000;
/** A run's writes reach the browser through the sync, shortly after `agent_end`. */
export const AGENT_RUN_SETTLE_MS = 8_000;
/** A run whose worker died says nothing more: past this silence, it is over. */
export const AGENT_RUN_IDLE_MS = 10 * 60 * 1000;
/** Edits of one text further apart than this are separate steps. */
export const BURST_MAX_GAP_MS = 10_000;

export type TimelineOrigin = 'user' | 'agent';
export type TimelineDirection = 'undo' | 'redo';
type SceneFields = Readonly<Record<string, unknown>>;

/** `null` on one side means the scene does not exist on that side. */
export interface SceneChange {
  readonly before: SceneFields | null;
  readonly after: SceneFields | null;
}

type VideoManifest = Stage['videoManifest'];

export interface TimelineEntry {
  readonly id: number;
  readonly origin: TimelineOrigin;
  readonly at: number;
  readonly scenes: Readonly<Record<string, SceneChange>>;
  readonly order: { readonly before: readonly string[]; readonly after: readonly string[] } | null;
  readonly focus: { readonly before: string | null; readonly after: string | null };
  readonly videoManifest: {
    readonly before: VideoManifest;
    readonly after: VideoManifest;
  } | null;
  readonly coalesceKey?: string;
  readonly runId?: number;
  /** What undoing, and redoing, this entry would bring back into the document. */
  readonly assetRefs: { readonly undo: readonly string[]; readonly redo: readonly string[] };
}

export interface CourseDocument {
  readonly stage: Stage | null;
  readonly scenes: readonly Scene[];
  readonly currentSceneId: string | null;
}

// ---------------------------------------------------------------------------
// Comparing values the way the server stores them
// ---------------------------------------------------------------------------

/** Undefined members dropped and keys sorted: what survives a trip to the server. */
export function normalizedJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, member: unknown) => {
      if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
      const record = member as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    }) ?? 'undefined'
  );
}

const normalizedByObject = new WeakMap<object, number>();

/** A compact fingerprint of {@link normalizedJson}, cached per immutable object. */
export function fieldFingerprint(value: unknown): number {
  const cacheable = typeof value === 'object' && value !== null;
  if (cacheable) {
    const cached = normalizedByObject.get(value);
    if (cached !== undefined) return cached;
  }
  const text = normalizedJson(value);
  // cyrb53: 53 bits keeps an accidental collision out of reach for one course.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const fingerprint = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  if (cacheable) normalizedByObject.set(value, fingerprint);
  return fingerprint;
}

export function sameField(left: unknown, right: unknown): boolean {
  return left === right || fieldFingerprint(left) === fieldFingerprint(right);
}

/** Scene members that are bookkeeping, not content. Page order is tracked as a sequence. */
const UNTRACKED_SCENE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'stageId',
  'order',
  'createdAt',
  'updatedAt',
]);

export function trackedSceneFields(scene: object): string[] {
  return Object.keys(scene).filter((key) => !UNTRACKED_SCENE_FIELDS.has(key));
}

// ---------------------------------------------------------------------------
// Building entries
// ---------------------------------------------------------------------------

const designFormByScene = new WeakMap<Scene, Scene>();

/**
 * A scene without its learner state. Learner work is not edit history: a step
 * records and compares only the design (undo puts the current learner state back
 * on, see `withLearnerStateOf`).
 */
function designForm(scene: Scene): Scene {
  let form = designFormByScene.get(scene);
  if (!form) {
    form = pblSceneAsPersisted(scene);
    designFormByScene.set(scene, form);
  }
  return form;
}

function diffScene(before: Scene, after: Scene): SceneChange | null {
  if (before === after) return null;
  const left = designForm(before) as unknown as Record<string, unknown>;
  const right = designForm(after) as unknown as Record<string, unknown>;
  const beforeFields: Record<string, unknown> = {};
  const afterFields: Record<string, unknown> = {};
  for (const key of new Set([...trackedSceneFields(left), ...trackedSceneFields(right)])) {
    if (sameField(left[key], right[key])) continue;
    beforeFields[key] = left[key];
    afterFields[key] = right[key];
  }
  return Object.keys(beforeFields).length > 0 ? { before: beforeFields, after: afterFields } : null;
}

function assetRefsOf(changes: Readonly<Record<string, SceneChange>>, side: keyof SceneChange) {
  const scenes: Scene[] = [];
  for (const [id, change] of Object.entries(changes)) {
    const fields = change[side];
    if (!fields) continue;
    if (!('content' in fields || 'actions' in fields || 'whiteboards' in fields)) continue;
    // A partial scene carrying only what this entry would write back.
    scenes.push({
      id,
      actions: [],
      ...fields,
      content: fields.content ?? { type: 'quiz', questions: [] },
    } as unknown as Scene);
  }
  if (scenes.length === 0) return [];
  const stage = { id: 'timeline', name: '' } as unknown as Stage;
  return [...collectStageAssetRefs({ stage, scenes }).referenced];
}

function withAssetRefs(entry: Omit<TimelineEntry, 'assetRefs'>): TimelineEntry {
  return {
    ...entry,
    assetRefs: {
      undo: assetRefsOf(entry.scenes, 'before'),
      redo: assetRefsOf(entry.scenes, 'after'),
    },
  };
}

let nextEntryId = 1;

export function diffCourse(
  before: CourseDocument,
  after: CourseDocument,
  options: {
    readonly origin: TimelineOrigin;
    readonly at: number;
    readonly coalesceKey?: string;
    readonly runId?: number;
  },
): TimelineEntry | null {
  const scenes: Record<string, SceneChange> = {};
  const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
  const afterById = new Map(after.scenes.map((scene) => [scene.id, scene]));
  for (const scene of before.scenes) {
    const next = afterById.get(scene.id);
    if (!next) {
      scenes[scene.id] = { before: scene as unknown as SceneFields, after: null };
      continue;
    }
    const change = diffScene(scene, next);
    if (change) scenes[scene.id] = change;
  }
  for (const scene of after.scenes) {
    if (!beforeById.has(scene.id)) {
      scenes[scene.id] = { before: null, after: scene as unknown as SceneFields };
    }
  }
  const beforeOrder = before.scenes.map((scene) => scene.id);
  const afterOrder = after.scenes.map((scene) => scene.id);
  const orderMoved =
    beforeOrder.length !== afterOrder.length ||
    beforeOrder.some((id, index) => id !== afterOrder[index]);
  const beforeManifest = before.stage?.videoManifest;
  const afterManifest = after.stage?.videoManifest;
  const manifestMoved = !sameField(beforeManifest, afterManifest);
  if (Object.keys(scenes).length === 0 && !orderMoved && !manifestMoved) return null;
  return withAssetRefs({
    id: nextEntryId++,
    origin: options.origin,
    at: options.at,
    scenes,
    order: orderMoved ? { before: beforeOrder, after: afterOrder } : null,
    focus: { before: before.currentSceneId, after: after.currentSceneId },
    videoManifest: manifestMoved ? { before: beforeManifest, after: afterManifest } : null,
    ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });
}

function composeSceneChange(first: SceneChange, second: SceneChange): SceneChange | null {
  if (first.before === null && second.after === null) return null;
  const merged: SceneChange = {
    before: first.before === null ? null : { ...second.before, ...first.before },
    after: second.after === null ? null : { ...first.after, ...second.after },
  };
  if (!merged.before || !merged.after) return merged;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of new Set([
    ...trackedSceneFields(merged.before),
    ...trackedSceneFields(merged.after),
  ])) {
    if (sameField(merged.before[key], merged.after[key])) continue;
    before[key] = merged.before[key];
    after[key] = merged.after[key];
  }
  return Object.keys(before).length > 0 ? { before, after } : null;
}

/** One step equivalent to `first` then `second`, or null when they cancel out. */
export function composeEntries(first: TimelineEntry, second: TimelineEntry): TimelineEntry | null {
  const scenes: Record<string, SceneChange> = { ...first.scenes };
  for (const [id, change] of Object.entries(second.scenes)) {
    const earlier = scenes[id];
    const merged = earlier ? composeSceneChange(earlier, change) : change;
    if (merged) scenes[id] = merged;
    else delete scenes[id];
  }
  const orderBefore = first.order?.before ?? second.order?.before;
  const orderAfter = second.order?.after ?? first.order?.after;
  const order =
    orderBefore && orderAfter && normalizedJson(orderBefore) !== normalizedJson(orderAfter)
      ? { before: orderBefore, after: orderAfter }
      : null;
  const manifestSpan =
    first.videoManifest || second.videoManifest
      ? {
          before: (first.videoManifest ?? second.videoManifest)!.before,
          after: (second.videoManifest ?? first.videoManifest)!.after,
        }
      : null;
  const videoManifest =
    manifestSpan && !sameField(manifestSpan.before, manifestSpan.after) ? manifestSpan : null;
  if (Object.keys(scenes).length === 0 && !order && !videoManifest) return null;
  return withAssetRefs({
    ...first,
    scenes,
    order,
    videoManifest,
    focus: { before: first.focus.before, after: second.focus.after },
  });
}

// ---------------------------------------------------------------------------
// Applying entries
// ---------------------------------------------------------------------------

/**
 * Put the pages in `target`'s sequence. An id `target` names that is gone is
 * dropped; a page `target` never knew keeps the position it holds now.
 */
export function restorePageOrder(
  currentIds: readonly string[],
  targetIds: readonly string[],
): string[] {
  const current = new Set(currentIds);
  const target = new Set(targetIds);
  const sequence = targetIds.filter((id) => current.has(id));
  currentIds.forEach((id, index) => {
    if (!target.has(id)) sequence.splice(Math.min(index, sequence.length), 0, id);
  });
  return sequence;
}

/** Only the manifest keys the entry moved: a key added since then stays. */
function applyManifestDelta(
  current: VideoManifest,
  from: VideoManifest,
  to: VideoManifest,
): VideoManifest {
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(from ?? {})) {
    if (!(to && key in to)) delete next[key];
  }
  for (const [key, value] of Object.entries(to ?? {})) {
    if (!from || !(key in from) || !sameField((from as Record<string, unknown>)[key], value)) {
      next[key] = value;
    }
  }
  return next as VideoManifest;
}

export interface AppliedTimelineStep {
  readonly scenes: Scene[];
  readonly stage: Stage | null;
  readonly currentSceneId: string | null;
  /** Scenes whose content changed: each is its own pending write. */
  readonly changedSceneIds: readonly string[];
  readonly structureChanged: boolean;
  readonly stageChanged: boolean;
}

function focusTarget(
  entry: TimelineEntry,
  direction: TimelineDirection,
  survivors: ReadonlySet<string>,
): string | null {
  const side = direction === 'undo' ? 'before' : 'after';
  const entries = Object.entries(entry.scenes);
  const preferred = entry.focus[side];
  const restored = entries.find(
    ([id, change]) => change[side === 'before' ? 'after' : 'before'] === null && survivors.has(id),
  );
  if (restored) return restored[0];
  if (preferred && entry.scenes[preferred] && survivors.has(preferred)) return preferred;
  const patched = entries.find(([id, change]) => change[side] !== null && survivors.has(id));
  if (patched) return patched[0];
  return preferred && survivors.has(preferred) ? preferred : null;
}

/** The document after replaying `entry`, or null when that would change nothing. */
export function applyTimelineEntry(
  document: CourseDocument,
  entry: TimelineEntry,
  direction: TimelineDirection,
): AppliedTimelineStep | null {
  const toSide = direction === 'undo' ? 'before' : 'after';
  const fromSide = direction === 'undo' ? 'after' : 'before';
  const byId = new Map(document.scenes.map((scene) => [scene.id, scene]));
  const ids = document.scenes.map((scene) => scene.id);
  const changedSceneIds: string[] = [];
  let membershipChanged = false;

  for (const [id, change] of Object.entries(entry.scenes)) {
    const to = change[toSide];
    const existing = byId.get(id);
    if (to === null) {
      if (!existing) continue;
      byId.delete(id);
      ids.splice(ids.indexOf(id), 1);
      membershipChanged = true;
      continue;
    }
    if (!existing) {
      if (change[fromSide] !== null) continue;
      byId.set(id, to as unknown as Scene);
      ids.push(id);
      membershipChanged = true;
      changedSceneIds.push(id);
      continue;
    }
    const current = existing as unknown as Record<string, unknown>;
    const shown = designForm(existing) as unknown as Record<string, unknown>;
    const fields = change[fromSide] === null ? trackedSceneFields(to) : Object.keys(to);
    const next: Record<string, unknown> = { ...current };
    let moved = false;
    for (const key of fields) {
      if (sameField(shown[key], to[key])) continue;
      moved = true;
      if (to[key] === undefined) delete next[key];
      else next[key] = to[key];
    }
    if (moved) {
      byId.set(id, next as unknown as Scene);
      changedSceneIds.push(id);
    }
  }

  const sequence = entry.order ? restorePageOrder(ids, entry.order[toSide]) : ids;
  const orderChanged =
    sequence.length !== document.scenes.length ||
    sequence.some((id, index) => document.scenes[index]?.id !== id);
  const structureChanged = membershipChanged || orderChanged;

  let stage = document.stage;
  if (entry.videoManifest && stage) {
    const manifest = applyManifestDelta(
      stage.videoManifest,
      entry.videoManifest[fromSide],
      entry.videoManifest[toSide],
    );
    if (!sameField(manifest, stage.videoManifest)) stage = { ...stage, videoManifest: manifest };
  }
  const stageChanged = stage !== document.stage;
  if (changedSceneIds.length === 0 && !structureChanged && !stageChanged) return null;

  const resolved = sequence.map((id) => byId.get(id)!);
  const scenes = structureChanged
    ? resolved.map((scene, index) =>
        scene.order === index + 1 ? scene : { ...scene, order: index + 1 },
      )
    : resolved;
  const survivors = new Set(sequence);
  const previousIndex = document.scenes.findIndex((scene) => scene.id === document.currentSceneId);
  const stillThere =
    document.currentSceneId && survivors.has(document.currentSceneId)
      ? document.currentSceneId
      : (scenes[Math.min(Math.max(previousIndex, 0), scenes.length - 1)]?.id ?? null);
  return {
    scenes,
    stage,
    currentSceneId: focusTarget(entry, direction, survivors) ?? stillThere,
    changedSceneIds,
    structureChanged,
    stageChanged,
  };
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

export interface CourseLine {
  readonly past: readonly TimelineEntry[];
  readonly future: readonly TimelineEntry[];
  /** The typing burst or gesture the next entry with the same key folds into. */
  readonly activeCoalesceKey: string | null;
  /** When the burst last grew. */
  readonly activeCoalesceAt: number;
  /** When each reference left the document, for as long as it stays out. */
  readonly refDroppedAt: Readonly<Record<string, number>>;
  readonly knownRefs: readonly string[] | null;
}

export const EMPTY_LINE: CourseLine = {
  past: [],
  future: [],
  activeCoalesceKey: null,
  activeCoalesceAt: 0,
  refDroppedAt: {},
  knownRefs: null,
};

/** A new step clears redo; one continuing the top step's burst or run folds into it. */
export function pushEntry(line: CourseLine, entry: TimelineEntry): CourseLine {
  const top = line.past[line.past.length - 1];
  const continuesBurst =
    entry.coalesceKey !== undefined &&
    line.activeCoalesceKey === entry.coalesceKey &&
    entry.at - line.activeCoalesceAt <= BURST_MAX_GAP_MS &&
    top?.coalesceKey === entry.coalesceKey;
  const continuesRun = entry.runId !== undefined && top?.runId === entry.runId;
  const activeCoalesceKey = entry.coalesceKey ?? null;
  if (top && (continuesBurst || continuesRun)) {
    const composed = composeEntries(top, entry);
    return {
      ...line,
      past: composed ? [...line.past.slice(0, -1), composed] : line.past.slice(0, -1),
      future: [],
      // A burst that cancelled out is over: the next edit must not fold into an
      // older step that happens to carry the same key.
      activeCoalesceKey: composed ? activeCoalesceKey : null,
      activeCoalesceAt: entry.at,
    };
  }
  return {
    ...line,
    past: [...line.past, entry].slice(-MAX_TIMELINE_STEPS),
    future: [],
    activeCoalesceKey,
    activeCoalesceAt: entry.at,
  };
}

/**
 * Generated audio landed on a speech line. Stamping is not a step, but a step that
 * restores `actions` must not take the audio away: every recorded version of the
 * line with the same text gets it too.
 */
export function stampAudioOnLine(
  line: CourseLine,
  sceneId: string,
  actionId: string,
  text: string,
  audioId: string,
): CourseLine {
  const stamp = (fields: SceneFields | null): SceneFields | null => {
    if (!fields || !Array.isArray(fields.actions)) return fields;
    let stamped = false;
    const actions = (fields.actions as readonly Record<string, unknown>[]).map((action) => {
      if (action.id !== actionId || action.text !== text || action.audioId === audioId) {
        return action;
      }
      stamped = true;
      return { ...action, audioId };
    });
    return stamped ? { ...fields, actions } : fields;
  };
  const stampEntry = (entry: TimelineEntry): TimelineEntry => {
    const change = entry.scenes[sceneId];
    if (!change) return entry;
    const before = stamp(change.before);
    const after = stamp(change.after);
    if (before === change.before && after === change.after) return entry;
    return withAssetRefs({ ...entry, scenes: { ...entry.scenes, [sceneId]: { before, after } } });
  };
  return { ...line, past: line.past.map(stampEntry), future: line.future.map(stampEntry) };
}

/**
 * `entry` as it should cross the line once replayed on `document`: a scene the
 * replay removes is held as it left, so bringing it back again restores what was
 * there then, learner work included, not what was there when the step was first
 * recorded. Learner work is not edit history, and a stale copy of it must not come
 * back.
 */
export function withRemovedScenesAsLeft(
  entry: TimelineEntry,
  direction: TimelineDirection,
  document: CourseDocument,
): TimelineEntry {
  const toSide = direction === 'undo' ? 'before' : 'after';
  const fromSide = direction === 'undo' ? 'after' : 'before';
  const byId = new Map(document.scenes.map((scene) => [scene.id, scene]));
  let scenes: Record<string, SceneChange> | null = null;
  for (const [id, change] of Object.entries(entry.scenes)) {
    const existing = byId.get(id);
    if (change[toSide] !== null || change[fromSide] === null || !existing) continue;
    if (change[fromSide] === (existing as unknown as SceneFields)) continue;
    scenes ??= { ...entry.scenes };
    scenes[id] = { ...change, [fromSide]: existing as unknown as SceneFields };
  }
  return scenes ? withAssetRefs({ ...entry, scenes }) : entry;
}

/**
 * Move the top step across. An undone step is closed: nothing later folds into it.
 * `replayed` is the step as it crosses (see {@link withRemovedScenesAsLeft}).
 */
export function stepLine(
  line: CourseLine,
  direction: TimelineDirection,
  replayed?: TimelineEntry,
): CourseLine {
  const source = direction === 'undo' ? line.past : line.future;
  const top = direction === 'undo' ? source[source.length - 1] : source[0];
  if (!top) return line;
  const entry = replayed && replayed.id === top.id ? replayed : top;
  const { runId: _runId, ...closed } = entry;
  return {
    ...line,
    activeCoalesceKey: null,
    past: direction === 'undo' ? line.past.slice(0, -1) : [...line.past, closed],
    future: direction === 'undo' ? [closed, ...line.future] : line.future.slice(1),
  };
}

export function nextStep(line: CourseLine, direction: TimelineDirection): TimelineEntry | null {
  return (direction === 'undo' ? line.past[line.past.length - 1] : line.future[0]) ?? null;
}

export function dropStep(line: CourseLine, entry: TimelineEntry): CourseLine {
  return {
    ...line,
    past: line.past.filter((candidate) => candidate !== entry),
    future: line.future.filter((candidate) => candidate !== entry),
  };
}

/** Record which references left, or came back to, the document. */
export function noteDocumentRefs(
  line: CourseLine,
  documentRefs: ReadonlySet<string>,
  now: number,
): CourseLine {
  const refDroppedAt: Record<string, number> = {};
  for (const [ref, at] of Object.entries(line.refDroppedAt)) {
    if (!documentRefs.has(ref)) refDroppedAt[ref] = at;
  }
  for (const ref of line.knownRefs ?? []) {
    if (!documentRefs.has(ref)) refDroppedAt[ref] ??= now;
  }
  return { ...line, refDroppedAt, knownRefs: [...documentRefs] };
}

function stepExpired(
  entry: TimelineEntry,
  refs: readonly string[],
  line: CourseLine,
  documentRefs: ReadonlySet<string>,
  now: number,
): boolean {
  return refs.some(
    (ref) =>
      !documentRefs.has(ref) && now - (line.refDroppedAt[ref] ?? entry.at) >= ASSET_RETENTION_MS,
  );
}

/** Steps that would bring back a reference the collector may be about to reclaim. */
export function expireSteps(
  line: CourseLine,
  documentRefs: ReadonlySet<string>,
  now: number,
): { line: CourseLine; expired: readonly TimelineEntry[] } {
  const expired: TimelineEntry[] = [];
  const keep = (entry: TimelineEntry, refs: readonly string[]) => {
    if (!stepExpired(entry, refs, line, documentRefs, now)) return true;
    expired.push(entry);
    return false;
  };
  const past = line.past.filter((entry) => keep(entry, entry.assetRefs.undo));
  const future = line.future.filter((entry) => keep(entry, entry.assetRefs.redo));
  return expired.length === 0 ? { line, expired } : { line: { ...line, past, future }, expired };
}

export function documentAssetRefs(document: CourseDocument): ReadonlySet<string> {
  return collectStageAssetRefs(
    document.stage ? { stage: document.stage, scenes: document.scenes } : null,
  ).referenced;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AgentRun {
  readonly id: number;
  readonly endedAt: number | null;
  /** When the run last showed a sign of life. */
  readonly seenAt: number;
}

interface CourseTimelineState {
  readonly lines: Readonly<Record<string, CourseLine>>;
  readonly agentRun: AgentRun | null;
  updateLine: (stageId: string, update: (line: CourseLine) => CourseLine) => void;
  clearCourse: (stageId: string) => void;
  beginAgentRun: (now: number) => void;
  /** An undo or redo landed: what the open run writes next is a step of its own. */
  splitAgentRun: () => void;
  endAgentRun: (now: number) => void;
  /** The session said something: a run still open is alive. */
  touchAgentRun: (now: number) => void;
  /** The run a remote change arriving now belongs to, if any. */
  activeRunId: (now: number) => number | undefined;
  /** End the burst in progress: the next edit is its own step, even with the same key. */
  sealBurst: (stageId: string) => void;
}

let nextRunId = 1;

export const useCourseTimeline = create<CourseTimelineState>()((set, get) => ({
  lines: {},
  agentRun: null,
  updateLine: (stageId, update) =>
    set((state) => ({
      lines: { ...state.lines, [stageId]: update(state.lines[stageId] ?? EMPTY_LINE) },
    })),
  clearCourse: (stageId) =>
    set((state) => {
      if (!state.lines[stageId]) return state;
      const { [stageId]: _removed, ...lines } = state.lines;
      return { lines };
    }),
  // A second start with no end is a crashed run resuming the same answer.
  beginAgentRun: (now) =>
    set((state) =>
      state.agentRun?.endedAt === null && now - state.agentRun.seenAt < AGENT_RUN_IDLE_MS
        ? { agentRun: { ...state.agentRun, seenAt: now } }
        : { agentRun: { id: nextRunId++, endedAt: null, seenAt: now } },
    ),
  splitAgentRun: () =>
    set((state) => (state.agentRun ? { agentRun: { ...state.agentRun, id: nextRunId++ } } : state)),
  endAgentRun: (now) =>
    set((state) =>
      state.agentRun && state.agentRun.endedAt === null
        ? { agentRun: { ...state.agentRun, endedAt: now } }
        : state,
    ),
  touchAgentRun: (now) => {
    const run = get().agentRun;
    // Frames arrive many times a second; the limit is minutes.
    if (run && run.endedAt === null && now - run.seenAt > 30_000) {
      set({ agentRun: { ...run, seenAt: now } });
    }
  },
  activeRunId: (now) => {
    const run = get().agentRun;
    if (!run) return undefined;
    if (run.endedAt !== null) return now - run.endedAt < AGENT_RUN_SETTLE_MS ? run.id : undefined;
    return now - run.seenAt < AGENT_RUN_IDLE_MS ? run.id : undefined;
  },
  sealBurst: (stageId) => {
    if (get().lines[stageId]?.activeCoalesceKey) {
      get().updateLine(stageId, (line) => ({ ...line, activeCoalesceKey: null }));
    }
  },
}));
