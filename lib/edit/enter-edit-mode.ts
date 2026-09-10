interface EnterEditModeOptions {
  /**
   * Quiesce the playback chrome (SSE stream, engine, TTS audio) before the
   * mode flip, so it never unmounts mid-playback.
   */
  teardown: () => Promise<void> | undefined;
  /**
   * Load the editor chunk (fonts + slide surface) before the mode flip so
   * the edit chrome animates in with its content already present. The import
   * is promise-cached, so this is a no-op on subsequent toggles.
   */
  preload: () => Promise<unknown>;
  /** Make edit mode visible once teardown and preload have both succeeded. */
  activate: () => void;
  /** Called if teardown or preload throws; the caller stays in playback. */
  onError: (error: unknown) => void;
}

/**
 * Coordinate the playback → edit transition: run teardown and preload in
 * parallel, then activate edit mode only when both succeed. Returns `false`
 * (without calling `activate`) when either step throws, so the caller can
 * surface the failure from the still-playback UI.
 */
export async function enterEditMode({
  teardown,
  preload,
  activate,
  onError,
}: EnterEditModeOptions): Promise<boolean> {
  try {
    await Promise.all([teardown(), preload()]);
  } catch (error) {
    onError(error);
    return false;
  }

  activate();
  return true;
}
