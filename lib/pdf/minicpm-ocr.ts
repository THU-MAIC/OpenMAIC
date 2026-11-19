/**
 * MiniCPM-OCR document parsing API (ModelBest).
 *
 * Flow: POST {base}/document-parse/jobs (multipart file + model) → poll
 * {base}/document-parse/jobs/{id} until Success → take the Markdown.
 *
 * The hosted API is `https://api.modelbest.cn/v1`. A self-hosted MiniCPM-OCR
 * web demo serves the same job routes under `/api` and usually takes no key,
 * so the endpoint and key stay operator configuration.
 *
 * The service returns Markdown with tables (HTML) and formulas (LaTeX)
 * inline; per-page results also carry the layout blocks, which are mapped to
 * the shared `layout` shape.
 */

import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { MINICPM_OCR_DEFAULT_BASE } from './constants';
import { getExtensionsForProviders } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import {
  isRejectedRedirectError,
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import { findUnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';

const log = createLogger('MiniCPMOCR');

/** The model id the hosted API expects; a self-hosted demo ignores the field. */
const MINICPM_OCR_MODEL = 'MiniCPM-OCR-1.0';

const TIMEOUTS = {
  submit: 120_000,
  poll: 30_000,
  // A cancellation asks the server to stop the job; it runs after the
  // caller's signal is gone, so it gets its own short deadline.
  cancel: 15_000,
} as const;

/** The result includes per-page Markdown and layout blocks; bound the read. */
export const MAX_JSON_BYTES = 64 * 1024 * 1024; // 64 MiB
// Every poll repeats the pages finished so far, so the interval grows from
// two seconds to ten: a multi-minute job must not re-download the whole
// document every second. A server Retry-After is a lower bound.
const POLL_INITIAL_MS = 2_000;
const POLL_MIN_MS = 500;
const POLL_MAX_INTERVAL_MS = 10_000;
const POLL_GROWTH = 1.5;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes
// A rate-limited submission is refused before the service creates a job, so it
// is retried; an ambiguous 5xx is not, since a proxy can answer 5xx after the
// origin created the job.
const SUBMIT_ATTEMPTS = 4;
/** A submission Retry-After longer than this is not worth blocking on. */
const SUBMIT_MAX_RETRY_WAIT_MS = 120_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** Non-terminal statuses the service may report while a job is in flight. */
const RUNNING_JOB_STATUSES = new Set([
  'running',
  'queued',
  'pending',
  'processing',
  'waiting',
  'in_progress',
]);

/**
 * Statuses that mean the work finished without a loss, for the job and for a
 * page's result. The service and its self-hosted demo spell them differently.
 */
const COMPLETE_STATUSES = new Set([
  'complete',
  'completed',
  'success',
  'succeeded',
  'successful',
  'ok',
  'done',
  'finished',
]);

/** Page furniture that adds noise to the layout view; the Markdown keeps it. */
const LAYOUT_SKIP_LABELS = new Set([
  'header',
  'header_image',
  'footer',
  'footer_image',
  'number',
  'footnote',
  'aside_text',
]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A request's own timeout, ended early when the caller stops waiting. */
function requestSignal(timeoutMs: number, caller: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Read a response body into a Buffer, refusing to buffer more than `maxBytes`.
 * A declared `content-length` over the cap is rejected before the body is
 * touched; the streamed path enforces the same cap chunk by chunk.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Reject before reading, but still release the connection.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`MiniCPM-OCR ${context}: response exceeds ${maxBytes} bytes`);
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`MiniCPM-OCR ${context}: response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(response: Response, context: string): Promise<T> {
  const text = (await readBoundedBody(response, MAX_JSON_BYTES, context)).toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Never quote the body in the error: parse routes relay extractor
    // messages to clients. The body only reaches the server log.
    log.warn(
      `[MiniCPM-OCR] ${context}: non-JSON body (HTTP ${response.status}): ${text.slice(0, 500)}`,
    );
    throw new Error(`MiniCPM-OCR ${context}: invalid JSON response (HTTP ${response.status})`);
  }
  // A `null`/array payload is not a job envelope. Reject it here so callers
  // never dereference it outside their own cancellation path.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log.warn(
      `[MiniCPM-OCR] ${context}: non-object JSON body (HTTP ${response.status}): ${text.slice(0, 500)}`,
    );
    throw new Error(`MiniCPM-OCR ${context}: invalid JSON response (HTTP ${response.status})`);
  }
  return value as T;
}

function clampRetryAfter(ms: number): number {
  // The poll deadline, not the normal polling interval: a server asking for a
  // longer wait must not be retried early. Callers check it against their own
  // remaining time.
  return Math.min(Math.max(ms, POLL_MIN_MS), POLL_MAX_MS);
}

/**
 * Retry-After as a delay in milliseconds, or undefined when absent/invalid.
 * Accepts both the delta-seconds form and the HTTP-date form.
 */
export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clampRetryAfter(seconds * 1000);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return clampRetryAfter(at - Date.now());
}

/** Whether `base` is the vendor's hosted API rather than a self-hosted demo. */
function isHostedBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'api.modelbest.cn' || host === 'api.modelbest.ai';
  } catch {
    return false;
  }
}

// ── API shapes ────────────────────────────────────────────────────────────────

interface MiniCPMOCRJob {
  id?: unknown;
  status?: unknown;
  pages_done?: unknown;
  pages_total?: unknown;
  markdown?: unknown;
  pages?: unknown;
  error?: unknown;
}

interface MiniCPMOCRRotation {
  applied?: unknown;
  orientation_angle?: unknown;
}

interface MiniCPMOCRLayout {
  blocks?: unknown;
  rotation?: MiniCPMOCRRotation;
}

interface MiniCPMOCRPage {
  metadata?: { page_index?: unknown };
  choices?: Array<{ message?: { content?: unknown } }>;
  /** The hosted API's per-page layout blocks. */
  ocr?: MiniCPMOCRLayout;
  /** The self-hosted web demo's per-page layout blocks. */
  minicpm_ocr?: MiniCPMOCRLayout;
  result_status?: unknown;
  issues?: unknown;
}

interface MiniCPMOCRBlock {
  bbox?: unknown;
  label?: unknown;
  content?: unknown;
  order?: unknown;
  status?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pageContent(page: MiniCPMOCRPage): string {
  const content = page.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        return typeof record?.text === 'string' ? record.text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

function pageIndex(page: MiniCPMOCRPage, fallback: number): number {
  const value = page.metadata?.page_index;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function pagesOf(job: MiniCPMOCRJob): MiniCPMOCRPage[] {
  if (!Array.isArray(job.pages)) return [];
  const pages: MiniCPMOCRPage[] = [];
  for (const page of job.pages) {
    const record = asRecord(page);
    if (record) pages.push(record as MiniCPMOCRPage);
  }
  return pages;
}

/** Pages sorted by their reported index, with the original position as fallback. */
function sortedPages(job: MiniCPMOCRJob): Array<{ page: MiniCPMOCRPage; index: number }> {
  return pagesOf(job)
    .map((page, fallback) => ({ page, index: pageIndex(page, fallback) }))
    .sort((left, right) => left.index - right.index);
}

/**
 * Surface pages the service did not parse completely. A failed page can be
 * absent from `issues` and from the failed-block report, so its result status
 * is the only signal that the Markdown is missing a page.
 */
function collectPageDiagnostics(
  job: MiniCPMOCRJob,
  diagnostics: NonNullable<ParsedPdfContent['diagnostics']>,
): void {
  for (const { page, index } of sortedPages(job)) {
    const rawStatus = typeof page.result_status === 'string' ? page.result_status.trim() : '';
    const normalizedStatus = rawStatus.toLowerCase();
    if (normalizedStatus && !COMPLETE_STATUSES.has(normalizedStatus)) {
      // The status is provider-controlled: log it server-side, report a fixed
      // message to the caller.
      log.warn(`[MiniCPM-OCR] page ${index + 1} result_status=${rawStatus.slice(0, 200)}`);
      diagnostics.push({
        severity: 'warning',
        message: `page ${index + 1} was not parsed completely`,
      });
    }
    const issues = Array.isArray(page.issues) ? page.issues.length : 0;
    if (issues > 0) {
      log.warn(`[MiniCPM-OCR] page ${index + 1}: ${issues} issue(s) reported`);
      diagnostics.push({
        severity: 'warning',
        message: `page ${index + 1} reported ${issues} issue(s)`,
      });
    }
  }
}

function assembleMarkdown(job: MiniCPMOCRJob): string {
  const topLevel = typeof job.markdown === 'string' ? job.markdown.trim() : '';
  if (topLevel) return topLevel;
  return sortedPages(job)
    .map(({ page }) => pageContent(page))
    .filter(Boolean)
    .join('\n\n');
}

function layoutType(label: string): 'title' | 'text' | 'image' | 'table' | 'formula' {
  const normalized = label.toLowerCase();
  if (normalized.includes('title')) return 'title';
  if (normalized.includes('table') || normalized.includes('chart')) return 'table';
  if (normalized.includes('formula') || normalized.includes('equation')) return 'formula';
  if (
    normalized.includes('image') ||
    normalized.includes('figure') ||
    normalized.includes('picture')
  ) {
    return 'image';
  }
  return 'text';
}

function blockBbox(
  bbox: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined;
  if (!bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return undefined;
  }
  const [x0, y0, x1, y1] = bbox as [number, number, number, number];
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (width <= 0 || height <= 0) return undefined;
  return { x: left, y: top, width, height };
}

type LayoutEntry = NonNullable<ParsedPdfContent['layout']>[number];

function blockOrder(block: MiniCPMOCRBlock | undefined, fallback: number): number {
  const order = block?.order;
  return typeof order === 'number' && Number.isFinite(order) ? order : fallback;
}

/** Whether a page was rotated for recognition, making its boxes describe the turned image. */
function turnedPageAngle(page: MiniCPMOCRPage): number | undefined {
  const rotation = page.ocr?.rotation ?? page.minicpm_ocr?.rotation;
  if (rotation?.applied !== true) return undefined;
  const angle = rotation.orientation_angle;
  if (typeof angle !== 'number' || !Number.isFinite(angle)) return undefined;
  return angle % 360 === 0 ? undefined : angle;
}

function layoutFromJob(
  job: MiniCPMOCRJob,
  diagnostics: NonNullable<ParsedPdfContent['diagnostics']>,
): LayoutEntry[] | undefined {
  const layout: LayoutEntry[] = [];
  const failedBlocks: string[] = [];
  for (const { page, index } of sortedPages(job)) {
    // The hosted API names the layout `ocr`; a self-hosted web demo names it
    // `minicpm_ocr`. Both carry `content`, `bbox`, `order` and `status` per
    // block.
    const source = Array.isArray(page.ocr?.blocks) ? page.ocr : page.minicpm_ocr;
    const blocks = source?.blocks;
    if (!Array.isArray(blocks)) continue;
    const turnedAngle = turnedPageAngle(page);
    if (turnedAngle !== undefined) {
      const message = `page ${index + 1} was turned ${turnedAngle} degrees for recognition; its coordinates are omitted`;
      log.warn(`[MiniCPM-OCR] ${message}`);
      diagnostics.push({ severity: 'warning', message });
    }
    const ordered = blocks
      .map((raw, fallback) => ({
        block: asRecord(raw) as MiniCPMOCRBlock | undefined,
        fallback,
      }))
      .sort(
        (left, right) =>
          blockOrder(left.block, left.fallback) - blockOrder(right.block, right.fallback),
      );
    for (const { block, fallback } of ordered) {
      const label = typeof block?.label === 'string' ? block.label : 'text';
      const normalizedLabel = label.toLowerCase();
      if (LAYOUT_SKIP_LABELS.has(normalizedLabel)) continue;
      const order = blockOrder(block, fallback);
      if (typeof block?.status === 'string' && block.status.toLowerCase() === 'failed') {
        // A failed region leaves a hole in the page's Markdown. Keep the rest
        // of the document and surface the loss in the server log, as the
        // reference integration does. The label is provider-controlled and
        // unbounded: log it (bounded) but keep it out of the diagnostic that
        // callers receive and store.
        log.warn(
          `[MiniCPM-OCR] page ${index + 1} ${label.slice(0, 80)} block ${order} was not recognized`,
        );
        failedBlocks.push(`page ${index + 1} block ${order}`);
      }
      const content = typeof block?.content === 'string' ? block.content.trim() : '';
      if (!content) continue;
      const position = turnedAngle === undefined ? blockBbox(block?.bbox) : undefined;
      layout.push({
        page: index + 1,
        type: layoutType(label),
        content,
        ...(position ? { position } : {}),
      });
    }
  }
  if (failedBlocks.length > 0) {
    const shown = failedBlocks.slice(0, 5).join('; ');
    const message = `${failedBlocks.length} block(s) were not recognized: ${shown}${
      failedBlocks.length > 5 ? ' …' : ''
    }`;
    log.warn(`[MiniCPM-OCR] ${message}`);
    diagnostics.push({ severity: 'warning', message });
  }
  return layout.length ? layout : undefined;
}

function pageCountOf(job: MiniCPMOCRJob): number {
  const total = job.pages_total;
  if (typeof total === 'number' && Number.isInteger(total) && total > 0) return total;
  return pagesOf(job).length;
}

function jobStatus(job: MiniCPMOCRJob): string | undefined {
  return typeof job.status === 'string' ? job.status.trim().toLowerCase() : undefined;
}

function jobIdOf(job: MiniCPMOCRJob): string | undefined {
  return typeof job.id === 'string' && job.id ? job.id : undefined;
}

// ── Requests ──────────────────────────────────────────────────────────────────

interface MiniCPMOCROptions {
  fileName?: string;
  mimeType?: string;
}

const MINICPM_OCR_SUPPORTED_EXTENSIONS = new Set(getExtensionsForProviders(['minicpm-ocr']));

function fallbackFileName(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'image/png':
      return 'document.png';
    case 'image/jpeg':
      return 'document.jpg';
    case 'image/bmp':
      return 'document.bmp';
    case 'image/webp':
      return 'document.webp';
    default:
      return 'document.pdf';
  }
}

function sanitizeFileName(name: string | undefined, mimeType: string | undefined): string {
  const fallback = fallbackFileName(mimeType);
  const raw = (name ?? fallback).split(/[/\\]/).pop()?.trim() ?? fallback;
  const trimmed = raw.slice(0, 240);
  if (trimmed.includes('..')) return fallback;
  const extension = trimmed.split('.').pop()?.toLowerCase();
  if (!extension || !MINICPM_OCR_SUPPORTED_EXTENSIONS.has(extension)) return fallback;
  return trimmed || fallback;
}

function providerPolicy(config: PDFParserConfig): ProviderFetchPolicy {
  // The API root is operator configuration when managed (a self-hosted demo
  // may live on the server's own network); a caller-supplied root runs under
  // the operator address policy. Redirects are refused: the endpoint is exact.
  return config.managed
    ? {
        allowLocalNetworks: true,
        redirectAllowLocalNetworks: resolveAllowLocalNetworks(),
        rejectRedirects: true,
      }
    : { allowLocalNetworks: undefined, rejectRedirects: true };
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Ask the server to stop a job this client is giving up on (a cancelled
 * generation, an expired deadline, a protocol error). Best effort: the job is
 * already lost to this request, and a failed DELETE must not mask the original
 * error. It runs after the caller's signal is gone, so it gets its own
 * deadline and ignores the caller's abort.
 */
async function cancelJob(
  apiRoot: string,
  token: string | undefined,
  jobId: string,
  config: PDFParserConfig,
): Promise<void> {
  try {
    const response = await providerFetch(
      `${apiRoot}/document-parse/jobs/${encodeURIComponent(jobId)}`,
      {
        method: 'DELETE',
        headers: authHeaders(token),
        signal: AbortSignal.timeout(TIMEOUTS.cancel),
      },
      providerPolicy(config),
    );
    discardBody(response);
    if (!response.ok && response.status !== 404) {
      log.warn(`[MiniCPM-OCR] job ${jobId} cancel returned HTTP ${response.status}`);
    }
  } catch (error) {
    log.warn(`[MiniCPM-OCR] failed to cancel job ${jobId}:`, error);
  }
}

async function submitJob(
  apiRoot: string,
  token: string | undefined,
  body: FormData,
  config: PDFParserConfig,
): Promise<MiniCPMOCRJob> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
    config.signal?.throwIfAborted();
    try {
      const response = await providerFetch(
        `${apiRoot}/document-parse/jobs`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body,
          signal: requestSignal(TIMEOUTS.submit, config.signal),
        },
        providerPolicy(config),
      );

      if (response.status === 401 || response.status === 403) {
        discardBody(response);
        throw new Error(`MiniCPM-OCR API key was rejected (HTTP ${response.status})`);
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response) ?? 0;
        discardBody(response);
        if (retryAfter > SUBMIT_MAX_RETRY_WAIT_MS) {
          throw new Error(`MiniCPM-OCR asked to retry after ${Math.ceil(retryAfter / 1000)}s`);
        }
        if (attempt < SUBMIT_ATTEMPTS) {
          await sleep(Math.max(retryAfter, 500 * attempt), config.signal);
          continue;
        }
        throw new Error(`MiniCPM-OCR job submission failed (HTTP ${response.status})`);
      }
      if (response.status >= 500) {
        // The submission is not idempotent: a reverse proxy can answer 5xx
        // after the origin created the job, so retrying would leave a job
        // running that this client never learns the id of, spending the
        // account's quota. Only the 429 refusal above creates nothing.
        log.warn(`[MiniCPM-OCR] job submission failed (HTTP ${response.status})`);
        discardBody(response);
        throw new Error(`MiniCPM-OCR job submission failed (HTTP ${response.status})`);
      }
      if (!response.ok) {
        // The body can name server paths or configuration; keep it in the log.
        log.warn(`[MiniCPM-OCR] job submission refused (HTTP ${response.status})`);
        discardBody(response);
        throw new Error(`MiniCPM-OCR refused the document (HTTP ${response.status})`);
      }

      const job = await readJson<MiniCPMOCRJob>(response, 'job submission');
      if (!jobIdOf(job)) throw new Error('MiniCPM-OCR did not return a job id');
      return job;
    } catch (error) {
      config.signal?.throwIfAborted();
      // A transport failure may have reached the server after the server
      // accepted the upload: retrying the POST can create a second job whose
      // id this client never learns, leaving it running. Only an explicit
      // 429 answer is retried (the branch above); a transport failure or a
      // 5xx is left to the extraction layer's own retry.
      lastError = error;
      break;
    }
  }
  const blocked = findUnsafeNetworkTargetError(lastError);
  if (blocked) throw blocked;
  if (lastError instanceof Error && lastError.message.startsWith('MiniCPM-OCR ')) throw lastError;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`MiniCPM-OCR job submission failed: ${detail}`, { cause: lastError });
}

function growPollInterval(interval: number): number {
  return Math.min(Math.round(interval * POLL_GROWTH), POLL_MAX_INTERVAL_MS);
}

async function pollJob(
  apiRoot: string,
  token: string | undefined,
  jobId: string,
  config: PDFParserConfig,
): Promise<MiniCPMOCRJob> {
  const deadline = Date.now() + POLL_MAX_MS;
  let consecutiveFailures = 0;
  let pollInterval = POLL_INITIAL_MS;
  let lastDone = -1;
  let lastTotal = -1;

  const cancel = () => cancelJob(apiRoot, token, jobId, config);
  // A job this client gives up on is stopped on the server too: active jobs
  // count against the account, and nobody will read the result.
  const giveUp = async (message: string, options?: ErrorOptions): Promise<never> => {
    await cancel();
    throw new Error(message, options);
  };
  const waitForNextPoll = async (retryAfter: number | undefined): Promise<void> => {
    const requested = Math.max(retryAfter ?? 0, pollInterval);
    const remaining = Math.max(deadline - Date.now(), 0);
    if (requested >= remaining) {
      await giveUp(
        `MiniCPM-OCR asked to retry after ${Math.ceil(requested / 1000)}s, beyond the ${Math.ceil(
          remaining / 1000,
        )}s remaining`,
      );
    }
    await sleep(requested, config.signal);
    pollInterval = growPollInterval(pollInterval);
  };

  try {
    while (Date.now() < deadline) {
      config.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await providerFetch(
          `${apiRoot}/document-parse/jobs/${encodeURIComponent(jobId)}`,
          {
            headers: { ...authHeaders(token), Accept: 'application/json' },
            signal: requestSignal(TIMEOUTS.poll, config.signal),
          },
          providerPolicy(config),
        );
      } catch (error) {
        config.signal?.throwIfAborted();
        if (findUnsafeNetworkTargetError(error) || isRejectedRedirectError(error)) throw error;
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) {
          const detail = error instanceof Error ? error.message : String(error);
          return giveUp(`MiniCPM-OCR polling failed: ${detail}`, { cause: error });
        }
        log.warn(`[MiniCPM-OCR] polling — transient failure:`, error);
        await waitForNextPoll(undefined);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        discardBody(response);
        throw new Error(`MiniCPM-OCR API key was rejected (HTTP ${response.status})`);
      }
      if (response.status === 404) {
        discardBody(response);
        throw new Error('MiniCPM-OCR job not found (it may have expired)');
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = retryAfterMs(response);
        discardBody(response);
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) {
          return giveUp(`MiniCPM-OCR polling failed (HTTP ${response.status})`);
        }
        await waitForNextPoll(retryAfter);
        continue;
      }
      if (!response.ok) {
        log.warn(`[MiniCPM-OCR] polling failed (HTTP ${response.status})`);
        discardBody(response);
        // The job may still be running: stop it before this request ends.
        await cancel();
        throw new Error(`MiniCPM-OCR polling failed (HTTP ${response.status})`);
      }

      let job: MiniCPMOCRJob;
      try {
        job = await readJson<MiniCPMOCRJob>(response, 'poll');
      } catch (error) {
        // The job is still running server-side; stop it before the protocol
        // error ends this request.
        await cancel();
        throw error;
      }
      consecutiveFailures = 0;
      const status = jobStatus(job);
      if (!status) return giveUp('MiniCPM-OCR returned an invalid job status');

      const done = typeof job.pages_done === 'number' ? job.pages_done : lastDone;
      const total = typeof job.pages_total === 'number' ? job.pages_total : lastTotal;
      if (done !== lastDone || total !== lastTotal) {
        lastDone = done;
        lastTotal = total;
        log.info(`[MiniCPM-OCR] job ${jobId}: ${status} ${done}/${total}`);
      }

      if (COMPLETE_STATUSES.has(status)) return job;
      if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
        // The provider's error text may name its internals; log it only.
        log.warn(`[MiniCPM-OCR] job ${jobId} ${status}: ${String(job.error ?? '').slice(0, 500)}`);
        throw new Error(`MiniCPM-OCR parsing ${status === 'failed' ? 'failed' : 'cancelled'}`);
      }
      if (!RUNNING_JOB_STATUSES.has(status)) {
        // The status string is provider-controlled; log it and keep the
        // caller-facing error fixed (the parse route relays extractor errors).
        log.warn(
          `[MiniCPM-OCR] job ${jobId} returned unexpected status: ${String(job.status).slice(0, 200)}`,
        );
        return giveUp('MiniCPM-OCR returned an unexpected job status');
      }

      await waitForNextPoll(retryAfterMs(response));
    }

    return giveUp(`MiniCPM-OCR timed out after ${POLL_MAX_MS / 1000}s`);
  } catch (error) {
    // The caller stopped waiting (a deleted material, a deadline, shutdown):
    // stop the server-side job as well.
    if (config.signal?.aborted) await cancel();
    throw error;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export type MiniCPMOCRVerification = { ok: true } | { ok: false; reason: 'auth' | 'endpoint' };

/**
 * Probe the service for the settings' "test connection" action. The hosted
 * API lists its models behind the key: a rejected key fails, and so does a
 * 404 or 5xx (a mistyped endpoint, a broken gateway), since no document can
 * be parsed through it. A self-hosted web demo may answer 404 for the same
 * path, which still means it is up, so only a rejected key fails it.
 */
export async function verifyMiniCPMOCRConnection(config: {
  apiKey?: string;
  baseUrl?: string;
  managed?: boolean;
}): Promise<MiniCPMOCRVerification> {
  const apiRoot = (config.baseUrl || MINICPM_OCR_DEFAULT_BASE).replace(/\/+$/, '');
  const token = config.apiKey?.trim() || undefined;
  const response = await providerFetch(
    `${apiRoot}/models`,
    {
      headers: { ...authHeaders(token), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    },
    providerPolicy({ providerId: 'minicpm-ocr', ...config }),
  );
  discardBody(response);
  if (response.status === 401 || response.status === 403) {
    log.warn(`[MiniCPM-OCR] probe rejected credentials [status=${response.status}]`);
    return { ok: false, reason: 'auth' };
  }
  if (isHostedBase(apiRoot) && (response.status === 404 || response.status >= 500)) {
    log.warn(`[MiniCPM-OCR] probe against the hosted API failed [status=${response.status}]`);
    return { ok: false, reason: 'endpoint' };
  }
  return { ok: true };
}

/**
 * Parse a PDF or image with MiniCPM-OCR.
 *
 * @param config - `apiKey` (required for the hosted API, optional for a
 *   self-hosted web demo) and optionally `baseUrl`
 * @param documentBuffer - Raw document bytes
 */
export async function parseWithMiniCPMOCR(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  options: MiniCPMOCROptions = {},
): Promise<ParsedPdfContent> {
  const apiRoot = (config.baseUrl || MINICPM_OCR_DEFAULT_BASE).replace(/\/+$/, '');
  const token = config.apiKey?.trim() || undefined;
  if (!token && (!config.baseUrl || isHostedBase(apiRoot))) {
    throw new Error('API key required for the hosted MiniCPM-OCR API');
  }

  const uploadFileName = sanitizeFileName(options.fileName, options.mimeType);
  log.info(`[MiniCPM-OCR] Starting parse: ${uploadFileName} (${documentBuffer.byteLength} bytes)`);

  const bytes = documentBuffer.buffer.slice(
    documentBuffer.byteOffset,
    documentBuffer.byteOffset + documentBuffer.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: options.mimeType || 'application/octet-stream' }),
    uploadFileName,
  );
  // The hosted API names the model; a self-hosted demo ignores the field.
  form.append('model', MINICPM_OCR_MODEL);

  const submitted = await submitJob(apiRoot, token, form, config);
  const jobId = jobIdOf(submitted)!;
  log.info(`[MiniCPM-OCR] job ${jobId} created`);

  const job = await pollJob(apiRoot, token, jobId, config);
  const text = assembleMarkdown(job);
  if (!text) throw new Error('MiniCPM-OCR returned no text');

  const diagnostics: NonNullable<ParsedPdfContent['diagnostics']> = [];
  collectPageDiagnostics(job, diagnostics);
  const layout = layoutFromJob(job, diagnostics);
  return {
    text,
    images: [],
    ...(layout ? { layout } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    metadata: {
      fileName: options.fileName,
      pageCount: pageCountOf(job),
      parser: 'minicpm-ocr',
      textFormat: 'markdown',
      taskId: jobId,
    },
  };
}
