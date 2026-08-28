import { DocumentVersionError, type DocumentStore } from '@openmaic/storage';

import type { Scene, Stage } from '@/lib/types/stage';

/**
 * Incremental scene writes land only in already-current documents (see the
 * `DocumentVersionError` guard in `putScene`): a stale stored stamp means the
 * document's other scenes have not been lifted yet, and marking the whole
 * document current off one scene write would strand them below the
 * migrate-on-read line. A server tool hits that guard on its first write into
 * a course stored at an older DSL version, because the aggregate read
 * migrates in memory only — the stored stamp is still old.
 *
 * This wrapper is the server-side counterpart of the app autosave's
 * catch-and-full-save: on `not-current`, reload the (already migrated)
 * aggregate, splice the written scene in, and save the whole document, so the
 * current stamp is earned by an actually-run migration instead of being
 * asserted off one scene. Any other failure mode is rethrown untouched, and a
 * document that vanished between the failed write and the reload rethrows the
 * original error — nothing exists to bring current.
 */
export async function putSceneBringingCurrent(
  store: DocumentStore<Scene, Stage>,
  stageId: string,
  scene: Scene,
): Promise<void> {
  try {
    await store.putScene(stageId, scene);
    return;
  } catch (error) {
    if (!(error instanceof DocumentVersionError) || error.kind !== 'not-current') throw error;
    const doc = await store.loadDocument(stageId);
    if (!doc) throw error;
    const scenes = doc.scenes.filter((item) => item.id !== scene.id);
    scenes.push(scene);
    scenes.sort((a, b) => a.order - b.order);
    await store.saveDocument({ ...doc, scenes });
  }
}
