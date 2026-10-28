'use client';

import { useCallback, useEffect } from 'react';
import { isEditorPreloaded, preloadEditor } from '@/lib/edit/preload-editor';

/** Upper bound on the idle wait, so a busy main thread cannot starve the warm-up. */
const IDLE_TIMEOUT_MS = 3000;
/** Without `requestIdleCallback` (Safari), wait out the first paint and settle. */
const FALLBACK_DELAY_MS = 1000;

/**
 * Start loading the editor chunk without waiting for it. Shares the cached
 * import with the real switch, so it is a no-op once the editor is loaded or
 * loading. A failure is logged and swallowed: `preloadEditor` forgets it, so the
 * real Learn→Edit switch retries the import and surfaces any error itself.
 */
export function warmEditor(): void {
  preloadEditor().catch((error: unknown) => {
    console.warn('[edit] editor warm-up failed; the next Edit switch retries', error);
  });
}

function onIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, FALLBACK_DELAY_MS);
  return () => window.clearTimeout(handle);
}

/**
 * Warm the editor while a classroom sits in Learn mode with editing allowed,
 * so the first switch to Edit does not wait on the editor chunk download.
 *
 * Loads once the browser is idle, and returns a handler for the Edit control's
 * pointerenter/focus to start it sooner. Both do nothing while `enabled` is
 * false (generating, not the owner, read-only, hidden), so an uneditable
 * course never pays for the editor.
 */
export function useEditorWarmup(enabled: boolean): () => void {
  useEffect(() => {
    if (!enabled || isEditorPreloaded()) return;
    return onIdle(warmEditor);
  }, [enabled]);

  return useCallback(() => {
    if (enabled) warmEditor();
  }, [enabled]);
}
