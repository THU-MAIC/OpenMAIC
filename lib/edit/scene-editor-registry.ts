import type { SceneType } from '@/lib/types/stage';
import type { SceneEditorRegistry, SceneEditorSurface } from './scene-editor-surface';

const surfaces = new Map<SceneType, SceneEditorSurface>();

export const sceneEditorRegistry: SceneEditorRegistry = {
  register: (surface) => {
    surfaces.set(surface.sceneType, surface as SceneEditorSurface);
  },
  resolve: (sceneType) => surfaces.get(sceneType),
};
