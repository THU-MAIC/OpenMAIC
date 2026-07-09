/**
 * AliDocMind (Aliyun DocMind) shared client.
 *
 * Handles the submit → poll → get flow shared by:
 *   - lib/pdf/pdf-providers.ts       (file-mode: layouts[] → ParsedPdfContent)
 *   - lib/media-parse/media-parse-providers.ts (media-mode: segments[] → MediaArtifact)
 *
 * Docs: https://help.aliyun.com/zh/document-mind/developer-reference/document-parsing-large-model-version
 */

import { Readable } from 'stream';
import Client, * as $Docmind from '@alicloud/docmind-api20220711';
import { Config } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';
import { createLogger } from '@/lib/logger';
import { ALIDOCMIND_DEFAULT_BASE } from '@/lib/pdf/constants';

const log = createLogger('AliDocMind');

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 15 * 60 * 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AliDocMindCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint?: string;
}

export interface AliDocMindSubmitOptions {
  buffer: Buffer;
  fileName: string;
  /** Extension without dot, e.g. 'pdf', 'mp4'. If omitted, inferred from fileName. */
  fileNameExtension?: string;
  /** Enable LLM-based layout/OCR enhancement (file mode). */
  llmEnhancement?: boolean;
  /** 'VLM' to use multimodal LLM for layout analysis (file mode). */
  enhancementMode?: 'VLM';
  /** 'base' (default) or 'advance' (adds synopsis for media). */
  option?: 'base' | 'advance';
  /** Media-only: extra parameters. */
  multimediaParameters?: {
    enableSynopsisParse?: boolean;
    vlParsePrompt?: string;
  };
  outputHtmlTable?: boolean;
}

export interface AliDocMindResult {
  jobId: string;
  data: Record<string, unknown>;
  paragraphCount?: number;
  pageCountEstimate?: number;
  imageCount?: number;
  tableCount?: number;
  tokens?: number;
}

function resolveCredentials(creds: Partial<AliDocMindCredentials>): AliDocMindCredentials {
  const accessKeyId = creds.accessKeyId || process.env.ALIDOCMIND_ACCESS_KEY_ID;
  const accessKeySecret = creds.accessKeySecret || process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error(
      'AliDocMind credentials missing: set accessKeyId + accessKeySecret ' +
        '(or ALIDOCMIND_ACCESS_KEY_ID + ALIDOCMIND_ACCESS_KEY_SECRET env vars)',
    );
  }
  const endpoint = (creds.endpoint || ALIDOCMIND_DEFAULT_BASE).replace(/^https?:\/\//, '');
  return { accessKeyId, accessKeySecret, endpoint };
}

function createClient(creds: AliDocMindCredentials): Client {
  const config = new Config({
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    endpoint: creds.endpoint,
  });
  return new Client(config);
}

function inferExtension(fileName: string, explicit?: string): string {
  if (explicit) return explicit.replace(/^\./, '').toLowerCase();
  const ext = fileName.split('.').pop();
  if (!ext || ext === fileName) throw new Error(`Cannot infer file extension from "${fileName}"`);
  return ext.toLowerCase();
}

/**
 * Submit a parse job, poll until done, return the raw `data` map.
 * Callers decode `data.layouts[]` (file) or `data.segments[]` (media).
 */
export async function parseWithAliDocMindClient(
  creds: Partial<AliDocMindCredentials>,
  options: AliDocMindSubmitOptions,
): Promise<AliDocMindResult> {
  const resolved = resolveCredentials(creds);
  const client = createClient(resolved);

  const fileNameExtension = inferExtension(options.fileName, options.fileNameExtension);

  const request = new $Docmind.SubmitDocParserJobAdvanceRequest({
    fileName: options.fileName,
    fileNameExtension,
    fileUrlObject: Readable.from(options.buffer),
    llmEnhancement: options.llmEnhancement,
    enhancementMode: options.enhancementMode,
    option: options.option,
    outputHtmlTable: options.outputHtmlTable,
    multimediaParameters: options.multimediaParameters
      ? new $Docmind.SubmitDocParserJobAdvanceRequestMultimediaParameters(
          options.multimediaParameters,
        )
      : undefined,
  });

  const runtime = new RuntimeOptions({
    // Large files need generous read/connect timeouts (default is 3s which
    // fails on multi-MB uploads to the OSS presigned URL).
    connectTimeout: 30_000,
    readTimeout: 5 * 60_000,
  });
  log.info(`Submitting ${options.fileName} (${options.buffer.byteLength} bytes)`);
  const submitRes = await client.submitDocParserJobAdvance(request, runtime);
  const jobId = submitRes.body?.data?.id;
  if (!jobId) {
    throw new Error(`AliDocMind submit returned no job id: ${JSON.stringify(submitRes.body)}`);
  }
  log.info(`Job ${jobId} submitted, polling…`);

  const deadline = Date.now() + POLL_MAX_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const statusRes = await client.queryDocParserStatus(
      new $Docmind.QueryDocParserStatusRequest({ id: jobId }),
    );
    const data = statusRes.body?.data;
    const status = (data?.status ?? '').toLowerCase();
    if (status && status !== lastStatus) {
      log.info(`Job ${jobId} → ${status}`);
      lastStatus = status;
    }
    if (status === 'fail' || status === 'failed') {
      throw new Error(`AliDocMind job ${jobId} failed: ${statusRes.body?.message ?? 'unknown'}`);
    }
    if (status === 'success') {
      const result = await fetchResult(client, jobId);
      return {
        jobId,
        data: result,
        paragraphCount: data?.paragraphCount,
        pageCountEstimate: data?.pageCountEstimate,
        imageCount: data?.imageCount,
        tableCount: data?.tableCount,
        tokens: data?.tokens,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`AliDocMind job ${jobId} timed out after ${POLL_MAX_MS / 1000}s`);
}

async function fetchResult(client: Client, jobId: string): Promise<Record<string, unknown>> {
  const STEP = 100;
  const merged: {
    layouts?: unknown[];
    segments?: unknown[];
    synopsis_result?: string;
    [k: string]: unknown;
  } = {};
  let layoutNum = 0;

  while (true) {
    const res = await client.getDocParserResult(
      new $Docmind.GetDocParserResultRequest({
        id: jobId,
        layoutNum,
        layoutStepSize: STEP,
      }),
    );
    const data = (res.body?.data ?? {}) as Record<string, unknown>;

    const layouts = Array.isArray(data.layouts) ? (data.layouts as unknown[]) : [];
    const segments = Array.isArray(data.segments) ? (data.segments as unknown[]) : [];

    if (layouts.length === 0 && segments.length === 0 && layoutNum > 0) break;

    if (layouts.length) merged.layouts = (merged.layouts ?? []).concat(layouts);
    if (segments.length) merged.segments = (merged.segments ?? []).concat(segments);

    // pass through top-level scalar fields once
    for (const [k, v] of Object.entries(data)) {
      if (k === 'layouts' || k === 'segments') continue;
      if (merged[k] === undefined) merged[k] = v;
    }

    if (layouts.length < STEP && segments.length < STEP) break;
    layoutNum += Math.max(layouts.length, segments.length);
    if (layoutNum > 100_000) {
      log.warn(`AliDocMind result exceeded 100k blocks, truncating`);
      break;
    }
  }

  return merged;
}

/**
 * Verify AliDocMind credentials without submitting a real job.
 *
 * Queries a bogus job id: valid credentials return a "not found"-style business
 * error, while bad credentials surface a signature/auth error. We treat only
 * auth-level failures as invalid.
 */
export async function verifyAliDocMindCredentials(
  creds: Partial<AliDocMindCredentials>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = resolveCredentials(creds);
  const client = createClient(resolved);
  try {
    await client.queryDocParserStatus(
      new $Docmind.QueryDocParserStatusRequest({ id: 'verify-connection-probe' }),
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const isAuthError =
      lower.includes('signature') ||
      lower.includes('accesskey') ||
      lower.includes('access key') ||
      lower.includes('forbidden') ||
      lower.includes('unauthorized') ||
      lower.includes('invalidaccesskey') ||
      lower.includes('nopermission');
    if (isAuthError) {
      return { ok: false, error: msg };
    }
    // Any non-auth error (e.g. "job not found") means credentials are valid.
    return { ok: true };
  }
}
