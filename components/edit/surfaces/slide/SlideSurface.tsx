import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { SlideContent } from '@/lib/types/stage';
import { SlideCanvas } from './SlideCanvas';
import { useSlideSurfaceState, type SlideSelection } from './use-slide-surface';

/**
 * The slide SceneEditorSurface. EditShell resolves this by scene type and
 * renders `SurfaceComponent` + reads `useSurfaceState()` into the command
 * bar / floating toolbar. PR1 ships geometry editing only; text / insert /
 * image / z-order / slide management land in later sub-PRs.
 */
export const slideSurface: SceneEditorSurface<SlideContent, SlideSelection> = {
  sceneType: 'slide',
  SurfaceComponent: SlideCanvas,
  useSurfaceState: useSlideSurfaceState,
};
