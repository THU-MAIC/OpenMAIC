/**
 * Telling our own saves apart from someone else's changes when the sync brings
 * a scene back.
 *
 * Every save replaces scene objects in the sync, so identity says nothing: a
 * scene read back may be the save that just landed, an OLDER save whose read was
 * overtaken by a newer local edit, or a real change by an agent. The storage
 * layer reports what it writes here, field by field, and the sync compares what
 * it reads against that and against what the browser now shows.
 *
 * The server stores content through its sanitizer and strips PBL learner state,
 * so what comes back is not byte for byte what went out (`<p style="">` returns as
 * `<p>`). Every comparison here is made on the form the server would hold.
 *
 * Agents that save a whole document move every scene's revision, so a read can
 * also bring back a scene nobody touched, older than an edit still waiting to be
 * saved. The value a scene held before its first unsaved edit is noted too: the
 * server still holding it is not a change.
 */

import { migrateScene } from '@/lib/edit/slide-schema';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
import { fieldFingerprint, sameField, trackedSceneFields } from '@/lib/edit/course-timeline';
import { pblSceneAsPersisted } from '@/lib/pbl/v2/runtime/document-persistence';
import type { Scene } from '@/lib/types/stage';

const WRITES_PER_FIELD = 32;
/**
 * A read can only be overtaken by a write that landed moments ago. Past this,
 * a server copy equal to one of our old saves is the server's real state (an
 * agent putting a page back), not an echo.
 */
const ECHO_WINDOW_MS = 15_000;

interface SceneWrites {
  lastWriteAt: number;
  readonly fields: Map<string, number[]>;
}

const writesByStage = new Map<string, Map<string, SceneWrites>>();
/** When each course last sent a save that adds, removes or moves pages. */
const structureWrittenAt = new Map<string, number>();

const serverFormByScene = new WeakMap<Scene, Scene>();

/** The scene as the server's sanitizer would store it. */
function serverForm(scene: Scene): Scene {
  let form = serverFormByScene.get(scene);
  if (!form) {
    form = sanitizeSceneContent(pblSceneAsPersisted(scene));
    serverFormByScene.set(scene, form);
  }
  return form;
}

function noteSceneValues(
  stageId: string,
  scenes: readonly Scene[],
  writtenAt: number | null,
): void {
  let stage = writesByStage.get(stageId);
  if (!stage) {
    stage = new Map();
    writesByStage.set(stageId, stage);
  }
  for (const scene of scenes.map(serverForm)) {
    let writes = stage.get(scene.id);
    if (!writes) {
      writes = { lastWriteAt: writtenAt ?? 0, fields: new Map() };
      stage.set(scene.id, writes);
    }
    if (writtenAt !== null) writes.lastWriteAt = writtenAt;
    for (const field of trackedSceneFields(scene)) {
      const value = (scene as unknown as Record<string, unknown>)[field];
      const fingerprint = fieldFingerprint(value);
      const seen = writes.fields.get(field) ?? [];
      if (seen[seen.length - 1] === fingerprint) continue;
      seen.push(fingerprint);
      if (seen.length > WRITES_PER_FIELD) seen.shift();
      writes.fields.set(field, seen);
    }
  }
}

/** Called by the storage layer with each scene it is about to send. */
export function noteScenesWritten(
  stageId: string,
  scenes: readonly Scene[],
  now = Date.now(),
): void {
  noteSceneValues(stageId, scenes, now);
}

/** Called with a scene about to take its first unsaved edit: what the server holds. */
export function noteSceneBeforeEdit(stageId: string, scene: Scene): void {
  noteSceneValues(stageId, [scene], null);
}

/** Called by the storage layer with a save that adds, removes or moves pages. */
export function noteStructureWritten(stageId: string, now = Date.now()): void {
  structureWrittenAt.set(stageId, now);
}

export function forgetSceneWrites(stageId: string): void {
  writesByStage.delete(stageId);
  structureWrittenAt.delete(stageId);
}

export interface FetchedScenesInput {
  readonly stageId: string;
  readonly current: readonly Scene[];
  readonly fetched: readonly Scene[];
  readonly removedIds: readonly string[];
  /** Pages the server has that this browser had not rendered yet. */
  readonly addedIds: readonly string[];
  /** An edit of this scene is queued or on its way to the server. */
  readonly isSceneDirty: (sceneId: string) => boolean;
  /** A page was added, removed or moved locally and is queued or on its way. */
  readonly structureDirty: boolean;
  readonly now?: number;
}

export interface ReconciledFetch {
  /** What to merge: the scene as it should be shown, `current` when nothing changes. */
  readonly fetched: readonly Scene[];
  readonly removedIds: readonly string[];
  /**
   * Scenes where this pass kept the local copy over the server's. Their rendered
   * revision must not advance, so a later pass reads them again: if the save this
   * was waiting for lands the revision moves, and if the server really holds that
   * copy it is taken once the echo window has passed.
   */
  readonly deferredIds: ReadonlySet<string>;
}

/**
 * Decide, field by field, what the sync may change.
 *
 * - Same as shown: an echo. Nothing changes, not even the object.
 * - A copy we wrote or held, while a write is pending or just landed: an older
 *   state read back. The newer local value stays.
 * - Anything else: a real change, taken even over an unsaved local edit, whose
 *   value then survives as the `before` of the agent's step on the timeline.
 */
export function reconcileFetchedScenes(input: FetchedScenesInput): ReconciledFetch {
  const now = input.now ?? Date.now();
  const writes = writesByStage.get(input.stageId);
  const currentById = new Map(input.current.map((scene) => [scene.id, scene]));
  const added = new Set(input.addedIds);
  const deferredIds = new Set<string>();
  const fetched: Scene[] = [];

  const lastStructureWrite = structureWrittenAt.get(input.stageId);
  // A read can be older than the save that moved a page or removed it.
  const structureSettling =
    input.structureDirty ||
    (lastStructureWrite !== undefined && now - lastStructureWrite < ECHO_WINDOW_MS);
  const wroteRecently = (sceneId: string) => {
    const lastWriteAt = writes?.get(sceneId)?.lastWriteAt;
    return lastWriteAt !== undefined && now - lastWriteAt < ECHO_WINDOW_MS;
  };
  const isOwnWrite = (sceneId: string, field: string, value: unknown) =>
    writes?.get(sceneId)?.fields.get(field)?.includes(fieldFingerprint(value)) ?? false;

  for (const raw of input.fetched) {
    const server = migrateScene(raw);
    const serverFields = server as unknown as Record<string, unknown>;
    const local = currentById.get(server.id);
    if (!local) {
      const ownCopy = trackedSceneFields(server).every((field) =>
        isOwnWrite(server.id, field, serverFields[field]),
      );
      const removedHere = structureSettling && !added.has(server.id);
      if (removedHere || (ownCopy && (structureSettling || wroteRecently(server.id)))) {
        deferredIds.add(server.id);
        continue;
      }
      fetched.push(server);
      continue;
    }
    const localFields = local as unknown as Record<string, unknown>;
    const localServerForm = serverForm(local) as unknown as Record<string, unknown>;
    const echoPossible = input.isSceneDirty(local.id) || wroteRecently(local.id);
    const kept: Record<string, unknown> = {};
    let taken = false;
    for (const field of new Set([...trackedSceneFields(local), ...trackedSceneFields(server)])) {
      if (sameField(localServerForm[field], serverFields[field])) {
        kept[field] = localFields[field];
      } else if (echoPossible && isOwnWrite(local.id, field, serverFields[field])) {
        kept[field] = localFields[field];
        deferredIds.add(local.id);
      } else {
        kept[field] = serverFields[field];
        taken = true;
      }
    }
    const order = structureSettling ? local.order : server.order;
    if (order !== server.order) deferredIds.add(local.id);
    if (!taken) {
      fetched.push(order === local.order ? local : { ...local, order });
      continue;
    }
    const merged: Record<string, unknown> = { ...server, order };
    for (const [field, value] of Object.entries(kept)) {
      if (value === undefined) delete merged[field];
      else merged[field] = value;
    }
    fetched.push(merged as unknown as Scene);
  }

  const removedIds = input.removedIds.filter((id) => {
    if (!currentById.has(id)) return true;
    if (structureSettling || wroteRecently(id)) {
      deferredIds.add(id);
      return false;
    }
    return true;
  });
  return { fetched, removedIds, deferredIds };
}
