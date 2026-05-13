import type { SceneType } from '@/lib/types/stage';
import type { SceneEditorRegistry, SceneEditorSurface } from './scene-editor-surface';

const surfaces = new Map<SceneType, SceneEditorSurface>();

export const sceneEditorRegistry: SceneEditorRegistry = {
  register: (surface) => {
    // Re-registering the same instance is benign (HMR re-executes module init
    // and the second pass passes the identical surface object). Only warn when
    // a different surface tries to take the slot, since that silently masks
    // bugs like accidental double-imports from divergent paths.
    const existing = surfaces.get(surface.sceneType);
    if (existing && existing !== surface && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[sceneEditorRegistry] overwriting existing surface for "${surface.sceneType}". ` +
          `If this is HMR, call unregister first.`,
      );
    }
    surfaces.set(surface.sceneType, surface as SceneEditorSurface);
  },
  unregister: (sceneType) => {
    surfaces.delete(sceneType);
  },
  resolve: (sceneType) => surfaces.get(sceneType),
};
