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
let editorLoaded = false;

/**
 * Whether the editor chunk is ALREADY registered, answered synchronously.
 *
 * The workspace pane is edit-locked, so a remount there (a course switch, a
 * reopened tab) must be able to resolve straight to the edit chrome during
 * render. Waiting for `preloadEditor()` to resolve again would cost a paint of
 * the neutral loading shell for an import that finished long ago.
 */
export function isEditorPreloaded(): boolean {
  return editorLoaded;
}

export function preloadEditor(): Promise<void> {
  if (!editorReady) {
    const attempt = Promise.all([
      import('@/app/editor-fonts'),
      import('@/components/edit/surfaces/slide'),
      import('@/components/edit/surfaces/quiz'),
    ]).then(() => {
      editorLoaded = true;
    });
    editorReady = attempt;
    // A cached REJECTION would be permanent, and the edit-locked pane has no
    // learning chrome to fall back to — it would sit on the neutral shell for
    // the rest of the session. Forget the failed attempt so the next hosted
    // classroom retries the import. The extra handler only clears the cache;
    // the rejection itself still reaches whoever awaited `attempt`.
    attempt.catch(() => {
      if (editorReady === attempt) editorReady = null;
    });
  }
  return editorReady;
}
