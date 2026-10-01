/**
 * The run API as the browser calls it (`/api/generation-runs/**`) and the
 * material upload a run is started from (`POST /api/materials`). Every call is
 * owner-scoped by the request's identity; a failure throws a
 * {@link RunApiError} carrying the route's error code.
 */
import { resolveWorkbenchMaterialMime } from '@/lib/workbench/material-upload-policy';

import type { GenerationRunInput, RunSnapshot } from './types';

export class RunApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'RunApiError';
  }
}

async function failure(response: Response, fallback: string): Promise<RunApiError> {
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
        : `${fallback}: HTTP ${response.status}`;
  return new RunApiError(
    message,
    response.status,
    typeof body?.errorCode === 'string' ? body.errorCode : undefined,
  );
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, fallback);
  return (await response.json()) as T;
}

/** The run input the browser sends: what `POST /api/generation-runs` reads. */
export type StartRunInput = Omit<GenerationRunInput, 'outlineReview'> & { outlineReview: 'wait' };

export async function startGenerationRun(input: StartRunInput): Promise<RunSnapshot> {
  const body = await postJson<{ run: RunSnapshot }>(
    '/api/generation-runs',
    input,
    'Starting the generation failed',
  );
  return body.run;
}

/** The run's snapshot, or null when the owner has no such run. */
export async function fetchGenerationRun(runId: string): Promise<RunSnapshot | null> {
  const response = await fetch(`/api/generation-runs/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, 'Reading the generation failed');
  return ((await response.json()) as { run: RunSnapshot }).run;
}

export async function listActiveGenerationRuns(): Promise<RunSnapshot[]> {
  const response = await fetch('/api/generation-runs?active=1', { cache: 'no-store' });
  if (!response.ok) throw await failure(response, 'Listing the generations failed');
  return ((await response.json()) as { runs: RunSnapshot[] }).runs;
}

export function confirmRunOutline(
  runId: string,
  command: { commandId: string; outlineRevision: number; outlines?: unknown[] },
): Promise<{ state: string; outlineRevision: number }> {
  return postJson(
    `/api/generation-runs/${encodeURIComponent(runId)}/confirm-outline`,
    command,
    'Confirming the outline failed',
  );
}

export function retryRun(
  runId: string,
  command: { commandId: string; media?: { elementId: string } },
): Promise<{ state: string }> {
  return postJson(
    `/api/generation-runs/${encodeURIComponent(runId)}/retry`,
    command,
    'Retrying failed',
  );
}

/** Discard a run that has no course yet (its pending course card). */
export async function discardGenerationRun(runId: string): Promise<void> {
  const response = await fetch(`/api/generation-runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw await failure(response, 'Deleting the generation failed');
  }
}

/** What the server can generate from: the upload formats its extractors read, and the caps. */
export interface MaterialPolicy {
  formats: Array<{ mime: string; extensions?: readonly string[] }>;
  maxCount: number;
  maxTotalBytes: number;
}

export async function fetchMaterialPolicy(): Promise<MaterialPolicy> {
  const response = await fetch('/api/generate-classroom/capabilities', { cache: 'no-store' });
  if (!response.ok) throw await failure(response, 'Reading the supported materials failed');
  return ((await response.json()) as { materials: MaterialPolicy }).materials;
}

/** The MIME type a material is uploaded as (some browsers report OOXML files generically). */
export function materialMime(file: File): string {
  return (
    resolveWorkbenchMaterialMime({ mimeType: file.type, fileName: file.name }) ||
    'application/octet-stream'
  );
}

/** Upload one material to the owner's library; its id. */
export async function uploadMaterial(file: File): Promise<string> {
  const response = await fetch('/api/materials', {
    method: 'POST',
    headers: {
      'content-type': materialMime(file),
      'x-material-filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) throw await failure(response, `Uploading ${file.name} failed`);
  const body = (await response.json()) as { materialId?: unknown };
  if (typeof body.materialId !== 'string') {
    throw new RunApiError(`Uploading ${file.name} failed`, response.status);
  }
  return body.materialId;
}

/** A fresh command id: the idempotency key of one command, reused when it is sent again. */
export function newCommandId(kind: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${random}`;
}
