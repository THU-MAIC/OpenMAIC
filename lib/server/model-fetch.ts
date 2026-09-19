/**
 * Model-list fetching for OpenAI-compatible providers.
 *
 * Ported from cc-switch `src-tauri/src/services/model_fetch.rs`. The core value
 * is `buildModelsUrlCandidates`: token-plan / aggregator base URLs come in many
 * shapes, so we generate an ordered candidate list (with an Anthropic-compat
 * suffix-strip fallback) and try each until one returns a model list.
 */

/** A model id discovered from a provider's /models endpoint. */
export interface FetchedModel {
  id: string;
  ownedBy?: string;
}

/**
 * Known "Anthropic-compatible subpath" suffixes. When a base URL ends with one
 * of these, candidates also include the suffix-stripped root + /v1/models and
 * /models. Ordered longest-first so `/api/anthropic` wins over `/anthropic`.
 */
const KNOWN_COMPAT_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
] as const;

const FETCH_TIMEOUT_MS = 15_000;
// Preserve the existing per-attempt allowance, with one retry and a finite
// budget shared by every candidate and attempt in a discovery operation.
const DISCOVERY_TIMEOUT_MS = 2 * FETCH_TIMEOUT_MS;

function discoveryTimeout(): DOMException {
  return new DOMException('Model discovery timed out', 'TimeoutError');
}

/** Whether the URL's last path segment is an OpenAI-style version segment `/v{N}`. */
function endsWithVersionSegment(url: string): boolean {
  const last = url.split('/').pop() ?? '';
  if (!last.startsWith('v')) return false;
  const digits = last.slice(1);
  return digits.length > 0 && /^\d+$/.test(digits);
}

/** If the URL ends with a known compat suffix, returns the stripped remainder. */
function stripCompatSuffix(baseUrl: string): string | null {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) {
      return baseUrl.slice(0, baseUrl.length - suffix.length);
    }
  }
  return null;
}

/**
 * Builds the ordered list of candidate `/models` URLs for a base URL.
 *
 * Order:
 * 1. `modelsUrlOverride` (if provided) — sole candidate
 * 2. `{base}/v1/models`; or `{base}/models` when base ends in a version segment
 *    (`/v1`, `.../paas/v4`), plus `{base}/v1/models` fallback when that segment
 *    is not `/v1`
 * 3. If base hits a known Anthropic-compat suffix, the stripped root +
 *    `/v1/models` and `/models`
 *
 * Deduped, order-preserving. Throws on an empty base URL.
 */
export function buildModelsUrlCandidates(
  baseUrl: string,
  opts: { modelsUrlOverride?: string } = {},
): string[] {
  const override = opts.modelsUrlOverride?.trim();
  if (override) return [override];

  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Base URL is empty');

  const candidates: string[] = [];

  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith('/v1')) {
      candidates.push(`${trimmed}/v1/models`);
    }
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped) {
    const root = stripped.replace(/\/+$/, '');
    if (root && root.includes('://')) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }

  // Linear dedupe preserving first occurrence (≤4 candidates).
  return candidates.filter((url, i) => candidates.indexOf(url) === i);
}

interface ModelsApiResponse {
  data?: Array<{ id: string; owned_by?: string }>;
}

/**
 * Fetches the model list by trying each candidate URL in order. A 404/405 means
 * "wrong path" and moves on to the next candidate; any other non-2xx is returned
 * as an error immediately (e.g. 401 = bad key, surfaced to the caller verbatim).
 *
 * Throws on network failure or when all candidates 404. The caller (probe route)
 * is responsible for SSRF validation of `baseUrl` before calling this.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  opts: { modelsUrlOverride?: string } = {},
): Promise<FetchedModel[]> {
  const candidates = buildModelsUrlCandidates(baseUrl, opts);

  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  let retried = false;

  for (const url of candidates) {
    let body: ModelsApiResponse | null;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw discoveryTimeout();
      try {
        body = await fetchModelsCandidate(url, apiKey, Math.min(FETCH_TIMEOUT_MS, remaining));
        break;
      } catch (error) {
        // HTTP errors and malformed JSON are terminal. Only a transport failure
        // or our deadline gets one retry, shared across all candidate URLs.
        if (
          retried ||
          Date.now() >= deadline ||
          !(
            error instanceof TypeError ||
            (error instanceof DOMException && error.name === 'TimeoutError')
          )
        ) {
          throw error;
        }
        retried = true;
      }
    }
    if (body === null) continue;
    return (body.data ?? [])
      .map((m) => ({ id: m.id, ownedBy: m.owned_by }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  throw new ModelFetchError(404, `No /models endpoint found (tried: ${candidates.join(', ')})`);
}

/** The timer owns the entire finite response, including JSON/error-body reads. */
async function fetchModelsCandidate(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<ModelsApiResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(discoveryTimeout()), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new ModelFetchError(res.status, 'Redirects are not allowed');
    }
    if (res.ok) return (await res.json()) as ModelsApiResponse;
    if (res.status === 404 || res.status === 405) return null;

    // A stalled error body must not hide an already-known authentication/HTTP
    // status, or turn a terminal HTTP error into a retryable timeout.
    const text = await res.text().catch(() => '');
    throw new ModelFetchError(res.status, `HTTP ${res.status}: ${text.slice(0, 512)}`);
  } catch (error) {
    if (error instanceof ModelFetchError) throw error;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    // Release unread redirect/404/405 bodies before trying another endpoint.
    controller.abort();
  }
}

/** Error carrying the upstream HTTP status so the route can map it (401 vs 404). */
export class ModelFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelFetchError';
  }
}
