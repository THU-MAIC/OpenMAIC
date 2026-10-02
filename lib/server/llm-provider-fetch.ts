/**
 * The pinned transport for LLM calls to a caller-chosen endpoint (a
 * client-supplied base URL or an unmanaged provider's catalog default).
 */
import { STATUS_CODES } from 'node:http';

import { LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import { findUnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';
import { isRejectedRedirectError } from '@/lib/utils/rejected-redirect';

const log = createLogger('LLM Provider Fetch');

// A caller-chosen endpoint runs under the operator address policy (the one
// `validateUrlForSSRF` applied: `allowLocalNetworks` unset falls back to
// ALLOW_LOCAL_NETWORKS) on the strict transport, which pins the connect address
// to the vetted DNS answers and refuses a 3xx. The pinned dispatcher carries the
// same long timeouts as the default LLM dispatcher, so slow thinking models and
// long streams are not cut off.
const CLIENT_BASE_URL_LLM_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
};

const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

function hasErrorCode(error: unknown, codes: Set<string>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * The error a failed request surfaces to callers. Routes relay LLM error
 * messages, and the AI SDK turns a `fetch failed` cause into "Cannot connect to
 * API: <cause message>", so the cause carries a fixed reason only (the system
 * error text names addresses, ports and resolver answers). The shape stays a
 * `TypeError('fetch failed')` with a cause so the SDK still classifies it as a
 * retryable connection failure. Address-policy refusals (fixed guard text) and
 * caller aborts pass through unchanged.
 */
export function toCallerSafeTransportError(error: unknown): unknown {
  if (isAbortError(error) || findUnsafeNetworkTargetError(error)) return error;
  const reason = isRejectedRedirectError(error)
    ? 'redirects are not allowed'
    : hasErrorCode(error, TIMEOUT_ERROR_CODES)
      ? 'request timed out'
      : 'connection failed';
  return new TypeError('fetch failed', { cause: new Error(reason) });
}

// Entity headers describe the replaced body; everything else (retry-after,
// rate-limit and request-id headers) is kept for the SDK's retry handling.
const DROPPED_ERROR_HEADERS = ['content-type', 'content-length', 'content-encoding'];

// How much of an error body is kept for the server log, and how long reading
// it may take. The body is only logged, so a large or trickling one is cut
// short and cancelled instead of being buffered.
const ERROR_BODY_LOG_BYTES = 1024;
const ERROR_BODY_LOG_WAIT_MS = 1000;

async function readErrorBodyPreview(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ERROR_BODY_LOG_WAIT_MS);
  });
  try {
    while (total < ERROR_BODY_LOG_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout' || next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    // An unreadable body only loses the log preview.
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, ERROR_BODY_LOG_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Replace an HTTP error response with an empty body and the standard reason
 * phrase. The AI SDK builds the error message from the provider's error JSON
 * (or the status text when the body is empty), and routes relay that message,
 * so a caller-chosen endpoint's response text never reaches the caller. The
 * status and headers are kept, so retry and status classification still work;
 * a status outside the range a `Response` accepts (600-999 pass through the
 * transport) is reported as 502.
 */
async function withoutErrorBody(response: Response): Promise<Response> {
  const preview = await readErrorBodyPreview(response);
  log.warn(`LLM provider answered HTTP ${response.status}: ${preview.slice(0, 500)}`);
  const status = response.status <= 599 ? response.status : 502;
  const headers = new Headers(response.headers);
  for (const name of DROPPED_ERROR_HEADERS) headers.delete(name);
  return new Response(null, {
    status,
    statusText: STATUS_CODES[status] ?? '',
    headers,
  });
}

/**
 * `fetch` for LLM calls to a caller-chosen endpoint. Any dispatcher already on
 * the request (the default timeout-only one) is replaced by the pinned one.
 * Transport failures and HTTP error bodies are reduced to fixed text; details
 * are logged server-side.
 */
export const clientBaseUrlLlmFetch: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await providerFetch(
      input instanceof Request ? input.url : input,
      init,
      CLIENT_BASE_URL_LLM_POLICY,
    );
  } catch (error) {
    if (!isAbortError(error)) log.warn('LLM provider request failed:', error);
    throw toCallerSafeTransportError(error);
  }
  return response.status >= 400 ? withoutErrorBody(response) : response;
};
