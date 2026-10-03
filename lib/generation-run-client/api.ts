/**
 * The run API as the browser calls it (`/api/generation-runs/**`) and the
 * material upload a run is started from (`POST /api/materials`). Every call is
 * owner-scoped by the request's identity; a failure throws a
 * {@link RunApiError} carrying the route's error code.
 */
import { resolveWorkbenchMaterialMime } from '@/lib/workbench/material-upload-policy';

import type { GenerationRunInput, RunSnapshot } from './types';

/**
 * A refused or failed call. `serverMessage` is the route's caller-facing
 * message; `fallbackKey` is the translation key that says what failed when the
 * route gave none.
 */
export class RunApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    readonly serverMessage: string | undefined,
    readonly fallbackKey: string,
    readonly fallbackValues: Record<string, string | number> = {},
  ) {
    super(serverMessage ?? `${fallbackKey} (HTTP ${status})`);
    this.name = 'RunApiError';
  }
}

/** What to tell the learner about a failed call. */
export function runApiErrorText(
  error: RunApiError,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (error.errorCode === 'ACTIVE_RUN_LIMIT') return t('generation.activeRunLimit');
  return error.serverMessage ?? t(error.fallbackKey, error.fallbackValues);
}

async function failure(
  response: Response,
  fallbackKey: string,
  fallbackValues: Record<string, string | number> = {},
): Promise<RunApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    errorCode?: unknown;
  } | null;
  const message =
    typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : undefined;
  return new RunApiError(
    response.status,
    typeof body?.errorCode === 'string' ? body.errorCode : undefined,
    message,
    fallbackKey,
    fallbackValues,
  );
}

async function postJson<T>(url: string, body: unknown, fallbackKey: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, fallbackKey);
  return (await response.json()) as T;
}

/** The run input the browser sends: what `POST /api/generation-runs` reads. */
export type StartRunInput = Omit<GenerationRunInput, 'outlineReview'> & { outlineReview: 'wait' };

export async function startGenerationRun(input: StartRunInput): Promise<RunSnapshot> {
  const body = await postJson<{ run: RunSnapshot }>(
    '/api/generation-runs',
    input,
    'upload.generateFailed',
  );
  return body.run;
}

/** The run's snapshot, or null when the owner has no such run. */
export async function fetchGenerationRun(
  runId: string,
  signal?: AbortSignal,
): Promise<RunSnapshot | null> {
  const response = await fetch(`/api/generation-runs/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, 'generation.runLoadFailed');
  return ((await response.json()) as { run: RunSnapshot }).run;
}

/** The owner's limits on runs: in progress, and waiting for their outline to be confirmed. */
export interface RunLimits {
  maxActive: number;
  maxWaiting: number;
}

export async function listActiveGenerationRuns(): Promise<{
  runs: RunSnapshot[];
  limits?: RunLimits;
}> {
  const response = await fetch('/api/generation-runs?active=1', { cache: 'no-store' });
  if (!response.ok) throw await failure(response, 'generation.runLoadFailed');
  return (await response.json()) as { runs: RunSnapshot[]; limits?: RunLimits };
}

export function confirmRunOutline(
  runId: string,
  command: { commandId: string; outlineRevision: number; outlines?: unknown[] },
): Promise<{ state: string; outlineRevision: number }> {
  return postJson(
    `/api/generation-runs/${encodeURIComponent(runId)}/confirm-outline`,
    command,
    'generation.outlineGenerateFailed',
  );
}

export function retryRun(
  runId: string,
  command: { commandId: string; media?: { elementId: string } },
): Promise<{ state: string }> {
  return postJson(
    `/api/generation-runs/${encodeURIComponent(runId)}/retry`,
    command,
    'generation.sceneGenerateFailed',
  );
}

/** Discard a run that has no course yet (its pending course card). */
export async function discardGenerationRun(runId: string): Promise<void> {
  const response = await fetch(`/api/generation-runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw await failure(response, 'upload.generateFailed');
  }
}

/** What the server can generate from: the upload formats its extractors read, and the caps. */
export interface MaterialPolicy {
  formats: Array<{ mime: string; extensions?: readonly string[] }>;
  maxCount: number;
  maxTotalBytes: number;
  /** The per-file caps of documents (and images), and of audio and video. */
  maxDocumentBytes: number;
  maxMediaBytes: number;
}

export async function fetchMaterialPolicy(): Promise<MaterialPolicy> {
  const response = await fetch('/api/generate-classroom/capabilities', { cache: 'no-store' });
  if (!response.ok) throw await failure(response, 'upload.generateFailed');
  return ((await response.json()) as { materials: MaterialPolicy }).materials;
}

/** The MIME type a material is uploaded as (some browsers report OOXML files generically). */
export function materialMime(file: File): string {
  return (
    resolveWorkbenchMaterialMime({ mimeType: file.type, fileName: file.name }) ||
    'application/octet-stream'
  );
}

/** A byte count as the upload limits are written (MB, rounded down; KB below 1 MB). */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.floor(mb)}MB` : `${Math.max(1, Math.floor(bytes / 1024))}KB`;
}

function uploadFailureKey(status: number): string {
  if (status === 413) return 'upload.fileTooLarge';
  if (status === 415) return 'upload.unsupportedMaterialFormat';
  if (status === 429) return 'upload.materialQuotaExceeded';
  return 'upload.materialUploadFailed';
}

/** A material's extraction, as `GET /api/materials/{id}` reports it. */
export interface MaterialExtractionView {
  status: 'idle' | 'extracting' | 'ready' | 'failed';
  error?: string;
  errorCode?: string;
  textChars?: number;
  pageCount?: number;
  imageCount?: number;
  /** What a course leaves out of this material on its own. */
  truncated?: { textChars?: number; images?: { total: number; max: number } };
}

/** One of the owner's uploads, as the materials routes answer it. */
export interface OwnerMaterialView {
  materialId: string;
  originalName?: string;
  bytes: number;
  mime?: string;
  mediaKind: 'document' | 'media';
  extraction?: MaterialExtractionView;
}

/**
 * Upload one material to the owner's library, reporting the share of its
 * bytes sent (an XMLHttpRequest: fetch reports no upload progress). The
 * server starts extracting it at once. Rejects with a {@link RunApiError} the
 * learner can read, or an `AbortError` when `signal` aborts it.
 */
export function uploadMaterial(
  file: File,
  { onProgress, signal }: { onProgress?: (sent: number) => void; signal?: AbortSignal } = {},
): Promise<OwnerMaterialView> {
  return new Promise((resolve, reject) => {
    const failed = (status: number, body: { errorCode?: unknown; maxBytes?: unknown } | null) => {
      const maxBytes =
        typeof body?.maxBytes === 'number' && body.maxBytes > 0 ? body.maxBytes : null;
      // The upload route's refusals are said in the learner's language; a size
      // refusal with the limit the route enforced.
      reject(
        new RunApiError(
          status,
          typeof body?.errorCode === 'string' ? body.errorCode : undefined,
          undefined,
          status === 413 && maxBytes !== null
            ? 'upload.materialTooLarge'
            : uploadFailureKey(status),
          { name: file.name, ...(maxBytes !== null ? { size: formatBytes(maxBytes) } : {}) },
        ),
      );
    };
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/materials');
    xhr.setRequestHeader('content-type', materialMime(file));
    xhr.setRequestHeader('x-material-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: (OwnerMaterialView & { errorCode?: unknown; maxBytes?: unknown }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        failed(xhr.status, body);
        return;
      }
      if (typeof body?.materialId !== 'string') {
        failed(xhr.status || 500, null);
        return;
      }
      resolve(body);
    };
    xhr.onerror = () => failed(0, null);
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** One of the owner's uploads with its extraction, or null once it is gone. */
export async function fetchOwnerMaterial(materialId: string): Promise<OwnerMaterialView | null> {
  const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw await failure(response, 'upload.materialUploadFailed', { name: materialId });
  return ((await response.json()) as { material: OwnerMaterialView }).material;
}

/** Extract an upload whose extraction failed again; the material, now extracting. */
export async function retryMaterialExtraction(materialId: string): Promise<OwnerMaterialView> {
  const body = await postJson<{ material: OwnerMaterialView }>(
    `/api/materials/${encodeURIComponent(materialId)}/extraction`,
    {},
    'upload.materialUploadFailed',
  );
  return body.material;
}

/**
 * Delete one of the owner's uploads (a material removed from the composer, or
 * left in it). `keepalive` lets the request outlive the page that sends it.
 */
export async function deleteMaterial(
  materialId: string,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<void> {
  const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}`, {
    method: 'DELETE',
    keepalive,
  });
  if (!response.ok && response.status !== 404) {
    throw await failure(response, 'upload.materialUploadFailed', { name: materialId });
  }
}

/** A fresh command id: the idempotency key of one command, reused when it is sent again. */
export function newCommandId(kind: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${random}`;
}
