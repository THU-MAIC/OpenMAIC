import type { ManifestScene } from '../classroom-zip-types';

/**
 * Order scenes the way the classroom plays them: by `order`, stable on ties.
 * Shared by the export and the player bundle, so it stays dependency-free.
 */
export function orderManifestScenes<T extends Pick<ManifestScene, 'order'>>(
  scenes: readonly T[],
): T[] {
  return scenes
    .map((scene, index) => ({ scene, index }))
    .sort((a, b) => (a.scene.order ?? 0) - (b.scene.order ?? 0) || a.index - b.index)
    .map(({ scene }) => scene);
}
