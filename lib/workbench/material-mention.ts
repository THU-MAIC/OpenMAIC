/**
 * The composer's knowledge-base picker: what `@` (and the `@` button) offer
 * besides classrooms (RFC #1716 §4).
 *
 * A pick is a SELECTION, not an attachment: it becomes one more staged
 * material pill, exactly like a finished upload, and is attached only when the
 * message is sent (`POST` with its `materialIds`). Removing the pill before
 * sending attaches nothing; opening the menu, hovering or highlighting a row
 * writes nothing anywhere.
 *
 * Offered: the owner's SOURCES, newest first, matching the typed query. A
 * source's images and keyframes are not rows of their own: attaching the
 * source reaches them. Uploads still in progress are never listed (the
 * library lists ready materials only). Each row says whether this
 * conversation already has the material, or whether it is already staged
 * for this message -- staging it twice is a no-op.
 *
 * Pure apart from the fetch, so the rules are testable without a DOM.
 */
import type { WorkbenchMaterial } from './session-store';

/** How many knowledge-base rows the menu paints at once. */
export const MATERIAL_MENTION_LIMIT = 20;

type ExtractionStatus = NonNullable<WorkbenchMaterial['extractionStatus']>;

export interface MaterialMentionCandidate {
  readonly materialId: string;
  readonly name: string;
  readonly folderName?: string;
  readonly mimeType?: string;
  readonly bytes: number;
  readonly extractionStatus: ExtractionStatus;
  /** This conversation already has it (attached by an earlier message). */
  readonly attached: boolean;
  /** Already a pill on this message: picking it again changes nothing. */
  readonly staged: boolean;
}

/** One material as `GET /api/materials/library` returns it. */
interface LibraryListing {
  materialId: string;
  name: string;
  folderName?: string;
  mime?: string;
  bytes: number;
  extraction?: { status?: string };
  attached?: boolean;
}

function extractionStatusOf(value: unknown): ExtractionStatus {
  return value === 'pending' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'idle'
    ? value
    : 'idle';
}

/** The library's answer as menu rows, staged ones marked. */
export function materialMentionCandidates(
  listed: readonly LibraryListing[],
  stagedIds: ReadonlySet<string>,
): MaterialMentionCandidate[] {
  return listed.slice(0, MATERIAL_MENTION_LIMIT).map((material) => ({
    materialId: material.materialId,
    name: material.name,
    ...(material.folderName ? { folderName: material.folderName } : {}),
    ...(material.mime ? { mimeType: material.mime } : {}),
    bytes: material.bytes,
    extractionStatus: extractionStatusOf(material.extraction?.status),
    attached: material.attached === true,
    staged: stagedIds.has(material.materialId),
  }));
}

/** The pill a pick stages: the same shape a finished upload stages. */
export function stagedMaterialOf(candidate: MaterialMentionCandidate): WorkbenchMaterial {
  return {
    materialId: candidate.materialId,
    name: candidate.name,
    bytes: candidate.bytes,
    ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
    extractionStatus: candidate.extractionStatus,
  };
}

/**
 * Fetch the sources matching `query`, marked for `sessionId` when there is
 * one. Resolves to `[]` when the library cannot be reached: the menu then
 * offers classrooms only, as it did before.
 */
export async function fetchMaterialMentionListing(input: {
  query: string;
  sessionId?: string | null;
  signal?: AbortSignal;
}): Promise<LibraryListing[]> {
  const params = new URLSearchParams({ sources: '1', limit: String(MATERIAL_MENTION_LIMIT) });
  if (input.query.trim()) params.set('query', input.query.trim());
  if (input.sessionId) params.set('sessionId', input.sessionId);
  try {
    const response = await fetch(`/api/materials/library?${params}`, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { materials?: unknown };
    return Array.isArray(body.materials) ? (body.materials as LibraryListing[]) : [];
  } catch {
    return [];
  }
}
