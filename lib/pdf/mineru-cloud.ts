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
import { createLogger } from '@/lib/logger';

const log = createLogger('MinerUCloud');

const TIMEOUTS = {
  batch: 60_000,
  upload: 180_000,
  poll: 30_000,
  zip: 180_000,
} as const;

const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function extToMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return ['fetch failed', 'econnreset', 'etimedout', 'timeout', 'aborted'].some((s) =>
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
      log.warn(`[MinerU Cloud] ${context} — retry ${i}/${attempts}:`, err);
      await sleep(400 * i);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`MinerU Cloud ${context} failed: ${msg}`);
}

// ── API envelope ──────────────────────────────────────────────────────────────

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

async function readMinerUJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
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

// ── Filename sanitization ─────────────────────────────────────────────────────

function sanitizeFileName(name: string | undefined): string {
  const fallback = 'document.pdf';
  const raw = (name ?? fallback).split(/[/\\]/).pop()?.trim() ?? fallback;
  const trimmed = raw.slice(0, 240);
  if (!trimmed.toLowerCase().endsWith('.pdf')) return fallback;
  if (trimmed.includes('..')) return fallback;
  return trimmed || fallback;
}

// ── ZIP parsing ───────────────────────────────────────────────────────────────

interface BatchExtractRow {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

async function parseMinerUZip(zipUrl: string): Promise<ParsedPdfContent> {
  log.info('[MinerU Cloud] Downloading result ZIP...');

  const zipRes = await fetchWithRetry(
    () => fetch(zipUrl, { signal: AbortSignal.timeout(TIMEOUTS.zip) }),
    'ZIP download',
  );
  if (!zipRes.ok) {
    const text = await zipRes.text().catch(() => zipRes.statusText);
    throw new Error(`MinerU Cloud ZIP download failed (${zipRes.status}): ${text.slice(0, 300)}`);
  }

  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e) {
    throw new Error(`MinerU Cloud ZIP parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

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

  const mdContent = await zip.file(fullMdPath)!.async('string');
  const dirPrefix = fullMdPath.includes('/')
    ? fullMdPath.slice(0, fullMdPath.lastIndexOf('/') + 1)
    : '';

  // Parse content_list.json if present
  let contentList: unknown;
  if (contentListPath) {
    const raw = await zip.file(contentListPath)!.async('string');
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
      const buf = await entry.async('nodebuffer');
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
    if (/\.(png|jpe?g|webp|gif)$/i.test(p)) {
      const basename = p.split('/').pop() ?? p;
      if (!imageData[basename]) {
        const base64 = await readImage(p);
        if (base64) imageData[basename] = base64;
      }
    }
  }

  // Build a synthetic fileResult compatible with extractMinerUResult
  return extractMinerUResult({
    md_content: mdContent,
    images: imageData,
    content_list: contentList,
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Parse a PDF using the MinerU Cloud v4 API.
 *
 * @param config - Must have `apiKey` (required) and optionally `baseUrl` (defaults to mineru.net/api/v4)
 * @param pdfBuffer - Raw PDF bytes
 * @param sourceFileName - Original filename for the upload
 */
export async function parseWithMinerUCloud(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
  sourceFileName?: string,
): Promise<ParsedPdfContent> {
  const token = config.apiKey;
  if (!token) {
    throw new Error('MinerU Cloud API key is required');
  }

  const apiRoot = (config.baseUrl || MINERU_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');
  const uploadFileName = sanitizeFileName(sourceFileName);

  log.info(`[MinerU Cloud] Starting parse: ${uploadFileName} (${pdfBuffer.byteLength} bytes)`);

  // Step 1: Create batch — request presigned upload URL
  const batchData = await fetchWithRetry(async () => {
    const res = await fetch(`${apiRoot}/file-urls/batch`, {
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
    });
    return readMinerUJson<{ batch_id: string; file_urls?: string[]; files?: string[] }>(
      res,
      'file-urls/batch',
    );
  }, 'create batch');

  const uploadUrls = batchData.file_urls ?? batchData.files;
  if (!batchData.batch_id || !uploadUrls?.length) {
    throw new Error('MinerU Cloud batch response missing batch_id or upload URLs');
  }

  log.info(`[MinerU Cloud] Batch ${batchData.batch_id} created, uploading PDF...`);

  // Step 2: Upload PDF to presigned URL
  const putRes = await fetchWithRetry(
    () =>
      fetch(uploadUrls[0], {
        method: 'PUT',
        body: new Blob([
          pdfBuffer.buffer.slice(
            pdfBuffer.byteOffset,
            pdfBuffer.byteOffset + pdfBuffer.byteLength,
          ) as ArrayBuffer,
        ]),
        signal: AbortSignal.timeout(TIMEOUTS.upload),
        // No Content-Type — presigned OSS URLs are sensitive to headers in the signature
      }),
    'presigned upload',
    5,
  );
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => putRes.statusText);
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
