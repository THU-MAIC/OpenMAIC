/**
 * MinerU Cloud API (v4) — https://mineru.net/api/v4
 *
 * Flow: POST /file-urls/batch → PUT presigned URL → poll /extract-results/batch/{id} → download ZIP
 * ZIP contains: full.md + images/ + content_list.json
 */

import JSZip from 'jszip';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { extractMinerUResult } from './mineru-parser';
import { MINERU_CLOUD_DEFAULT_BASE } from './constants';
import {
  getExtensionsForMimes,
  getExtensionsForProviders,
  MINERU_IMAGE_MIMES,
} from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import { providerFetch } from '@/lib/server/provider-fetch';
import {
  findUnsafeNetworkTargetError,
  UnsafeNetworkTargetError,
  validateUrlForSSRFWithPolicy,
} from '@/lib/server/ssrf-guard';

const log = createLogger('MinerUCloud');

const TIMEOUTS = {
  batch: 60_000,
  upload: 180_000,
  poll: 30_000,
  zip: 180_000,
} as const;

// Hard cap on the result ZIP read. The largest accepted input is bounded by
// MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES (50 MiB); a parsed result bundles the
// markdown, content list and extracted images, so the cap is set comfortably
// above the widest legitimate result while still bounding the download.
export const MAX_ZIP_BYTES = 256 * 1024 * 1024; // 256 MiB
// JSON control-plane responses (batch creation / poll) only carry envelope
// fields, so a small cap is enough and a runaway body cannot be buffered.
export const MAX_JSON_BYTES = 8 * 1024 * 1024; // 8 MiB
// Decompressed-result limits. The compressed archive is already capped by
// MAX_ZIP_BYTES, but a small archive can still expand to a far larger payload,
// so the entry count, the declared uncompressed total and the actual bytes read
// while extracting are each bounded. Text entries are the markdown and content
// list; every other extracted entry is treated as an image.
export const MAX_ZIP_ENTRY_COUNT = 10_000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MiB
export const MAX_ZIP_TEXT_ENTRY_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_ZIP_IMAGE_ENTRY_BYTES = 32 * 1024 * 1024; // 32 MiB

const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes

// Extension → MIME for image types MinerU can emit inside its result zip.
// Derived from MINERU_IMAGE_MIMES so this table can't drift from the accept
// list; used only to build `data:MIME;base64,…` URLs for embedded images.
const MIME_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const mime of MINERU_IMAGE_MIMES) {
    for (const ext of getExtensionsForMimes([mime])) {
      map[ext] = mime;
    }
  }
  return map;
})();

// Match every image extension MinerU may include as an asset in the result
// zip. Kept in lockstep with MIME_MAP by deriving from the same source.
const IMAGE_EXTENSION_RE = new RegExp(`\\.(${Object.keys(MIME_MAP).join('|')})$`, 'i');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function extToMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function isRetryable(err: unknown): boolean {
  // An address-policy refusal is a deterministic decision about the target, not
  // a transient transport failure: retrying the same URL cannot change it.
  if (findUnsafeNetworkTargetError(err)) return false;
  // A refused redirect is likewise deterministic: the target answered 3xx and
  // the request was configured to reject that, so a retry re-issues the same
  // rejected request. Undici reports it as `TypeError: fetch failed` with an
  // `Error('unexpected redirect')` cause, which must not look retryable.
  if (isRedirectRefusal(err)) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return ['fetch failed', 'econnreset', 'etimedout', 'timeout', 'aborted'].some((s) =>
    msg.includes(s),
  );
}

/** Follow the `cause` chain looking for undici's rejected-redirect error. */
function isRedirectRefusal(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /unexpected redirect/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function fetchWithRetry<T>(fn: () => Promise<T>, context: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts) break;
      log.warn(`[MinerU Cloud] ${context} — retry ${i}/${attempts}:`, err);
      await sleep(400 * i);
    }
  }
  // Preserve an address-policy refusal as its original typed error so callers
  // can map it to a 403 instead of an opaque transport failure; every other
  // terminal error keeps the descriptive context message.
  const blocked = findUnsafeNetworkTargetError(lastErr);
  if (blocked) throw blocked;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`MinerU Cloud ${context} failed: ${msg}`, { cause: lastErr });
}

// ── API envelope ──────────────────────────────────────────────────────────────

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

// ── Bounded response reads ────────────────────────────────────────────────────

/**
 * Read a response body into a Buffer, refusing to buffer more than `maxBytes`.
 * A declared `content-length` over the cap is rejected before the body is
 * touched; the streamed path enforces the same cap chunk by chunk so a body
 * without a length (or with a lying one) still cannot exhaust memory.
 */
async function readBoundedBody(res: Response, maxBytes: number, context: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`MinerU Cloud ${context}: response exceeds ${maxBytes} bytes`);
  }
  const body = res.body;
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
        throw new Error(`MinerU Cloud ${context}: response exceeds ${maxBytes} bytes`);
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

async function readMinerUJson<T>(res: Response, context: string): Promise<T> {
  const text = (await readBoundedBody(res, MAX_JSON_BYTES, context)).toString('utf8');
  let json: MinerUEnvelope<T>;
  try {
    json = JSON.parse(text) as MinerUEnvelope<T>;
  } catch {
    throw new Error(
      `MinerU Cloud ${context}: invalid JSON (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `MinerU Cloud ${context}: HTTP ${res.status} — ${json.msg || text.slice(0, 300)}`,
    );
  }
  if (json.code !== 0) {
    throw new Error(`MinerU Cloud ${context}: ${json.msg || 'unknown error'} (code ${json.code})`);
  }
  return json.data;
}

// ── Response-URL policy ───────────────────────────────────────────────────────

/**
 * Response-supplied MinerU URLs (the presigned upload URL and the result ZIP
 * URL) must be public HTTPS endpoints in every legitimate flow, whatever the
 * origin policy for the configured API root is. This checks the scheme and runs
 * the URL through the strict public address policy before any request; the
 * strict transport then re-validates redirect hops and pins connect-time DNS.
 *
 * Failures are thrown as {@link UnsafeNetworkTargetError} so the retry wrapper
 * treats them as terminal rather than a transient transport error.
 */
async function assertPublicHttpsResponseUrl(rawUrl: string, context: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`MinerU Cloud ${context}: provider response contained an invalid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`MinerU Cloud ${context}: provider response URL must use https`);
  }
  const ssrfError = await validateUrlForSSRFWithPolicy(parsed.href, { allowLocalNetworks: false });
  if (ssrfError) throw new UnsafeNetworkTargetError(ssrfError);
}

// ── Filename sanitization ─────────────────────────────────────────────────────

const MINERU_CLOUD_SUPPORTED_EXTENSIONS = new Set(getExtensionsForProviders(['mineru-cloud']));

function sanitizeFileName(name: string | undefined): string {
  const fallback = 'document.pdf';
  const raw = (name ?? fallback).split(/[/\\]/).pop()?.trim() ?? fallback;
  const trimmed = raw.slice(0, 240);
  if (trimmed.includes('..')) return fallback;
  const extension = trimmed.split('.').pop()?.toLowerCase();
  if (!extension || !MINERU_CLOUD_SUPPORTED_EXTENSIONS.has(extension)) return fallback;
  return trimmed || fallback;
}

// ── ZIP parsing ───────────────────────────────────────────────────────────────

interface BatchExtractRow {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

/**
 * JSZip 3.10 exposes `internalStream` at runtime but omits it from its bundled
 * type declarations, which only surface `async`/`nodeStream`. This is the
 * narrow slice of the stream-helper API the streaming reader relies on.
 */
interface StreamingZipEntry extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

/**
 * Declared uncompressed size for a loaded JSZip entry. JSZip exposes it only on
 * the internal `_data` object (`CompressedObject.uncompressedSize`), so it is
 * read defensively and treated as a hint only: a declared size can understate
 * the real payload, which is why the extracted length is checked too.
 */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : null;
}

/**
 * Reject an archive before extraction when its entry count or the total
 * declared uncompressed size is beyond the configured budget. The declared
 * total is untrusted but cheap, and it bounds an archive that honestly declares
 * a very large payload.
 */
function assertZipEntryBudget(zip: JSZip): void {
  const paths = Object.keys(zip.files);
  if (paths.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(
      `MinerU Cloud ZIP: ${paths.length} entries exceed the ${MAX_ZIP_ENTRY_COUNT}-entry limit`,
    );
  }
  let declaredTotal = 0;
  for (const path of paths) {
    const declared = declaredUncompressedSize(zip.files[path]);
    if (declared === null) continue;
    declaredTotal += declared;
    if (declaredTotal > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error(
        `MinerU Cloud ZIP: declared uncompressed size exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES}-byte limit`,
      );
    }
  }
}

async function parseMinerUZip(zipUrl: string): Promise<ParsedPdfContent> {
  await assertPublicHttpsResponseUrl(zipUrl, 'ZIP download');
  log.info('[MinerU Cloud] Downloading result ZIP...');

  const zipRes = await fetchWithRetry(
    () =>
      providerFetch(
        zipUrl,
        { signal: AbortSignal.timeout(TIMEOUTS.zip) },
        { allowLocalNetworks: false, requireHttps: true },
      ),
    'ZIP download',
  );
  if (!zipRes.ok) {
    const text = await readBoundedBody(zipRes, MAX_JSON_BYTES, 'ZIP download')
      .then((buf) => buf.toString('utf8'))
      .catch(() => zipRes.statusText);
    throw new Error(`MinerU Cloud ZIP download failed (${zipRes.status}): ${text.slice(0, 300)}`);
  }

  const zipBuf = await readBoundedBody(zipRes, MAX_ZIP_BYTES, 'ZIP download');
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e) {
    throw new Error(`MinerU Cloud ZIP parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  assertZipEntryBudget(zip);

  const filePaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const fullMdPath = filePaths.find((p) => /(^|\/)full\.md$/i.test(p));
  const contentListPath = filePaths.find(
    (p) => p.endsWith('_content_list.json') || /(^|\/)content_list\.json$/i.test(p),
  );

  if (!fullMdPath) {
    throw new Error(
      `MinerU Cloud ZIP: full.md not found. Files: ${filePaths.slice(0, 10).join(', ')}`,
    );
  }

  // Actual decompressed bytes read so far. The declared sizes above are only a
  // cheap pre-check; an archive can understate them, so each entry is measured
  // and the running total is bounded while it is streamed out of the
  // decompressor — the cap is enforced before the full entry is buffered.
  let extractedBytes = 0;
  async function readEntry(entry: JSZip.JSZipObject, kind: 'text' | 'image'): Promise<Buffer> {
    const cap = kind === 'text' ? MAX_ZIP_TEXT_ENTRY_BYTES : MAX_ZIP_IMAGE_ENTRY_BYTES;
    const stream = (entry as StreamingZipEntry).internalStream('uint8array');
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      let done = false;
      stream
        .on('data', (chunk: Uint8Array) => {
          if (done) return;
          entryBytes += chunk.byteLength;
          if (entryBytes > cap) {
            done = true;
            stream.pause();
            reject(
              new Error(
                `MinerU Cloud ZIP: entry "${entry.name}" extracted ${entryBytes} bytes, over the ${cap}-byte ${kind} limit`,
              ),
            );
            return;
          }
          if (extractedBytes + entryBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
            done = true;
            stream.pause();
            reject(
              new Error(
                `MinerU Cloud ZIP: extracted content exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES}-byte limit`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (err: Error) => {
          if (done) return;
          done = true;
          reject(err);
        })
        .on('end', () => {
          if (done) return;
          done = true;
          extractedBytes += entryBytes;
          resolve(Buffer.concat(chunks));
        })
        .resume();
    });
  }

  const mdContent = (await readEntry(zip.file(fullMdPath)!, 'text')).toString('utf8');
  const dirPrefix = fullMdPath.includes('/')
    ? fullMdPath.slice(0, fullMdPath.lastIndexOf('/') + 1)
    : '';

  // Parse content_list.json if present
  let contentList: unknown;
  if (contentListPath) {
    const raw = (await readEntry(zip.file(contentListPath)!, 'text')).toString('utf8');
    try {
      contentList = JSON.parse(raw);
    } catch {
      log.warn('[MinerU Cloud] content_list JSON parse failed, continuing with markdown only');
    }
  }

  // Helper to read an image from the ZIP by relative path
  async function readImage(relPath: string): Promise<string | null> {
    const normalized = relPath.replace(/^\.?\//, '');
    for (const candidate of [dirPrefix + normalized, normalized]) {
      const entry = zip.file(candidate);
      if (!entry) continue;
      const buf = await readEntry(entry, 'image');
      const ext = candidate.split('.').pop() ?? 'png';
      return `data:${extToMime(ext)};base64,${buf.toString('base64')}`;
    }
    return null;
  }

  // Extract images referenced in content_list
  const imageData: Record<string, string> = {};
  if (Array.isArray(contentList)) {
    for (const item of contentList as Array<Record<string, unknown>>) {
      if (item.type === 'image' && typeof item.img_path === 'string') {
        const base64 = await readImage(item.img_path);
        if (base64) {
          const basename = (item.img_path as string).split('/').pop() ?? item.img_path;
          imageData[basename as string] = base64;
        }
      }
    }
  }

  // Also scan for image files not in content_list (fallback)
  for (const p of filePaths) {
    if (IMAGE_EXTENSION_RE.test(p)) {
      const basename = p.split('/').pop() ?? p;
      if (!imageData[basename]) {
        const base64 = await readImage(p);
        if (base64) imageData[basename] = base64;
      }
    }
  }

  // Build a synthetic fileResult compatible with extractMinerUResult
  const parsed = extractMinerUResult({
    md_content: mdContent,
    images: imageData,
    content_list: contentList,
  });
  return {
    ...parsed,
    metadata: {
      ...(parsed.metadata ?? { pageCount: 0 }),
      parser: 'mineru-cloud',
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Parse a document using the MinerU Cloud v4 API.
 *
 * @param config - Must have `apiKey` (required) and optionally `baseUrl` (defaults to mineru.net/api/v4)
 * @param documentBuffer - Raw document bytes
 * @param sourceFileName - Original filename for the upload
 */
export async function parseWithMinerUCloud(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  sourceFileName?: string,
): Promise<ParsedPdfContent> {
  const token = config.apiKey;
  if (!token) {
    throw new Error('MinerU Cloud API key is required');
  }

  const apiRoot = (config.baseUrl || MINERU_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');
  const uploadFileName = sanitizeFileName(sourceFileName);

  // The API root is a configured provider endpoint — a server-managed/default
  // endpoint or a self-hosted URL the operator opted into with
  // ALLOW_LOCAL_NETWORKS. It always runs under the operator policy (the
  // transport falls back to the env opt-in when `allowLocalNetworks` is
  // undefined); only the response-supplied upload and ZIP URLs are held to the
  // strict public policy.
  const firstHopPolicy = { allowLocalNetworks: undefined };

  log.info(`[MinerU Cloud] Starting parse: ${uploadFileName} (${documentBuffer.byteLength} bytes)`);

  // Step 1: Create batch — request presigned upload URL
  const batchData = await fetchWithRetry(async () => {
    const res = await providerFetch(
      `${apiRoot}/file-urls/batch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{ name: uploadFileName }],
          enable_formula: true,
          enable_table: true,
          model_version: 'vlm',
          language: 'ch',
        }),
        signal: AbortSignal.timeout(TIMEOUTS.batch),
      },
      firstHopPolicy,
    );
    return readMinerUJson<{ batch_id: string; file_urls?: string[]; files?: string[] }>(
      res,
      'file-urls/batch',
    );
  }, 'create batch');

  const uploadUrls = batchData.file_urls ?? batchData.files;
  if (!batchData.batch_id || !uploadUrls?.length) {
    throw new Error('MinerU Cloud batch response missing batch_id or upload URLs');
  }

  log.info(`[MinerU Cloud] Batch ${batchData.batch_id} created, uploading document...`);

  // Step 2: Upload document to presigned URL
  await assertPublicHttpsResponseUrl(uploadUrls[0], 'presigned upload');
  const putRes = await fetchWithRetry(
    () =>
      providerFetch(
        uploadUrls[0],
        {
          method: 'PUT',
          body: new Blob([
            documentBuffer.buffer.slice(
              documentBuffer.byteOffset,
              documentBuffer.byteOffset + documentBuffer.byteLength,
            ) as ArrayBuffer,
          ]),
          signal: AbortSignal.timeout(TIMEOUTS.upload),
          // No Content-Type — presigned OSS URLs are sensitive to headers in the signature
        },
        // A presigned URL identifies one exact destination: a 3xx answer is a
        // hard failure and must never be followed.
        { allowLocalNetworks: false, rejectRedirects: true },
      ),
    'presigned upload',
    5,
  );
  if (!putRes.ok) {
    const text = await readBoundedBody(putRes, MAX_JSON_BYTES, 'presigned upload')
      .then((buf) => buf.toString('utf8'))
      .catch(() => putRes.statusText);
    throw new Error(`MinerU Cloud upload failed (${putRes.status}): ${text.slice(0, 400)}`);
  }

  // Give the backend a moment to register the upload
  await sleep(1_500);

  // Step 3: Poll for completion
  log.info(`[MinerU Cloud] Upload complete, polling for results...`);
  const deadline = Date.now() + POLL_MAX_MS;
  let lastState = '';

  while (Date.now() < deadline) {
    const statusData = await fetchWithRetry(
      async () => {
        const res = await providerFetch(
          `${apiRoot}/extract-results/batch/${batchData.batch_id}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUTS.poll),
          },
          firstHopPolicy,
        );
        return readMinerUJson<{ extract_result?: BatchExtractRow | BatchExtractRow[] }>(
          res,
          'extract-results/batch',
        );
      },
      'poll batch',
      3,
    );

    const rows = statusData.extract_result;
    const list: BatchExtractRow[] = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const row =
      list.find((r) => r.file_name === uploadFileName) ||
      list.find((r) => r.file_name?.toLowerCase() === uploadFileName.toLowerCase()) ||
      list[0];

    if (!row?.state) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (row.state !== lastState) {
      lastState = row.state;
      log.info(`[MinerU Cloud] Batch ${batchData.batch_id} → ${row.state}`);
    }

    if (row.state === 'failed') {
      throw new Error(`MinerU Cloud parsing failed: ${row.err_msg || 'unknown error'}`);
    }

    if (row.state === 'done' && row.full_zip_url) {
      return parseMinerUZip(row.full_zip_url);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `MinerU Cloud timed out after ${POLL_MAX_MS / 1000}s (batch: ${batchData.batch_id})`,
  );
}
