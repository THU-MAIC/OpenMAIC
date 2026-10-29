/**
 * Lazily load the editor-only side effects, keeping them out of the
 * flag-off classroom/playback bundle:
 *   1. `surfaces/slide` + `surfaces/quiz` — register their SceneEditorSurfaces
 *      into `sceneEditorRegistry` so EditShell can resolve them (otherwise it
 *      falls back to NOOP_SURFACE, i.e. a read-only flash).
 *   2. `editor-fonts` — the @fontsource font-face tables the slide font
 *      picker offers (CSS side effect).
 *
 * Only (1) is awaited. Called from the Learn→Edit switch BEFORE flipping into
 * edit mode, so the surfaces are registered by the time EditShell reads the
 * registry and the edit chrome animates in with its content present. The
 * promise is cached so repeated toggles, the idle warm-up and any belt-and-
 * suspenders caller share one in-flight import.
 *
 * The fonts are requested once the surfaces settle and never awaited. They are
 * the bulk of the bytes, and awaiting them never guaranteed final metrics: the
 * stylesheets only declare `@font-face` rules (all `font-display: swap`), the
 * font files still download lazily on first use, and text boxes already
 * re-fit through the text element's ResizeObserver when a face swaps in.
 * Waiting held the first switch for seconds and, on HTTP/1.1, queued the
 * surface chunks behind the stylesheets. The tradeoff: a slide set in a picker
 * font may briefly render in the fallback face and swap when the stylesheet
 * lands.
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

let fontsRequested: Promise<unknown> | null = null;

/**
 * Request the picker fonts' stylesheets, once. Fire-and-forget: a failure only
 * leaves the fallback face showing, so it is logged and forgotten, and the next
 * `preloadEditor()` call asks again.
 */
function requestEditorFonts(): void {
  if (fontsRequested) return;
  const attempt = import('@/app/editor-fonts');
  fontsRequested = attempt;
  attempt.catch((error: unknown) => {
    if (fontsRequested === attempt) fontsRequested = null;
    console.warn('[edit] editor fonts failed to load; the picker falls back', error);
  });
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
  // After the surfaces, so their chunks are never queued behind the font
  // stylesheets; not part of what callers wait for.
  editorReady.then(requestEditorFonts, requestEditorFonts);
  return editorReady;
}
