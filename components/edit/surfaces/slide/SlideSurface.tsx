import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { SlideContent } from '@/lib/types/stage';
import { SlideCanvas } from './SlideCanvas';
import { useSlideSurfaceState, type SlideSelection } from './use-slide-surface';

/**
 * The slide SceneEditorSurface. EditShell resolves this by scene type and
 * renders `SurfaceComponent` + reads `useSurfaceState()` into the command
 * bar / floating toolbar. The registered surface supplies the current text,
 * insert, image, z-order, geometry, and slide-management commands.
 */
export const slideSurface: SceneEditorSurface<SlideContent, SlideSelection> = {
  sceneType: 'slide',
  SurfaceComponent: SlideCanvas,
  useSurfaceState: useSlideSurfaceState,
};
