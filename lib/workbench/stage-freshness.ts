'use client';

/**
 * The canvas's narrow freshness read path (Mono #1960 Part 2).
 *
 * The old `useWorkbenchCourseSync` re-read the WHOLE document on every
 * checkpoint (`loadDocument` → ~100kB p50 / 199kB p90) and replaced the
 * entire `scenes` array. This module is the other half of the replacement:
 * pure client functions for the manifest diff and the batch scene fetch, kept
 * free of React so the acceptance suite can drive them (and the sync hook in
 * `use-workbench-session.ts`) against mocked fetches.
 *
 * The contract with the server:
 *   GET /api/stages/:id/manifest              → {rev, scenes:[{id,order,rev}]}
 *   GET /api/stages/:id/scenes?ids=a,b,c      → {scenes:[Scene]}
 *
 * Revision comparison is `!==`, not `>`: revs never roll back today (Part 1
 * guarantees it), but inequality is more robust and costs nothing.
 *
 * Two failure-mode distinctions live here (cr D1-F2 / D3-F1):
 *   - manifest availability is a tri-state (`ManifestFetchResult`): STRUCTURAL
 *     missing (self-hosted / 404 — no server state to protect) is different
 *     from a TRANSIENT failure (-live 5xx / network — the server MAY hold
 *     newer content, so writes must not sail through);
 *   - the batch scene fetch chunks ids below the server's per-request cap, so
 *     a real course of a few hundred scenes never trips the endpoint's 400.
 */
import type { Scene } from '@/lib/types/stage';

export interface StageManifestScene {
  id: string;
  order: number;
  rev: number;
}

export interface StageManifest {
  rev: number;
  scenes: StageManifestScene[];
}

/** A scene id that changed, was added, or disappeared since the last render. */
export interface StageManifestDiff {
  /** Present in both, but rev or order differs. */
  readonly changed: readonly string[];
  /** Present in the fresh manifest but not in the rendered one. */
  readonly added: readonly string[];
  /** Present in the rendered manifest but not in the fresh one. */
  readonly removed: readonly string[];
}

/** `null` rendered manifest (first sync) treats every live scene as new. */
export function diffStageManifest(
  rendered: StageManifest | null,
  fresh: StageManifest,
): StageManifestDiff {
  if (!rendered) {
    return { changed: [], added: fresh.scenes.map((s) => s.id), removed: [] };
  }
  const renderedById = new Map(rendered.scenes.map((s) => [s.id, s]));
  const changed: string[] = [];
  const added: string[] = [];
  for (const scene of fresh.scenes) {
    const previous = renderedById.get(scene.id);
    if (!previous) {
      added.push(scene.id);
    } else if (previous.rev !== scene.rev || previous.order !== scene.order) {
      changed.push(scene.id);
    }
  }
  const freshIds = new Set(fresh.scenes.map((s) => s.id));
  const removed = rendered.scenes.map((s) => s.id).filter((id) => !freshIds.has(id));
  return { changed, added, removed };
}

/**
 * The manifest fetch answer, classified by what a caller may conclude.
 *
 * - `ok` — a real manifest; compare against the store's baseline.
 * - `missing` — STRUCTURAL absence: self-hosted builds (no PG — the endpoint
 *   cannot exist) and 404 (no such course / tombstoned). There is no older
 *   server state to protect, so save paths may proceed (fail open).
 * - `transient` — a retryable failure (-live 5xx / network error / malformed
 *   body): the server MAY hold newer content this browser has not seen, so
 *   save paths must NOT proceed; the freshness sync retries on its clock.
 *
 * The two are deliberately NOT collapsed into one "unavailable": a
 * self-hosted save that "deferred on failure" would never land (its manifest
 * is structurally missing forever), while a -live save that fail-opens on a
 * transient 5xx could delete agent-committed pages (cr D1-F2).
 */
export type ManifestFetchResult =
  | { status: 'ok'; manifest: StageManifest }
  | { status: 'missing' }
  | { status: 'transient' };

/**
 * Fetch the freshness manifest. Never throws: network errors and bad answers
 * come back as `{status:'transient'}` so the caller can tell them apart from
 * a structural `{status:'missing'}` (404 — no server state to protect).
 *
 * Upstream adaptation: the reference short-circuited on `!isLiveMode` (a
 * live-demo-only flag, dropped per the porting rules); the upstream host has
 * no such flag, so every request is attempted and a 404 (the current state
 * while the stage manifest/scenes routes do not exist yet) classifies as
 * `missing`, which fail-opens exactly like the reference's non-live branch.
 */
export async function fetchStageManifest(stageId: string): Promise<ManifestFetchResult> {
  try {
    const response = await fetch(`/api/stages/${encodeURIComponent(stageId)}/manifest`, {
      credentials: 'include',
    });
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'transient' };
    const body = (await response.json()) as StageManifest;
    return Array.isArray(body.scenes) ? { status: 'ok', manifest: body } : { status: 'transient' };
  } catch {
    return { status: 'transient' };
  }
}

/**
 * Upper bound for ONE batch request — the server's own cap on `?ids=` (the
 * `MAX_BATCH_SCENE_IDS` of the scenes route). The client chunks below it so a
 * real course of a few hundred scenes never trips the endpoint's 400 (cr
 * D3-F1); the server cap itself stays as the anti-abuse bound.
 */
const SCENE_BATCH_CHUNK_IDS = 200;

/**
 * Fetch exactly the requested scenes. The ids are split into ≤200-id chunks
 * and fetched concurrently; a chunk that fails (non-OK / malformed) simply
 * contributes no scenes, and the caller keeps those ids out of its rendered
 * manifest so the next diff retries them (partial failure is fine — cr
 * D3-F3). A response where EVERY chunk failed resolves `[]`, which the caller
 * must treat as "could not fetch, do not advance the baseline" (cr D3-F1).
 */
export async function fetchScenesByIds(stageId: string, ids: readonly string[]): Promise<Scene[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += SCENE_BATCH_CHUNK_IDS) {
    chunks.push(ids.slice(i, i + SCENE_BATCH_CHUNK_IDS));
  }
  const perChunk = await Promise.all(chunks.map((chunk) => fetchSceneChunk(stageId, chunk)));
  return perChunk.flat();
}

async function fetchSceneChunk(stageId: string, ids: readonly string[]): Promise<Scene[]> {
  const params = new URLSearchParams({ ids: ids.join(',') });
  const response = await fetch(
    `/api/stages/${encodeURIComponent(stageId)}/scenes?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { scenes?: unknown };
  return Array.isArray(body.scenes) ? (body.scenes as Scene[]) : [];
}

/**
 * Merge fetched scenes into the current scene list with a STABLE array
 * reference — the third of the three standard features (stable references): a pass
 * that changes nothing returns the SAME array object, so React consumers that
 * memoize on `scenes` do not re-render a deck the agent did not touch.
 *
 * Removed ids are dropped; fetched scenes replace by id; the result is sorted
 * by `order` exactly like the full document read. There is no edit-state
 * protection anymore (#1961 decision change 2026-08-23): the agent's fresh version
 * replaces the local scene outright — the user's typed data is guarded on the
 * WRITE side instead (a veto retains the dirt and retries; see
 * `lib/store/stage.ts`), not by freezing the read side.
 *
 * Returns `{scenes, changed}` where `changed` is `false` (and `scenes` the
 * input array) when nothing would be different.
 */
export function mergeFetchedScenes(input: {
  readonly current: readonly Scene[];
  readonly fetched: readonly Scene[];
  readonly removedIds: readonly string[];
}): { scenes: readonly Scene[]; changed: boolean } {
  const removedSet = new Set(input.removedIds);
  const fetchedById = new Map(input.fetched.map((s) => [s.id, s]));

  const merged: Scene[] = [];
  for (const scene of input.current) {
    if (removedSet.has(scene.id)) continue;
    merged.push(fetchedById.get(scene.id) ?? scene);
  }
  for (const scene of input.fetched) {
    if (removedSet.has(scene.id)) continue;
    if (!input.current.some((s) => s.id === scene.id)) merged.push(scene);
  }
  merged.sort((a, b) => a.order - b.order);

  if (merged.length !== input.current.length) return { scenes: merged, changed: true };
  for (let i = 0; i < merged.length; i += 1) {
    const before = input.current[i];
    const after = merged[i];
    if (before === after && before.id === after.id) continue;
    if (before.id !== after.id || before !== after) return { scenes: merged, changed: true };
  }
  return { scenes: input.current, changed: false };
}

/** True when every requested id has a matching entry — used by the tests. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}
