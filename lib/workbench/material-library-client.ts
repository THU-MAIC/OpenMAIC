/**
 * The knowledge base page's requests (RFC #1716 §5, §8): one page of the
 * owner's library sources, the folders and the limits uploads are held to,
 * and the organizing writes, all over the routes that already exist. Pure
 * apart from `fetch`, so the rules are testable without a DOM.
 *
 * The page lists SOURCES only: a source's images and keyframes are reached
 * through it, never organized on their own.
 */

import {
  extractionReasonCodeOf,
  type MaterialExtractionReasonCode,
} from '@/lib/types/material-extraction-failure';
import type { WorkbenchMaterial } from '@/lib/workbench/session-store';

/** How many sources one listing request asks for: the route's ceiling. */
export const MATERIAL_LIBRARY_PAGE_SIZE = 200;

/** The longest display name a source may have (`MATERIAL_NAME_MAX_LENGTH` server-side). */
export const MATERIAL_NAME_MAX_LENGTH = 255;

export type MaterialExtractionStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed';

/** One source as `GET /api/materials/library` returns it. */
export interface LibraryMaterial {
  readonly materialId: string;
  readonly name: string;
  readonly originalName?: string;
  readonly mime?: string;
  readonly bytes: number;
  readonly folderId: string | null;
  readonly folderName?: string;
  /** The original opens in the tab; absent or false, it downloads (the server decides). */
  readonly opensInline?: boolean;
  readonly extraction: {
    readonly status: MaterialExtractionStatus;
    readonly reasonCode?: MaterialExtractionReasonCode;
  };
  readonly createdAt: string;
}

/** One folder as `GET /api/materials/folders` returns it. */
export interface LibraryFolder {
  readonly id: string;
  readonly name: string;
  /** Ready sources filed in it (what the listing shows), not a deletion check. */
  readonly materialCount: number;
  /** Last renamed or created, epoch milliseconds; absent when the answer has none. */
  readonly updatedAt?: number;
}

/** The limits upload admission applies, and the owner's usage of them (§8). */
export interface LibraryLimits {
  readonly documentMaxBytes: number;
  readonly mediaMaxBytes: number;
  readonly maxCount: number;
  readonly maxTotalBytes: number;
  readonly usedCount: number;
  readonly usedBytes: number;
  /** `null`: the deployment has no pool quota. */
  readonly assetQuotaBytes: number | null;
  readonly assetUsedBytes: number;
}

/** Which sources the page shows. Unfiled is the absence of a folder, not a row. */
export type LibraryScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'unfiled' }
  | { readonly kind: 'folder'; readonly folderId: string };

export interface LibraryPage {
  readonly materials: readonly LibraryMaterial[];
  readonly limits?: LibraryLimits;
  /** Present when the page was full: the cursor for the next one. */
  readonly nextBefore?: string;
}

/** A refused or failed library request, as the page reports it. */
export class MaterialLibraryRequestError extends Error {
  constructor(
    readonly status: number,
    /** The library's own refusal (`not_empty`, `name_taken`, ...). */
    readonly reason?: string,
    /** The owner layer's code (`OWNER_BUSY`, `INVALID_CREDENTIAL`, ...). */
    readonly code?: string,
  ) {
    super(`material library request failed (${status}${reason ? ` ${reason}` : ''})`);
    this.name = 'MaterialLibraryRequestError';
  }
}

/**
 * Read a refusal out of any of the three shapes these routes answer with: the
 * library's `{ success: false, errorCode, error, reason }`, the owner layer's
 * `{ error: { code } }`, or the plain-text 404.
 */
export async function materialLibraryErrorOf(
  response: Response,
): Promise<MaterialLibraryRequestError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const nested = record.error && typeof record.error === 'object' ? record.error : undefined;
  const nestedCode = (nested as { code?: unknown } | undefined)?.code;
  const code =
    typeof nestedCode === 'string'
      ? nestedCode
      : typeof record.errorCode === 'string'
        ? record.errorCode
        : undefined;
  return new MaterialLibraryRequestError(response.status, reason, code);
}

/**
 * The i18n key that says why an organizing write was refused: the library's
 * own reason when it gave one, otherwise what the status means.
 */
export function materialLibraryWriteErrorKey(error: unknown): string {
  if (error instanceof MaterialLibraryRequestError) {
    switch (error.reason) {
      case 'name_taken':
        return 'workspace.knowledgeBase.error.nameTaken';
      case 'invalid_name':
        return 'workspace.knowledgeBase.error.invalidName';
      case 'name_empty':
        return 'workspace.knowledgeBase.error.folderNameEmpty';
      case 'name_tooLong':
        return 'workspace.knowledgeBase.error.folderNameTooLong';
      case 'limit':
        return 'workspace.knowledgeBase.error.folderLimit';
      case 'not_movable':
        return 'workspace.knowledgeBase.error.notMovable';
    }
    if (error.status === 404) return 'workspace.knowledgeBase.error.gone';
    if (error.status === 503) return 'workspace.knowledgeBase.error.busy';
    if (error.status === 401 || error.status === 403) {
      return 'workspace.knowledgeBase.error.identity';
    }
  }
  return 'workspace.knowledgeBase.error.save';
}

/** The i18n key that says why a library read failed. */
export function materialLibraryErrorKey(error: unknown): string {
  if (error instanceof MaterialLibraryRequestError) {
    if (error.status === 503) return 'workspace.knowledgeBase.error.busy';
    if (error.status === 401 || error.status === 403) {
      return 'workspace.knowledgeBase.error.identity';
    }
  }
  return 'workspace.knowledgeBase.error.load';
}

function extractionStatusOf(value: unknown): MaterialExtractionStatus {
  return value === 'pending' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'idle'
    ? value
    : 'idle';
}

function materialOf(raw: unknown): LibraryMaterial | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.materialId !== 'string' || typeof item.name !== 'string') return null;
  const extraction =
    item.extraction && typeof item.extraction === 'object'
      ? (item.extraction as Record<string, unknown>)
      : {};
  const status = extractionStatusOf(extraction.status);
  const reasonCode =
    status === 'failed' ? extractionReasonCodeOf(extraction.reasonCode) : undefined;
  return {
    materialId: item.materialId,
    name: item.name,
    ...(typeof item.originalName === 'string' ? { originalName: item.originalName } : {}),
    ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    folderId: typeof item.folderId === 'string' ? item.folderId : null,
    ...(typeof item.folderName === 'string' ? { folderName: item.folderName } : {}),
    ...(item.opensInline === true ? { opensInline: true } : {}),
    extraction: {
      status,
      ...(reasonCode ? { reasonCode } : {}),
    },
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  };
}

function libraryParams(input: {
  readonly scope: LibraryScope;
  readonly query: string;
  readonly before?: string;
  readonly withLimits?: boolean;
}): URLSearchParams {
  // The page shows the limits before an upload (§8), so one read of each
  // refresh asks for them; the others say `limits=0` and skip the usage sums.
  const params = new URLSearchParams({
    sources: '1',
    limit: String(MATERIAL_LIBRARY_PAGE_SIZE),
  });
  if (input.withLimits === false) params.set('limits', '0');
  if (input.scope.kind === 'unfiled') params.set('folderId', 'unfiled');
  if (input.scope.kind === 'folder') params.set('folderId', input.scope.folderId);
  const query = input.query.trim();
  if (query) params.set('query', query);
  if (input.before) params.set('before', input.before);
  return params;
}

/** One page of the scope's sources, newest first. */
export async function fetchMaterialLibraryPage(input: {
  readonly scope: LibraryScope;
  readonly query: string;
  readonly before?: string;
  /** `false`: skip the limits and usage (another read of the same refresh carries them). */
  readonly withLimits?: boolean;
  readonly signal?: AbortSignal;
}): Promise<LibraryPage> {
  const response = await fetch(`/api/materials/library?${libraryParams(input)}`, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) throw await materialLibraryErrorOf(response);
  const body = (await response.json()) as {
    materials?: unknown;
    limits?: LibraryLimits;
    nextBefore?: unknown;
  };
  const materials = Array.isArray(body.materials)
    ? body.materials.flatMap((raw) => materialOf(raw) ?? [])
    : [];
  return {
    materials,
    ...(body.limits ? { limits: body.limits } : {}),
    ...(typeof body.nextBefore === 'string' ? { nextBefore: body.nextBefore } : {}),
  };
}

/** The owner's folders by name, each with its ready-source count. */
export async function fetchMaterialLibraryFolders(
  signal?: AbortSignal,
): Promise<readonly LibraryFolder[]> {
  const response = await fetch('/api/materials/folders', { ...(signal ? { signal } : {}) });
  if (!response.ok) throw await materialLibraryErrorOf(response);
  const body = (await response.json()) as { folders?: unknown };
  if (!Array.isArray(body.folders)) return [];
  return body.folders.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const folder = raw as Record<string, unknown>;
    if (typeof folder.id !== 'string' || typeof folder.name !== 'string') return [];
    return [
      {
        id: folder.id,
        name: folder.name,
        materialCount: typeof folder.materialCount === 'number' ? folder.materialCount : 0,
        ...(typeof folder.updatedAt === 'number' ? { updatedAt: folder.updatedAt } : {}),
      },
    ];
  });
}

/** A source as a composer stages it: the same shape a finished upload or an `@` pick stages. */
export function stagedMaterialOfView(material: LibraryMaterial): WorkbenchMaterial {
  return {
    materialId: material.materialId,
    name: material.name,
    bytes: material.bytes,
    ...(material.mime ? { mimeType: material.mime } : {}),
    extractionStatus: material.extraction.status,
  };
}

/** Pages joined in order, a material listed twice kept at its first place. */
export function joinLibraryPages(
  pages: readonly (readonly LibraryMaterial[])[],
): readonly LibraryMaterial[] {
  const seen = new Set<string>();
  const joined: LibraryMaterial[] = [];
  for (const page of pages) {
    for (const material of page) {
      if (seen.has(material.materialId)) continue;
      seen.add(material.materialId);
      joined.push(material);
    }
  }
  return joined;
}

/** A byte count for people: B, KB, MB or GB with at most one decimal. */
export function formatMaterialBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let number: string;
  try {
    number = new Intl.NumberFormat(locale, {
      maximumFractionDigits: unit === 0 ? 0 : 1,
    }).format(value);
  } catch {
    number = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  }
  return `${number} ${units[unit]}`;
}

async function libraryWrite(url: string, method: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await materialLibraryErrorOf(response);
  return response.json().catch(() => ({}));
}

/** Queue a source idempotently; the page re-reads the authoritative state. */
export async function parseLibraryMaterial(materialId: string): Promise<void> {
  await libraryWrite(`/api/materials/${encodeURIComponent(materialId)}/extraction`, 'POST', {});
}

/** Rename a source's display name; its uploaded file name stays. */
export async function renameLibraryMaterial(materialId: string, name: string): Promise<void> {
  await libraryWrite(`/api/materials/${encodeURIComponent(materialId)}`, 'PATCH', { name });
}

/** Rename a folder. */
export async function renameLibraryFolder(folderId: string, name: string): Promise<void> {
  await libraryWrite(`/api/materials/folders/${encodeURIComponent(folderId)}`, 'PATCH', { name });
}

/**
 * Create a folder, or get the owner's folder of that name back
 * (`created: false`): either way, the folder the name now names.
 */
export async function createLibraryFolder(
  name: string,
): Promise<{ folderId: string; created: boolean }> {
  const body = (await libraryWrite('/api/materials/folders', 'POST', { name })) as {
    folder?: { id?: unknown };
    created?: unknown;
  };
  if (typeof body.folder?.id !== 'string') throw new MaterialLibraryRequestError(500);
  return { folderId: body.folder.id, created: body.created !== false };
}

/** Move sources into a folder, or into Unfiled with `null`: all of them or none. */
export async function moveLibraryMaterials(
  materialIds: readonly string[],
  folderId: string | null,
): Promise<void> {
  await libraryWrite('/api/materials/move', 'POST', { materialIds, folderId });
}

async function libraryDelete(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) throw await materialLibraryErrorOf(response);
}

/**
 * Delete a source and its derivatives (the page-only route, §5). A 204 is the
 * only success here; how a 404 after a failed attempt is read is
 * `deleteOutcomeOf`'s (MaterialLibraryDialogs).
 */
export async function deleteLibraryMaterial(materialId: string): Promise<void> {
  await libraryDelete(`/api/materials/${encodeURIComponent(materialId)}`);
}

/** Delete a folder; refused (409 `not_empty`) while anything is filed in it. */
export async function deleteLibraryFolder(folderId: string): Promise<void> {
  await libraryDelete(`/api/materials/folders/${encodeURIComponent(folderId)}`);
}
