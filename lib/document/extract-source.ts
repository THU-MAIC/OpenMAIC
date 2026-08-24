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
 * Whether a non-ok asset-id extraction response should trigger the legacy byte
 * upload fallback.
 *
 * The asset-id form is free to retry only when the failure provably happened
 * BEFORE extraction ran and the byte form could succeed: a 404/401/503, a
 * store-unavailable 500, a body that cannot be parsed, or a 400 (a 400 may be
 * JSON-form-specific). A `PARSE_FAILED` response (422 or 500) means the
 * extractor already ran and deterministically failed — retrying would re-run a
 * paid external extraction and bill the provider twice for the same input — so
 * that response must be surfaced to the user instead. Two deterministic
 * pre-extraction failures are also surfaced without a retry because the byte
 * form repeats them identically: a 403 `INVALID_URL` (the SSRF guard rejects
 * the caller's baseUrl on both forms) and a 413 (the byte form enforces the
 * same 50 MB cap on the same bytes). Pure and testable: it only inspects the
 * response and never performs the fallback itself.
 *
 * One deliberate exception to the response-only rule lives one level up in
 * `fetchExtractionResponse`: a thrown network error retries with the byte form
 * even though the failure may have arrived while a paid extraction was already
 * running server-side. That risks a rare double bill, but it is accepted —
 * user success (still getting the extraction) wins over never billing twice.
 */
export async function shouldRetryWithByteUpload(response: Response): Promise<boolean> {
  if (response.ok) return false;
  // A 413 repeats identically on the byte form (the same 50 MB cap runs on the
  // same bytes), so it never retries — even if the body does not parse.
  if (response.status === 413) return false;
  let body: { errorCode?: unknown } | null = null;
  try {
    body = (await response.clone().json()) as { errorCode?: unknown };
  } catch {
    // Unparseable body: there is no error code to prove extraction ran, so
    // treat the failure as pre-extraction and retry with the bytes.
    return true;
  }
  const errorCode = body?.errorCode;
  // A 403 INVALID_URL is the SSRF guard rejecting the caller's baseUrl; the
  // byte form runs the same check on the same baseUrl, so it fails identically.
  if (response.status === 403 && errorCode === 'INVALID_URL') return false;
  return errorCode !== 'PARSE_FAILED';
}

/**
 * Per-source decision between the asset-id JSON form and the legacy byte form.
 *
 * When a server-backed pool allocated an asset id for this source, try the
 * asset-id form first. A pre-extraction failure (see
 * `shouldRetryWithByteUpload`) or a thrown network error logs the failure and
 * retries this source via the legacy multipart byte upload before giving up;
 * a `PARSE_FAILED` response is surfaced as-is because the extractor already
 * ran and the retry would re-bill it. Only when the byte form is also
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
      if (await shouldRetryWithByteUpload(response)) {
        options.logWarning(
          `Asset-id extraction returned ${response.status}; falling back to byte upload.`,
        );
        return options.fetchers.submitByteForm();
      }
      // PARSE_FAILED: the extractor already ran and will fail identically on a
      // byte retry, re-billing the provider. Surface the response unchanged.
      options.logWarning(
        `Asset-id extraction returned ${response.status} PARSE_FAILED; surfacing the error without a byte retry.`,
      );
      return response;
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
 * Time budget for the pre-generation ingest drain. A stalled server-backed
 * `put` must not hang the Generate click; after this budget the unsettled
 * ingests are released (see `awaitPendingIngests`) and generation proceeds
 * with those sources on the byte path.
 */
export const DEFAULT_INGEST_AWAIT_TIMEOUT_MS = 15_000;

export interface AwaitPendingIngestsOptions {
  /** Time budget for the batch; defaults to {@link DEFAULT_INGEST_AWAIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Invoked once per ingest that is still unsettled when the budget expires.
   * The caller attaches a release (`removeAsset`) to the late-resolving
   * promise: once the session is built without the id, no durable holder will
   * ever exist for it.
   */
  onUnsettled?: (ingestId: string, ingest: Promise<string>) => void;
}

/**
 * Await every upload-time ingest still in flight, bounded by a time budget.
 *
 * Used by the generate flow before it builds the generation session, so a
 * resolved asset id lands in the session instead of being dropped when the
 * page unmounts. Rejected ingests are awaited too — a rejected ingest only
 * means that source proceeds with its storageKey and the byte path.
 *
 * The await is bounded: a stalled server-backed PUT must not hang generation
 * forever. When the budget expires, the ids of the still-unsettled ingests are
 * returned (the caller skips them so the session sends those sources down the
 * byte path) and each is handed to `onUnsettled` so the caller can attach a
 * release to the late-resolving id. Returns an empty set when the whole batch
 * settled in time.
 */
export async function awaitPendingIngests(
  pendingIngests: ReadonlyMap<string, Promise<string>>,
  options: AwaitPendingIngestsOptions = {},
): Promise<Set<string>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INGEST_AWAIT_TIMEOUT_MS;
  const entries = [...pendingIngests.entries()];
  if (entries.length === 0) return new Set();

  // Track which entries settle before the budget expires. Both branches mark
  // the id so a late rejection cannot become an unhandled rejection.
  const settledIds = new Set<string>();
  for (const [id, ingest] of entries) {
    void ingest.then(
      () => settledIds.add(id),
      () => settledIds.add(id),
    );
  }

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const handle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    void Promise.allSettled(entries.map(([, ingest]) => ingest)).finally(() =>
      clearTimeout(handle),
    );
  });
  await Promise.race([Promise.allSettled(entries.map(([, ingest]) => ingest)), timeout]);

  if (!timedOut) return new Set();

  const unsettled = new Set<string>();
  for (const [id, ingest] of entries) {
    if (settledIds.has(id)) continue;
    unsettled.add(id);
    options.onUnsettled?.(id, ingest);
  }
  return unsettled;
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
