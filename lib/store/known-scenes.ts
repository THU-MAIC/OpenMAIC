/**
 * Which scenes of a course this tab has held, so a whole-document save can tell
 * a scene the user removed from one that reached the server without this tab
 * hearing of it (an agent's new page, whose sync signal is still on its way).
 *
 * A whole-document save replaces the stored scene list. A stored scene absent
 * from the list being saved was therefore deleted by this save, which is right
 * only if this tab knew of it. Held in memory per tab: a reload starts from what
 * it loads. A course this tab has no record of is saved as before.
 */
interface KnownScenes {
  /** Every scene this tab has held. */
  readonly known: Set<string>;
  /** The scenes the store holds now. */
  held: ReadonlySet<string>;
}

const scenesByStage = new Map<string, KnownScenes>();

/** The scene ids the store holds for the course now, whichever way they got there. */
export function recordKnownScenes(stageId: string, sceneIds: readonly string[]): void {
  const record = scenesByStage.get(stageId) ?? {
    known: new Set<string>(),
    held: new Set<string>(),
  };
  for (const sceneId of sceneIds) record.known.add(sceneId);
  record.held = new Set(sceneIds);
  scenesByStage.set(stageId, record);
}

/** These scenes are gone: an id written again later is a new scene to this tab. */
export function forgetKnownScenes(stageId: string, sceneIds: Iterable<string>): void {
  const record = scenesByStage.get(stageId);
  if (!record) return;
  for (const sceneId of sceneIds) record.known.delete(sceneId);
}

/** This tab reads the course anew: what it knew before no longer says anything. */
export function resetKnownScenes(stageId: string): void {
  scenesByStage.delete(stageId);
}

/** Stored scenes a save of `saved` would delete although this tab never knew of them. */
export function unseenScenes<TScene extends { readonly id: string }>(
  stageId: string,
  stored: readonly TScene[],
  saved: readonly { readonly id: string }[],
): TScene[] {
  const record = scenesByStage.get(stageId);
  if (!record) return [];
  const savedIds = new Set(saved.map((scene) => scene.id));
  return stored.filter((scene) => !savedIds.has(scene.id) && !record.known.has(scene.id));
}

/**
 * A whole-document save landed and removed these scenes. One the store holds
 * again by now (an undo, while the save was on the wire) is still known.
 */
export function settleKnownScenes(
  stageId: string,
  removed: readonly { readonly id: string }[],
): void {
  const held = scenesByStage.get(stageId)?.held;
  forgetKnownScenes(
    stageId,
    removed.map((scene) => scene.id).filter((sceneId) => !held?.has(sceneId)),
  );
}
