/**
 * Baidu Cloud document parsing (文档解析 PaddleOCR-VL).
 *
 * An asynchronous API: an access token (API Key + Secret Key exchanged at the
 * OAuth endpoint) authorizes a submit call that answers a `task_id`, a query
 * call polled until `status: "success"`, and two result URLs — the markdown
 * document and the structured parse result — served from Baidu's object
 * storage. The result URLs are response-supplied, so they are held to the
 * strict public policy with bounded reads, exactly like MinerU Cloud's
 * response-supplied URLs after GHSA-cpjc-vgjh-c5jp.
 */

import { extractPaddleCloudParseResult } from './paddleocr-parser';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { PDFParserConfig } from './types';
import { createLogger } from '@/lib/logger';
import { createHash } from 'node:crypto';

import {
  isRejectedRedirectError,
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import { validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';

const log = createLogger('PaddleCloud');

export const PADDLE_CLOUD_DEFAULT_BASE = 'https://aip.baidubce.com';

const SUBMIT_PATH = '/rest/2.0/brain/online/v2/paddle-vl-parser/task';
const QUERY_PATH = '/rest/2.0/brain/online/v2/paddle-vl-parser/task/query';

/** The submit API is rate-limited to 2 QPS and the poll API to 5 QPS. */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes, matching MinerU Cloud
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Baidu caps file_data at 50 MB; file_url is the documented route above that. */
export const MAX_FILE_DATA_BYTES = 50 * 1024 * 1024;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;
/** Caps for response-supplied image links (count + aggregate bytes). */
export const MAX_IMAGE_LINKS = 100;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_LINK_BYTES_TOTAL = 32 * 1024 * 1024;
/** Aggregate wall-clock bound for the whole linked-image phase. */
export const IMAGE_PHASE_MAX_MS = 5 * 60_000;

/** The strict public policy: result URLs are response-supplied, never ours,
 * and HTTPS-only on every hop — the payloads carry the parsed document. */
const RESPONSE_URL_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  requireHttps: true,
};

/**
 * The API root is operator configuration when managed (it may sit on a
 * private gateway), otherwise it falls back to the env opt-in — the same
 * first-hop split the MinerU Cloud integration applies.
 */
function apiRootPolicy(managed: boolean | undefined): ProviderFetchPolicy {
  return managed
    ? { allowLocalNetworks: true, redirectAllowLocalNetworks: resolveAllowLocalNetworks() }
    : { allowLocalNetworks: undefined };
}

// ---------------------------------------------------------------------------
// Access token (API Key + Secret Key → short-lived token), cached per key.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * The cache key hashes the full credential context — base URL plus both
 * credentials — so a rotated secret, or the same key id against a different
 * endpoint, can never reuse (or leak into) another origin's token. Only the
 * digest is stored, never the credentials themselves.
 */
function cacheKey(baseUrl: string, accessKeyId: string, accessKeySecret: string): string {
  return createHash('sha256')
    .update(`${baseUrl}\n${accessKeyId}\n${accessKeySecret}`)
    .digest('hex');
}

export function clearPaddleCloudTokenCache(): void {
  tokenCache.clear();
}

/**
 * Read a JSON response body. A malformed payload is null (the caller decides
 * what that means), but a transport or abort failure while reading the body
 * propagates: swallowing it would erase the transient signal the retry
 * classifier needs.
 */
async function readJsonBody<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function getAccessToken(
  baseUrl: string,
  accessKeyId: string,
  accessKeySecret: string,
  managed: boolean | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const key = cacheKey(baseUrl, accessKeyId, accessKeySecret);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const response = await providerFetch(
    `${baseUrl}/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(accessKeyId)}&client_secret=${encodeURIComponent(accessKeySecret)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: requestSignal(SUBMIT_TIMEOUT_MS, signal),
    },
    apiRootPolicy(managed),
  );
  const body = await readJsonBody<{
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  }>(response);
  if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    const detail = typeof body?.error_description === 'string' ? body.error_description : '';
    // Keep the HTTP status on the error: a 5xx from the OAuth endpoint is a
    // transient outage, and the retry classifier reads it from here.
    throw Object.assign(
      new Error(`PaddleOCR Cloud authentication failed${detail ? `: ${detail}` : ''}`),
      { status: response.status },
    );
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 2592000;
  tokenCache.set(key, {
    token: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Submit → poll → download
// ---------------------------------------------------------------------------

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

interface SubmitResponse {
  error_code?: number;
  error_msg?: string;
  result?: { task_id?: unknown };
}

interface QueryResponse {
  error_code?: number;
  error_msg?: string;
  result?: {
    status?: unknown;
    task_error?: unknown;
    markdown_url?: unknown;
    parse_result_url?: unknown;
  } | null;
}

/** Validate a response-supplied URL, then fetch it under the strict policy. */
async function downloadResponseUrl(
  rawUrl: unknown,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw new Error(`PaddleOCR Cloud result is missing ${label}`);
  }
  if (!rawUrl.startsWith('https://')) {
    throw new Error(`PaddleOCR Cloud ${label} is not HTTPS`);
  }
  const ssrfError = await validateUrlForSSRFWithPolicy(rawUrl, { allowLocalNetworks: false });
  if (ssrfError) {
    throw new Error(`PaddleOCR Cloud ${label} was refused by the address policy`);
  }
  const response = await providerFetch(
    rawUrl,
    { signal: requestSignal(DOWNLOAD_TIMEOUT_MS, signal) },
    RESPONSE_URL_POLICY,
  );
  if (!response.ok) {
    throw new Error(`PaddleOCR Cloud ${label} download failed (${response.status})`);
  }
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`PaddleOCR Cloud ${label} exceeds the ${maxBytes}-byte read limit`);
    }
    return new TextDecoder().decode(buf);
  }
  // Count the bytes as they arrive and cancel mid-stream: a result URL that
  // lies about (or omits) its length must not buffer without bound.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`PaddleOCR Cloud ${label} exceeds the ${maxBytes}-byte read limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Download one response-supplied image link under the strict HTTPS-only
 * bounded policy and return it as a data URL, or null when the link is
 * refused, fails, or exceeds the image byte budget (per-image and aggregate).
 * Caller aborts and policy rejections propagate.
 */
/**
 * Read a response body with an ordered budget: [perBodyMax, aggregateRemaining].
 * Returns the bytes, or the first budget number that was exceeded (the stream
 * is cancelled at that point, never buffered past it).
 */
async function readBodyWithBudget(
  response: Response,
  budgets: readonly number[],
): Promise<Uint8Array | number> {
  const declared = Number(response.headers.get('content-length'));
  const hardMax = Math.max(...budgets);
  if (Number.isFinite(declared) && declared > hardMax) {
    await response.body?.cancel().catch(() => {});
    return hardMax;
  }
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > hardMax) return buf.byteLength;
    return new Uint8Array(buf);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded: number | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      const hit = budgets.find((b) => total > b);
      if (hit !== undefined) {
        exceeded = hit;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (exceeded !== undefined) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (exceeded !== undefined) return exceeded;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The image MIME for a data URL: a validated response Content-Type wins;
 * otherwise sniff the bytes (PNG/JPEG/WebP) and fall back to image/png.
 */
function resolveImageMime(contentType: string | null, bytes: Uint8Array): string {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (
    declared &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(declared)
  ) {
    return declared;
  }
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

async function downloadLinkImage(
  parsed: ParsedPdfContent,
  link: { path: string; url: string; pageNumber: number },
  ctx: {
    config: PDFParserConfig;
    signal?: AbortSignal;
    linkBytesTotal: () => number;
    addBytes: (n: number) => void;
  },
): Promise<string | null> {
  const ssrfError = await validateUrlForSSRFWithPolicy(link.url, { allowLocalNetworks: false });
  if (ssrfError || !link.url.startsWith('https://')) {
    log.warn(`[PaddleCloud] image link for "${link.path}" refused by policy, skipped`);
    return null;
  }
  let response: Response;
  try {
    response = await providerFetch(
      link.url,
      { signal: requestSignal(DOWNLOAD_TIMEOUT_MS, ctx.signal) },
      RESPONSE_URL_POLICY,
    );
  } catch (error) {
    // Only the caller's abort is ours to propagate; the phase deadline is an
    // internal budget that just stops optional enrichment.
    if (ctx.config.signal?.aborted || isRejectedRedirectError(error)) throw error;
    log.warn(`[PaddleCloud] image download for "${link.path}" failed, skipped:`, error);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    log.warn(
      `[PaddleCloud] image download for "${link.path}" failed (${response.status}), skipped`,
    );
    return null;
  }
  const streamed = await readBodyWithBudget(response, [
    MAX_IMAGE_BYTES,
    MAX_IMAGE_LINK_BYTES_TOTAL - ctx.linkBytesTotal(),
  ]);
  if (typeof streamed === 'number') {
    log.warn(
      `[PaddleCloud] image for "${link.path}" exceeds the image byte budget (${streamed} bytes), skipped`,
    );
    return null;
  }
  ctx.addBytes(streamed.byteLength);
  const mime = resolveImageMime(response.headers.get('content-type'), streamed);
  return `data:${mime};base64,${Buffer.from(streamed).toString('base64')}`;
}

export async function parseWithPaddleCloud(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  sourceFileName?: string,
): Promise<ParsedPdfContent> {
  const accessKeyId = config.accessKeyId;
  const accessKeySecret = config.accessKeySecret;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('PaddleOCR Cloud requires an API Key and Secret Key pair');
  }
  if (documentBuffer.byteLength > MAX_FILE_DATA_BYTES) {
    throw new Error(
      `Document exceeds the ${MAX_FILE_DATA_BYTES}-byte submit limit of PaddleOCR Cloud's file_data upload`,
    );
  }

  const baseUrl = (config.baseUrl || PADDLE_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');
  // Baidu identifies the upload by the file_name extension; a missing or
  // extension-less name falls back to the configured MIME type.
  const fileName = sourceFileName || 'document.pdf';
  if (documentBuffer.byteLength > MAX_FILE_DATA_BYTES) {
    throw new Error('Document exceeds the 50 MB file_data limit of PaddleOCR Cloud');
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (config.signal?.aborted) {
        reject(config.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(config.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        config.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      config.signal?.addEventListener('abort', onAbort, { once: true });
    });
  // Step 1: submit the document as base64 form data.
  log.info(`[PaddleCloud] Submitting ${fileName} (${documentBuffer.byteLength} bytes)`);

  // The submit API is rate-limited to 2 QPS: a QPS refusal (HTTP 429 or
  // Baidu code 18) is retried with backoff. An invalid/expired token (codes
  // 110/111) evicts the cache entry so the retry reacquires a fresh one.
  let token = await getAccessToken(
    baseUrl,
    accessKeyId,
    accessKeySecret,
    config.managed,
    config.signal,
  );
  let tokenRefreshNeeded = false;
  const submitBody = new URLSearchParams({
    file_data: documentBuffer.toString('base64'),
    file_name: fileName,
  }).toString();
  let submitJson: SubmitResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(2_000);
      if (tokenRefreshNeeded) {
        token = await getAccessToken(
          baseUrl,
          accessKeyId,
          accessKeySecret,
          config.managed,
          config.signal,
        );
        tokenRefreshNeeded = false;
      }
    }
    const submitResponse = await providerFetch(
      `${baseUrl}${SUBMIT_PATH}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: submitBody,
        signal: requestSignal(SUBMIT_TIMEOUT_MS, config.signal),
      },
      apiRootPolicy(config.managed),
    );
    submitJson = await readJsonBody<SubmitResponse>(submitResponse);
    const code = submitJson?.error_code;
    if (submitResponse.status === 429 || code === 18) {
      continue; // QPS refusal: backoff and retry
    }
    if (!submitResponse.ok) {
      throw new Error(`PaddleOCR Cloud submit failed (HTTP ${submitResponse.status})`);
    }
    if (code === 110 || code === 111) {
      tokenCache.delete(cacheKey(baseUrl, accessKeyId, accessKeySecret));
      tokenRefreshNeeded = true;
      continue; // reacquire the token and retry once within the attempt budget
    }
    if (!submitJson || (code ?? 0) !== 0) {
      throw new Error(`PaddleOCR Cloud submit failed: ${submitJson?.error_msg || `code ${code}`}`);
    }
    break;
  }
  if (!submitJson || (submitJson.error_code ?? 0) !== 0 || !submitJson.result?.task_id) {
    throw new Error(
      `PaddleOCR Cloud submit failed: ${submitJson?.error_msg || 'no task_id returned'}`,
    );
  }
  const taskId = submitJson.result.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('PaddleOCR Cloud submit returned no task_id');
  }

  // Step 2: poll the query endpoint (5-10s cadence per the API docs).
  const deadline = Date.now() + POLL_MAX_MS;
  let result: NonNullable<QueryResponse['result']> | null = null;
  let tokenRefreshes = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const queryResponse = await providerFetch(
      `${baseUrl}${QUERY_PATH}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ task_id: taskId }).toString(),
        signal: requestSignal(POLL_TIMEOUT_MS, config.signal),
      },
      apiRootPolicy(config.managed),
    );
    // The query API is rate-limited to 5 QPS: an HTTP 429 is transient and
    // must be handled before the generic !ok branch (which material-extraction
    // classifies as permanent). The body is cancelled so a throttled job
    // cannot pin one connection per poll for the whole deadline.
    if (queryResponse.status === 429) {
      await queryResponse.body?.cancel().catch(() => {});
      continue;
    }
    // Other HTTP-level failures surface immediately instead of being read as
    // a provider status.
    if (!queryResponse.ok) {
      throw new Error(`PaddleOCR Cloud query failed (HTTP ${queryResponse.status})`);
    }
    const queryJson = await readJsonBody<QueryResponse>(queryResponse);
    const code = queryJson?.error_code;
    if (!queryJson || (code ?? 0) !== 0) {
      // Baidu QPS-limit responses are transient (query API: 5 QPS).
      if (code === 18 || queryResponse.status === 429) continue;
      // The task is already submitted, so an invalid/expired token must not
      // strand it: evict the cache, reacquire, and keep polling. Bound the
      // refreshes so persistently bad credentials cannot loop to the deadline.
      if (code === 110 || code === 111) {
        tokenCache.delete(cacheKey(baseUrl, accessKeyId, accessKeySecret));
        if (tokenRefreshes >= 2) {
          throw new Error(
            `PaddleOCR Cloud query failed: ${queryJson?.error_msg || `code ${code}`}`,
          );
        }
        tokenRefreshes += 1;
        token = await getAccessToken(
          baseUrl,
          accessKeyId,
          accessKeySecret,
          config.managed,
          config.signal,
        );
        continue;
      }
      throw new Error(`PaddleOCR Cloud query failed: ${queryJson?.error_msg || `code ${code}`}`);
    }
    const current = queryJson.result ?? null;
    if (!current) continue;
    if (typeof current.status === 'string' && current.status !== 'success') {
      if (current.status === 'failed') {
        const detail = typeof current.task_error === 'string' ? current.task_error : '';
        throw new Error(`PaddleOCR Cloud parsing failed${detail ? `: ${detail}` : ''}`);
      }
      continue; // still running
    }
    result = current;
    break;
  }

  if (!result) {
    throw new Error(`PaddleOCR Cloud timed out after ${POLL_MAX_MS / 1000}s (task: ${taskId})`);
  }

  // Step 3: download the response-supplied results under the strict policy.
  const markdown = await downloadResponseUrl(
    result.markdown_url,
    'markdown URL',
    MAX_MARKDOWN_BYTES,
    config.signal,
  );
  let parseResult: unknown = null;
  if (typeof result.parse_result_url === 'string' && result.parse_result_url) {
    try {
      parseResult = JSON.parse(
        await downloadResponseUrl(
          result.parse_result_url,
          'parse result URL',
          MAX_JSON_BYTES,
          config.signal,
        ),
      );
    } catch (error) {
      if (isRejectedRedirectError(error)) throw error;
      // The caller stopped waiting: that is not an enrichment failure, and
      // reporting markdown-only success would let canceled work continue.
      if (config.signal?.aborted) throw error;
      // A structured result is optional enrichment; the markdown is the product.
      log.warn('[PaddleCloud] parse result download/parse failed, serving markdown only:', error);
    }
  }

  const parsed = extractPaddleCloudParseResult(parseResult, markdown);

  // Cloud images can be storage links: download each under the same strict,
  // bounded policy as the result URLs before the result is published, so
  // signed links cannot expire into broken markdown references.
  const imageLinks = parsed.metadata?.imageLinks as
    | Array<{ path: string; url: string; pageNumber: number }>
    | undefined;
  // A figure-heavy result or a custom gateway can list many links: cap the
  // count and the aggregate retained bytes so even individually capped
  // bodies cannot grow the process without bound. Caller aborts and policy
  // rejections propagate; an ordinary failure only skips that figure.
  let linkBytesTotal = 0;
  // The whole image phase gets one aggregate deadline: serial awaits with
  // per-request timeouts are additive, and /api/parse-pdf builds this config
  // without a caller signal to bound them.
  const phaseSignal = AbortSignal.any([
    ...(config.signal ? [config.signal] : []),
    AbortSignal.timeout(IMAGE_PHASE_MAX_MS),
  ]);
  for (const link of (imageLinks ?? []).slice(0, MAX_IMAGE_LINKS)) {
    // A caller abort still fails the parse; the internal phase deadline only
    // stops enrichment, leaving the already-parsed markdown intact.
    if (config.signal?.aborted) {
      throw config.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (phaseSignal.aborted) {
      log.warn('[PaddleCloud] image enrichment deadline reached, serving the parsed result');
      break;
    }
    let dataUrl: string | null;
    try {
      dataUrl = await downloadLinkImage(parsed, link, {
        config,
        signal: phaseSignal,
        linkBytesTotal: () => linkBytesTotal,
        addBytes: (n) => (linkBytesTotal += n),
      });
    } catch (error) {
      // Aborts or policy refusals are the caller's; anything else is a
      // per-figure enrichment failure and must not discard the markdown.
      if (config.signal?.aborted || isRejectedRedirectError(error)) throw error;
      log.warn(`[PaddleCloud] image enrichment for "${link.path}" failed, skipped:`, error);
      continue;
    }
    if (dataUrl) {
      parsed.images.push(dataUrl);
      const id = `img_${parsed.images.length}`;
      parsed.metadata?.pdfImages?.push({
        id,
        src: dataUrl,
        pageNumber: link.pageNumber,
        path: link.path,
      });
      if (parsed.metadata?.imageMapping) parsed.metadata.imageMapping[id] = dataUrl;
    }
  }

  return parsed;
}
