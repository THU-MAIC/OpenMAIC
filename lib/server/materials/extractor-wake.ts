/**
 * The process's background material extractor, as the routes that start an
 * extraction reach it (an upload, a Retry): a wake makes it scan now instead
 * of at its next interval. Kept apart from the extractor so a route does not
 * load the extraction stack to wake it.
 */
export interface OwnerMaterialExtractorHandle {
  workerId: string;
  /** Scan now (an upload or a Retry started an extraction). */
  wake(): void;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

const EXTRACTOR_KEY = Symbol.for('openmaic.owner-materials.extractor');
const extractorState = globalThis as typeof globalThis & {
  [EXTRACTOR_KEY]?: OwnerMaterialExtractorHandle;
};

/** Ask this process's extractor to scan now (a no-op where none runs). */
export function wakeOwnerMaterialExtractor(): void {
  extractorState[EXTRACTOR_KEY]?.wake();
}

export function registerOwnerMaterialExtractor(handle: OwnerMaterialExtractorHandle): void {
  extractorState[EXTRACTOR_KEY] = handle;
}

export function unregisterOwnerMaterialExtractor(handle: OwnerMaterialExtractorHandle): void {
  if (extractorState[EXTRACTOR_KEY] === handle) delete extractorState[EXTRACTOR_KEY];
}
