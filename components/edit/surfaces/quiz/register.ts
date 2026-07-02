import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { quizSurface } from './QuizSurface';

// Side-effect registration. Imported once at app boot (via `preload-editor`)
// so EditShell can resolve the quiz surface the moment Pro mode is entered on
// a quiz scene; the shell itself never imports surfaces directly.
sceneEditorRegistry.register(quizSurface);
