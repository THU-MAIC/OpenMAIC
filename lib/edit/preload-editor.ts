/**
 * Lazily load the editor chunk, keeping it out of the flag-off
 * classroom/playback bundle: `surfaces/slide` + `surfaces/quiz` register their
 * SceneEditorSurfaces into `sceneEditorRegistry` so EditShell can resolve them
 * (otherwise it falls back to NOOP_SURFACE, i.e. a read-only flash).
 *
 * Called from the Learn→Edit switch BEFORE flipping into edit mode, so the
 * surfaces are registered by the time EditShell reads the registry and the
 * edit chrome animates in with its content present; also from the idle
 * warm-up and, for a course remembered in Edit, alongside its document. The
 * promise is cached so repeated toggles, the warm-ups and any belt-and-
 * suspenders caller share one in-flight import.
 *
 * The slide font picker's fonts are not loaded here: a slide renders its
 * picked font everywhere, so the root layout declares them on every page
 * (`app/slide-fonts.ts`).
 */
let editorReady: Promise<void> | null = null;
let editorLoaded = false;

/**
 * Whether the editor chunk is ALREADY registered, answered synchronously.
 *
 * A hosted course can remember editing, so a remount there (a course switch, a
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
