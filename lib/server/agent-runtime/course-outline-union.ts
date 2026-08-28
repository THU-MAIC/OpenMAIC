/**
 * The single shared union view over a stage's planned outline and its
 * persisted scenes.
 *
 * Two agent tools answer the same "what does this course look like right now"
 * question and must answer it identically:
 *
 *  - `read_stage_outline` (curriculum-tools.ts) renders the page list;
 *  - `generate_actions` (course-tools.ts) builds the course-context slot
 *    (`allTitles` "Title: brief" entries + the current page's position).
 *
 * The page list's order truth is the REAL scenes: a mid-deck insert
 * (import_pptx atOrder, edit_deck insert, duplicate_scene) can never leave
 * the readout with stale, duplicated or missing page numbers. But a stage
 * whose generation is still IN PROGRESS (outline complete, scenes landing one
 * by one) must not read as truncated either: snapshot entries that no
 * persisted scene carries are kept as PLANNED pages. A COMPLETED snapshot is
 * pure scenes — its stale entries must never resurface.
 *
 * Matching — pairing each real scene with the outline entry it was built from:
 *  - by `outlineId` when the scene carries one AND the id still resolves to an
 *    unconsumed entry. An outlineId duplicated across the plan only ever
 *    consumes its FIRST occurrence; the remaining same-id entries stay
 *    planned or re-pair by order (a Set-membership union would swallow them).
 *  - otherwise by `order`: a real scene at order N occupies plan slot N
 *    (pre-existing / inserted scenes have no outlineId).
 *  - otherwise the scene is an inserted page with no plan slot at all.
 * Each outline entry is consumed at most once.
 *
 * Merging — display order: entries merge BY ORDER instead of being
 * tail-appended, so planned-only pages sit at their planned position. When a
 * real page and a planned entry share an order, the real page comes first and
 * the planned entry defers. Display sequence numbers are the merged
 * consecutive positions; every entry keeps its ORIGINAL `order` (the
 * structured page list reports it, so no duplicated page numbers appear).
 *
 * Briefs: matched real pages carry the snapshot's `description` (brief),
 * which is what lets `generate_actions` render "Title: brief" — `scene.title`
 * is only the fallback when no snapshot entry was matched.
 */
import type { SceneOutline } from '@/lib/types/generation';

/** A real scene reduced to the fields the union matching needs. */
export interface OutlineSceneLike {
  id: string;
  order: number;
  title: string;
  type: string;
  outlineId?: string;
}

/** One page of the union view. */
export interface OutlineUnionEntry {
  /** The page's original order: scene order for real pages, plan order for planned ones. */
  order: number;
  title: string;
  type: SceneOutline['type'];
  /** True only for planned-only pages (no persisted scene yet). */
  planned?: boolean;
  /** Real pages: the persisted scene id. */
  sceneId?: string;
  /** Real pages: the snapshot outline id they were matched to, when one exists. */
  outlineId?: string;
  /** The page brief: the snapshot description for matched pages, scene.title otherwise. */
  description?: string;
  keyPoints?: string[];
}

export interface OutlineUnionInput {
  scenes: readonly OutlineSceneLike[];
  planned: readonly SceneOutline[];
  /**
   * `false` keeps the still-planned pages in the union; `true` or `undefined`
   * (a client-minted course never marks progress) means finished intent —
   * pure scenes, stale planned entries never resurface.
   */
  generationComplete?: boolean;
}

const OUTLINE_TYPES = new Set<SceneOutline['type']>(['slide', 'quiz', 'interactive', 'pbl']);

function outlineTypeFromScene(type: string): SceneOutline['type'] {
  return OUTLINE_TYPES.has(type as SceneOutline['type']) ? (type as SceneOutline['type']) : 'slide';
}

/**
 * Pair every real scene with the outline entry it was built from: by
 * `outlineId` (identity, consuming only the FIRST occurrence of an id
 * duplicated across the plan), else by `order`. Returns scene id → planned
 * index; scenes with no match are absent. This is the one matching rule for
 * outline↔scene pairing — `mergeStageOutline` renders with it, and the agent
 * runtime's order-renumbering helpers (course-tools.ts) keep the snapshot
 * outline in lockstep with reordered scenes using it, so the rules cannot
 * drift between the readout and the writers.
 */
export function matchOutlineEntries(
  scenes: readonly OutlineSceneLike[],
  planned: readonly SceneOutline[],
): Map<string, number> {
  const idCount = new Map<string, number>();
  const firstIndexOfId = new Map<string, number>();
  planned.forEach((o, i) => {
    idCount.set(o.id, (idCount.get(o.id) ?? 0) + 1);
    if (!firstIndexOfId.has(o.id)) firstIndexOfId.set(o.id, i);
  });
  const consumed = new Array<boolean>(planned.length).fill(false);
  const matchIndex = new Map<string, number>(); // scene id → planned index
  for (const scene of scenes) {
    let index = -1;
    if (scene.outlineId) {
      const count = idCount.get(scene.outlineId) ?? 0;
      if (count <= 1) {
        index = planned.findIndex((o, i) => o.id === scene.outlineId && !consumed[i]);
      } else {
        const first = firstIndexOfId.get(scene.outlineId) ?? -1;
        index = first >= 0 && !consumed[first] ? first : -1;
      }
    }
    if (index < 0) {
      index = planned.findIndex((o, i) => o.order === scene.order && !consumed[i]);
    }
    if (index >= 0) {
      consumed[index] = true;
      matchIndex.set(scene.id, index);
    }
  }
  return matchIndex;
}

/**
 * Merge the planned outline and the persisted scenes into one display-order
 * page list (see the module doc for the exact matching/merging rules).
 */
export function mergeStageOutline(input: OutlineUnionInput): OutlineUnionEntry[] {
  const scenes = [...input.scenes].sort((a, b) => a.order - b.order);
  const planned = input.planned;

  // ── Phase 1: pair every real scene with the outline entry it was built from.
  // For an outlineId duplicated across the plan only its FIRST occurrence is
  // consumable by identity; every other scene falls back to order pairing.
  const matchIndex = matchOutlineEntries(scenes, planned);

  // ── Phase 2: build the entries. Real pages first (they carry the snapshot
  // brief they were matched to), then the still-planned pages — only while
  // generation is in progress.
  const entries: OutlineUnionEntry[] = scenes.map((scene) => {
    const index = matchIndex.get(scene.id);
    const outline = index !== undefined ? planned[index] : undefined;
    return {
      order: scene.order,
      title: scene.title,
      type: outlineTypeFromScene(scene.type),
      sceneId: scene.id,
      ...(scene.outlineId ? { outlineId: scene.outlineId } : {}),
      ...(outline
        ? {
            description: outline.description || scene.title,
            keyPoints: [...(outline.keyPoints ?? [])],
          }
        : { description: scene.title, keyPoints: [] }),
    };
  });
  if (input.generationComplete === false) {
    const consumed = new Array<boolean>(planned.length).fill(false);
    for (const index of matchIndex.values()) consumed[index] = true;
    for (let i = 0; i < planned.length; i += 1) {
      if (consumed[i]) continue;
      const outline = planned[i];
      entries.push({
        order: outline.order,
        title: outline.title,
        type: outline.type,
        planned: true,
        description: outline.description,
        keyPoints: [...(outline.keyPoints ?? [])],
      });
    }
  }

  // ── Phase 3: merge by order. Real pages come first at each order and
  // planned entries defer to the next display position; the sort is stable,
  // so same-key entries keep the construction order above.
  entries.sort(
    (a, b) => a.order - b.order || Number(Boolean(a.planned)) - Number(Boolean(b.planned)),
  );
  return entries;
}
