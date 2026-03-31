/**
 * Shared prefill promise — set by classroom page when prefillMediaCache starts,
 * awaited by playback engine before starting so TTS audio is in IndexedDB first.
 */
let _prefillPromise: Promise<void> = Promise.resolve();

export function setPrefillPromise(p: Promise<void>): void {
  _prefillPromise = p;
}

export function getPrefillPromise(): Promise<void> {
  return _prefillPromise;
}
