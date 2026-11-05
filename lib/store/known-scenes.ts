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
const knownByStage = new Map<string, Set<string>>();

/** Every scene id the store holds for the course, whichever way it got there. */
export function recordKnownScenes(stageId: string, sceneIds: Iterable<string>): void {
  const known = knownByStage.get(stageId) ?? new Set<string>();
  for (const sceneId of sceneIds) known.add(sceneId);
  knownByStage.set(stageId, known);
}

/** These scenes are gone: an id written again later is a new scene to this tab. */
export function forgetKnownScenes(stageId: string, sceneIds: Iterable<string>): void {
  const known = knownByStage.get(stageId);
  if (!known) return;
  for (const sceneId of sceneIds) known.delete(sceneId);
}

/** This tab reads the course anew: what it knew before no longer says anything. */
export function resetKnownScenes(stageId: string): void {
  knownByStage.delete(stageId);
}

/** Stored scenes a save of `saved` would delete although this tab never knew of them. */
export function unseenScenes<TScene extends { readonly id: string }>(
  stageId: string,
  stored: readonly TScene[],
  saved: readonly { readonly id: string }[],
): TScene[] {
  const known = knownByStage.get(stageId);
  if (!known) return [];
  const savedIds = new Set(saved.map((scene) => scene.id));
  return stored.filter((scene) => !savedIds.has(scene.id) && !known.has(scene.id));
}

/** A whole-document save landed: it holds `saved`, and what it deleted is gone. */
export function settleKnownScenes(
  stageId: string,
  stored: readonly { readonly id: string }[],
  saved: readonly { readonly id: string }[],
): void {
  const savedIds = new Set(saved.map((scene) => scene.id));
  forgetKnownScenes(
    stageId,
    stored.filter((scene) => !savedIds.has(scene.id)).map((scene) => scene.id),
  );
  if (knownByStage.has(stageId)) recordKnownScenes(stageId, savedIds);
}
