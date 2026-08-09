/**
 * Lazily load the editor-only side effects, keeping them out of the
 * flag-off classroom/playback bundle:
 *   1. `editor-fonts` — ~23 @fontsource font-face tables the slide font
 *      picker needs (CSS side effect).
 *   2. `surfaces/slide` + `surfaces/quiz` — register their SceneEditorSurfaces
 *      into `sceneEditorRegistry` so EditShell can resolve them (otherwise it
 *      falls back to NOOP_SURFACE, i.e. a read-only flash).
 *
 * Called from the Pro Switch handler BEFORE flipping into edit mode, so
 * the dynamic chunk is already downloaded/registered by the time the
 * edit chrome mounts and animates in — no mid-animation "content pops in"
 * jank, and the slide surface is registered before EditShell reads the
 * registry. The promise is cached so repeated toggles and any belt-and-
 * suspenders caller share one in-flight import.
 */
let editorReady: Promise<void> | null = null;

export function preloadEditor(): Promise<void> {
  if (!editorReady) {
    editorReady = Promise.all([
      import('@/app/editor-fonts'),
      import('@/components/edit/surfaces/slide'),
      import('@/components/edit/surfaces/quiz'),
    ]).then(() => undefined);
  }
  return editorReady;
}
