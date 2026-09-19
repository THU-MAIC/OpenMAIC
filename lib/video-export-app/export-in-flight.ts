/**
 * Shared, cross-hook "one export operation at a time" guard.
 *
 * Every browser-side export path — the ZIP build ({@link useExportVideo}) and the
 * subtitles-only download ({@link useDownloadSubtitles}) — funnels through
 * `compileStageIr`, which reads the live stage store, hits Dexie, and (for the
 * ZIP) drives off-screen renders. Running two at once would read/mutate the same
 * state and duplicate that work, so they must be mutually exclusive.
 *
 * This is a **module singleton**, not a per-hook ref: the export UI unmounts as
 * soon as its dropdown/dialog closes, which would reset a per-instance ref to
 * false and let a second pipeline start. A module-level flag survives remounts
 * and is shared across every export hook, so acquiring it here excludes the
 * others too. (The in-app render path has its own equivalent guard in the render
 * store's `status`.)
 */
let inFlight = false;

/**
 * Try to enter the export critical section. Returns true when acquired (the
 * caller must later {@link releaseExport}); false when another export already
 * holds it and the caller should bail out.
 */
export function acquireExport(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

/** Leave the export critical section. Call in a `finally` after {@link acquireExport}. */
export function releaseExport(): void {
  inFlight = false;
}
