/**
 * MinerU Precision Parsing API (v4)
 * https://mineru.net/api/v4
 *
 * Flow: POST /file-urls/batch → PUT presigned URL → poll /extract-results/batch/{id} → download ZIP
 */

import JSZip from 'jszip';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';
import { extractMinerUResult } from './mineru-parser';

const log = createLogger('MinerUCloudV4');

export const MINERU_CLOUD_V4_API_BASE = 'https://mineru.net/api/v4';

const TIMEOUTS = {
  batch: 60_000,
  upload: 180_000,
  poll: 30_000,
  zip: 180_000,
} as const;

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 15 * 60 * 1000;

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extToMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function urlPathForLog(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname}${pathname}`;
  } catch {
    return url;
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return ['fetch failed', 'econnreset', 'etimedout', 'timeout', 'aborted', 'enotfound'].some((s) =>
    msg.includes(s),
  );
}

async function fetchWithRetry<T>(fn: () => Promise<T>, context: string, attempts = 4): Promise<T> {
  let lastErr: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts) break;
      log.warn(`[MinerU v4] ${context} — retry ${i}/${attempts}:`, err);
      await sleep(400 * i);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`MinerU v4 ${context} failed: ${msg}`);
}

// ── API response helpers ──────────────────────────────────────────────────────

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  trace_id?: string;
  data: T;
}

function unwrapMinerUResponse<T>(json: MinerUEnvelope<T>, context: string): T {
  if (json.code !== 0) {
    throw new Error(`MinerU ${context}: ${json.msg || 'unknown error'} (code ${json.code})`);
  }
  return json.data;
}

async function readMinerUJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();

  let json: MinerUEnvelope<T>;
  try {
    json = JSON.parse(text) as MinerUEnvelope<T>;
  } catch {
    throw new Error(`MinerU ${context}: invalid JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`MinerU ${context}: HTTP ${res.status} — ${json.msg || text.slice(0, 300)}`);
  }

  return unwrapMinerUResponse(json, context);
}

// ── Filename sanitization ─────────────────────────────────────────────────────

export function sanitizePdfFileNameForMinerU(name: string | undefined): string {
  const fallback = 'document.pdf';
  const raw = (name ?? fallback).split(/[/\\]/).pop()?.trim() ?? fallback;
  const trimmed = raw.slice(0, 240);

  if (!trimmed.toLowerCase().endsWith('.pdf')) return fallback;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return fallback;

  return trimmed || fallback;
}

export function isMinerUCloudV4BaseUrl(baseUrl: string): boolean {
  try {
    const { hostname, pathname } = new URL(baseUrl.trim());
    return hostname.toLowerCase() === 'mineru.net' && pathname.replace(/\/+$/, '') === '/api/v4';
  } catch {
    return false;
  }
}

// ── ZIP parsing ───────────────────────────────────────────────────────────────

type BatchExtractRow = {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
};

async function parseMinerUZip(zipUrl: string): Promise<ParsedPdfContent> {
  log.info(`[MinerU v4] Downloading result ZIP: ${urlPathForLog(zipUrl)}`);

  const zipRes = await fetchWithRetry(
    () => fetch(zipUrl, { signal: AbortSignal.timeout(TIMEOUTS.zip) }),
    'ZIP download',
  );

  if (!zipRes.ok) {
    const text = await zipRes.text().catch(() => zipRes.statusText);
    throw new Error(`MinerU ZIP download failed (${zipRes.status}): ${text.slice(0, 300)}`);
  }

  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e) {
    throw new Error(`MinerU ZIP parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const filePaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const fullMdPath = filePaths.find((p) => /(^|\/)full\.md$/i.test(p));
  const contentListPath = filePaths.find(
    (p) => p.endsWith('_content_list.json') || /(^|\/)content_list\.json$/i.test(p),
  );

  if (!fullMdPath) throw new Error('MinerU ZIP: full.md not found');

  const mdContent = await zip.file(fullMdPath)!.async('string');
  const dirPrefix = fullMdPath.includes('/')
    ? fullMdPath.slice(0, fullMdPath.lastIndexOf('/') + 1)
    : '';

  let contentList: unknown;
  if (contentListPath) {
    const raw = await zip.file(contentListPath)!.async('string');
    try {
      contentList = JSON.parse(raw);
    } catch {
      log.warn('[MinerU v4] content_list JSON parse failed, continuing with markdown only');
    }
  }

  async function readImage(relPath: string): Promise<string | null> {
    const normalized = relPath.replace(/^\.?\//, '');
    for (const candidate of [dirPrefix + normalized, normalized]) {
      const entry = zip.file(candidate);
      if (!entry) continue;
      const buf = await entry.async('nodebuffer');
      const ext = candidate.split('.').pop() ?? 'png';
      return `data:${extToMime(ext)};base64,${buf.toString('base64')}`;
    }
    log.warn(`[MinerU v4] Image not found in ZIP: ${relPath}`);
    return null;
  }

  const imageData: Record<string, string> = {};
  if (Array.isArray(contentList)) {
    for (const item of contentList as Array<Record<string, unknown>>) {
      const imgPath = item.img_path;
      if (typeof imgPath === 'string' && imgPath) {
        const dataUrl = await readImage(imgPath);
        if (dataUrl) imageData[imgPath] = dataUrl;
      }
    }
  }

  return extractMinerUResult({
    md_content: mdContent,
    images: imageData,
    content_list: contentList,
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Upload a PDF via MinerU cloud v4 presigned URLs, poll until done, return parsed content.
 */
export async function parseWithMinerUCloudV4(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
  uploadFileName: string,
): Promise<ParsedPdfContent> {
  const apiRoot = config.baseUrl!.trim().replace(/\/+$/, '');
  const token = config.apiKey!.trim();
  const modelVersion = config.mineruModelVersion === 'pipeline' ? 'pipeline' : 'vlm';

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Step 1: Create batch and get presigned upload URL
  log.info(`[MinerU v4] Creating batch for "${uploadFileName}" (model: ${modelVersion})`);

  const batchData = await fetchWithRetry(async () => {
    const res = await fetch(`${apiRoot}/file-urls/batch`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        files: [{ name: uploadFileName }],
        model_version: modelVersion,
        enable_formula: true,
        enable_table: true,
      }),
      signal: AbortSignal.timeout(TIMEOUTS.batch),
    });
    return readMinerUJson<{ batch_id: string; file_urls?: string[]; files?: string[] }>(
      res,
      'file-urls/batch',
    );
  }, 'create batch');

  const uploadUrls = batchData.file_urls ?? batchData.files;
  if (!batchData.batch_id || !uploadUrls?.length) {
    throw new Error('MinerU batch response missing batch_id or upload URLs');
  }

  // Step 2: Upload PDF to presigned URL
  log.info(
    `[MinerU v4] Uploading ${pdfBuffer.byteLength} bytes to ${urlPathForLog(uploadUrls[0])}`,
  );

  const putRes = await fetchWithRetry(
    () =>
      fetch(uploadUrls[0], {
        method: 'PUT',
        body: new Uint8Array(pdfBuffer),
        signal: AbortSignal.timeout(TIMEOUTS.upload),
        redirect: 'manual',
        // No Content-Type — presigned OSS URLs are sensitive to headers in the signature
      }),
    'presigned upload',
    5,
  );

  if (!putRes.ok) {
    const text = await putRes.text().catch(() => putRes.statusText);
    throw new Error(`MinerU upload failed (${putRes.status}): ${text.slice(0, 400)}`);
  }

  // Give the backend a moment to register the upload
  await sleep(1500);

  // Step 3: Poll for completion
  const deadline = Date.now() + POLL_MAX_MS;
  let lastState = '';

  while (Date.now() < deadline) {
    const statusData = await fetchWithRetry(
      async () => {
        log.debug?.(`[MinerU v4] Polling batch ${batchData.batch_id}`);
        const res = await fetch(`${apiRoot}/extract-results/batch/${batchData.batch_id}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUTS.poll),
        });
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
      log.warn('[MinerU v4] Poll returned no result row yet');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (row.state !== lastState) {
      lastState = row.state;
      log.info(`[MinerU v4] Batch ${batchData.batch_id} → ${row.state}`);
    }

    if (row.state === 'failed') {
      throw new Error(`MinerU parsing failed: ${row.err_msg || 'unknown error'}`);
    }

    if (row.state === 'done' && row.full_zip_url) {
      return parseMinerUZip(row.full_zip_url);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`MinerU timed out after ${POLL_MAX_MS / 1000}s (batch: ${batchData.batch_id})`);
}
