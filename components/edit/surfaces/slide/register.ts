import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { slideSurface } from './SlideSurface';

// Side-effect registration. Imported once at app boot (via `stage.tsx`) so
// EditShell can resolve the slide surface the moment Pro mode is entered;
// the shell itself never imports surfaces directly.
sceneEditorRegistry.register(slideSurface);
