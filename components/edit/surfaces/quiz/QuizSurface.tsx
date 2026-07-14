import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { QuizContent } from '@/lib/types/stage';
import { QuizForm } from './QuizForm';
import { useQuizSurfaceState, type QuizSelection } from './use-quiz-surface';

/**
 * The quiz SceneEditorSurface — the second surface after slide, and the proof
 * that the contract carries a non-canvas, structured/form editor. EditShell
 * resolves this by `scene.type` and renders `SurfaceComponent` (a form, not a
 * canvas) + reads `useSurfaceState()` into the chrome. The surface contributes
 * undo/redo; adding and editing questions both stay inline in the form (no
 * floating bar, no selection model).
 */
export const quizSurface: SceneEditorSurface<QuizContent, QuizSelection> = {
  sceneType: 'quiz',
  SurfaceComponent: QuizForm,
  useSurfaceState: useQuizSurfaceState,
};
