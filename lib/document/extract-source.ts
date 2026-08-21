/**
 * Client-side extraction-input selection and upload-time ingest helpers.
 *
 * These are the small, pure pieces of the part-0 upload/extract flow that the
 * page components delegate to so the fallback and await logic stays testable
 * without a component harness.
 */

/** The two ways a source's bytes can reach the extract route. */
export interface ExtractSourceFetchers {
  /**
   * Runs the asset-id (JSON) extraction form. Only meaningful when the
   * deployment's asset pool is server-backed and the source has an asset id.
   * Throws on network errors.
   */
  submitAssetIdForm: () => Promise<Response>;
  /**
   * Runs the legacy multipart byte upload. Throws when no bytes are available
   * for this source.
   */
  submitByteForm: () => Promise<Response>;
}

export interface FetchExtractionResponseOptions {
  /**
   * Whether the deployment's asset pool is server-backed. The probe is read
   * once per generation run; the per-source decision below is per-source.
   */
  serverBacked: boolean;
  /** Whether this source carries an allocated asset id. */
  hasAssetId: boolean;
  fetchers: ExtractSourceFetchers;
  /** Client-side log sink for the fallback decision. */
  logWarning: (message: string, ...args: unknown[]) => void;
}

/**
 * Per-source decision between the asset-id JSON form and the legacy byte form.
 *
 * When a server-backed pool allocated an asset id for this source, try the
 * asset-id form first. If it fails for ANY reason — a non-ok response or a
 * thrown network error — log the failure and retry this source via the legacy
 * multipart byte upload before giving up. Only when the byte form is also
 * unavailable (its fetcher throws because no bytes exist) does the caller
 * surface an error, so the user is only shown a failure once both forms have
 * failed. Browser-backed pools (or sources without an asset id) go straight to
 * the byte form, exactly as before part 0.
 */
export async function fetchExtractionResponse(
  options: FetchExtractionResponseOptions,
): Promise<Response> {
  if (options.serverBacked && options.hasAssetId) {
    try {
      const response = await options.fetchers.submitAssetIdForm();
      if (response.ok) return response;
      options.logWarning(
        `Asset-id extraction returned ${response.status}; falling back to byte upload.`,
      );
    } catch (error) {
      options.logWarning('Asset-id extraction failed; falling back to byte upload:', error);
    }
  }
  // Legacy byte upload: the only form for browser-backed pools, and the
  // fallback for a failed asset-id form. Its fetcher throws when no bytes are
  // available for this source.
  return options.fetchers.submitByteForm();
}

/**
 * Await every upload-time ingest still in flight.
 *
 * Used by the generate flow before it builds the generation session, so a
 * resolved asset id lands in the session instead of being dropped when the
 * page unmounts. Rejected ingests are awaited too — a rejected ingest only
 * means that source proceeds with its storageKey and the byte path.
 */
export async function awaitPendingIngests(
  pendingIngests: ReadonlyMap<string, Promise<string>>,
): Promise<void> {
  const pending = [...pendingIngests.values()];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}

/**
 * The settled asset id for one source's ingest, if it resolved.
 *
 * The ingest patches the asset id into form state via `setForm`, which a
 * closure captured before the patch commits may not reflect yet. Reading the
 * settled promise from the pending map is the airtight source of truth for the
 * resolved id regardless of React commit timing. Returns `undefined` when the
 * ingest is missing or was rejected.
 */
export async function resolvedAssetIdForIngest(
  pendingIngests: ReadonlyMap<string, Promise<string>>,
  id: string,
): Promise<string | undefined> {
  const pending = pendingIngests.get(id);
  if (!pending) return undefined;
  try {
    return await pending;
  } catch {
    return undefined;
  }
}
