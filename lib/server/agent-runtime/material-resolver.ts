/**
 * One material id, whichever kind of row it names (RFC #1716 §4, §9).
 *
 * A conversation knows its materials by two kinds of id:
 *
 * - **Session rows** (`agent_session_materials`): copies the binder made
 *   before links, their extraction and transcript rows, fetched web pages and
 *   audio clips. They keep being read exactly as before, from the session's
 *   byte prefix.
 * - **Owner materials** (`owner_material`): library sources the session
 *   links, their media derivatives, and -- in library scope -- any live
 *   material of the session's owner.
 *
 * Every consumer of a material id resolves it here, then reads through the
 * readers below. A session row wins over an owner material of the same id:
 * the pre-upgrade binder keyed copies on the owner id, and such a copy keeps
 * meaning what it meant.
 *
 * Resolving decides who may read; the readers only read. Owner bytes are read
 * from the row as it was just resolved (its id, owner, pool pointer, old
 * object and digest), never from anything stored on a link.
 */
import type { AgentSessionMaterial } from '@openmaic/storage';

import {
  getLinkedOwnerMaterial,
  getSessionOwnerMaterial,
  listLinkedOwnerMaterials,
  type OwnerMaterialEntry,
} from '@/lib/persistence/session-material-links';
import {
  OwnerMaterialBytesUnavailableError,
  readOwnerMaterialBytes,
} from '@/lib/server/materials/owner-material-bytes';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';

import {
  getSessionMaterial,
  getSessionMaterialQueryable,
  listSessionMaterials,
  resolveSessionMaterialRawAsset,
  resolveSessionMaterialText,
} from './session-materials';

/** `session`: what the conversation attached or made. `library`: the owner's whole library. */
export type MaterialScope = 'session' | 'library';

export type ResolvedMaterial =
  | { origin: 'session'; record: AgentSessionMaterial }
  | { origin: 'owner'; entry: OwnerMaterialEntry };

/** The pool, once the links table exists (see `getSessionMaterialQueryable`). */
const pool = getSessionMaterialQueryable;

/** The id a resolved material is known by. */
export function resolvedMaterialId(material: ResolvedMaterial): string {
  return material.origin === 'session' ? material.record.id : material.entry.id;
}

/**
 * Resolve one id in `scope`, or `null` when it names nothing the session may
 * read there. The session's own rows come first in either scope, so an id
 * means the same row whichever scope names it. Then session scope reaches
 * the materials the session's links reach, library scope the owner's live
 * materials, attached or not. Foreign, missing and deleted ids are all
 * `null`, so the answer says nothing about whether another owner has the id.
 */
export async function resolveMaterial(
  sessionId: string,
  materialId: string,
  scope: MaterialScope = 'session',
): Promise<ResolvedMaterial | null> {
  const record = await getSessionMaterial(sessionId, materialId);
  if (record) return { origin: 'session', record };
  const entry =
    scope === 'library'
      ? await getSessionOwnerMaterial(await pool(), sessionId, materialId)
      : await getLinkedOwnerMaterial(await pool(), sessionId, materialId);
  return entry ? { origin: 'owner', entry } : null;
}

/**
 * Everything the session reaches in session scope: its own rows, newest
 * first, then the materials its links reach, each source before its
 * derivatives.
 */
export async function listSessionScopeMaterials(sessionId: string): Promise<ResolvedMaterial[]> {
  const [records, entries] = await Promise.all([
    listSessionMaterials(sessionId),
    listLinkedOwnerMaterials(await pool(), sessionId),
  ]);
  return [
    ...records.map((record) => ({ origin: 'session' as const, record })),
    ...entries.map((entry) => ({ origin: 'owner' as const, entry })),
  ];
}

/**
 * One page of what the session reaches in session scope, in the order of
 * {@link listSessionScopeMaterials}: its own rows newest first, then the
 * materials its links reach. `before` is the last id of the previous page,
 * of either kind; an id the session does not reach answers an empty page, as
 * the session rows' own paging does. The links are listed only once the
 * session's rows run out on a page.
 */
export async function listSessionScopePage(
  sessionId: string,
  options: { limit?: number; before?: string } = {},
): Promise<ResolvedMaterial[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const { before } = options;
  const linkedPage = (entries: OwnerMaterialEntry[]) =>
    entries.map((entry) => ({ origin: 'owner' as const, entry }));
  if (before === undefined || (await getSessionMaterial(sessionId, before))) {
    const records = await listSessionMaterials(sessionId, {
      limit,
      ...(before === undefined ? {} : { before }),
    });
    const page: ResolvedMaterial[] = records.map((record) => ({
      origin: 'session' as const,
      record,
    }));
    if (records.length === limit) return page;
    const linked = await listLinkedOwnerMaterials(await pool(), sessionId);
    return [...page, ...linkedPage(linked.slice(0, limit - records.length))];
  }
  const linked = await listLinkedOwnerMaterials(await pool(), sessionId);
  const cursor = linked.findIndex((entry) => entry.id === before);
  return cursor < 0 ? [] : linkedPage(linked.slice(cursor + 1, cursor + 1 + limit));
}

/** A material's original bytes and their media type, or `null` when unreadable. */
export async function readResolvedMaterialRaw(
  sessionId: string,
  material: ResolvedMaterial,
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (material.origin === 'session') {
    const { rawAssetId } = material.record;
    return rawAssetId ? resolveSessionMaterialRawAsset(sessionId, rawAssetId) : null;
  }
  const { entry } = material;
  try {
    const bytes = await readOwnerMaterialBytes({
      id: entry.id,
      ownerId: entry.ownerId,
      assetId: entry.assetId,
      ossKey: entry.ossKey,
      sha256: entry.sha256,
    });
    return { bytes, mime: entry.mime ?? 'application/octet-stream' };
  } catch (error) {
    if (error instanceof OwnerMaterialBytesUnavailableError) return null;
    throw error;
  }
}

/**
 * The revision of a session row's text. Session text is written once and
 * never replaced, so its revision is fixed by the row.
 */
export function sessionTextRevision(record: AgentSessionMaterial): string {
  return `session:${record.id}`;
}

/**
 * A material's readable text and its revision, or `null` when it has none
 * that can be read: a session extraction, transcript or web row's text, or an
 * owner source's latest successful extraction.
 */
export async function readResolvedMaterialText(
  sessionId: string,
  material: ResolvedMaterial,
): Promise<{ text: string; revision: string } | null> {
  if (material.origin === 'session') {
    const { record } = material;
    if (record.textAssetId === null) return null;
    const raw = await resolveSessionMaterialText(sessionId, record.textAssetId);
    return raw ? { text: raw.toString('utf8'), revision: sessionTextRevision(record) } : null;
  }
  const { entry } = material;
  // Read just now: a source without a result has no text to look for.
  if (entry.kind !== 'source' || !entry.extractionResult) return null;
  return readOwnerMaterialText(entry);
}

/**
 * What a consumer of original bytes needs of a material: the id it is known
 * by, its kind and name, and a read of its bytes. `import_pptx`, `clip_audio`
 * and `use_material_media` take one of these, whichever kind of row it is.
 */
export interface RawMaterialHandle {
  id: string;
  kind: string;
  title: string | null;
  /** Whether the material records original bytes at all (a web page does not). */
  hasBytes: boolean;
  read(): Promise<{ bytes: Buffer; mime: string } | null>;
}

export function rawMaterialHandle(
  sessionId: string,
  material: ResolvedMaterial,
): RawMaterialHandle {
  return {
    id: resolvedMaterialId(material),
    kind: material.origin === 'session' ? material.record.kind : material.entry.kind,
    title:
      material.origin === 'session'
        ? material.record.title
        : (material.entry.displayName ?? material.entry.originalName),
    hasBytes: material.origin === 'session' ? material.record.rawAssetId !== null : true,
    read: () => readResolvedMaterialRaw(sessionId, material),
  };
}

/** Resolve one id in `scope` to a {@link RawMaterialHandle}, or `null`. */
export async function resolveRawMaterial(
  sessionId: string,
  materialId: string,
  scope: MaterialScope = 'session',
): Promise<RawMaterialHandle | null> {
  const material = await resolveMaterial(sessionId, materialId, scope);
  return material ? rawMaterialHandle(sessionId, material) : null;
}

/**
 * The session-row seams some consumers' tests inject, as a handle lookup: a
 * row lookup and a read of a row's raw bytes.
 */
export function sessionRowRawLookup(
  getMaterial: (sessionId: string, materialId: string) => Promise<AgentSessionMaterial | null>,
  readBytes: (record: AgentSessionMaterial) => Promise<{ bytes: Buffer; mime: string } | null>,
): (sessionId: string, materialId: string) => Promise<RawMaterialHandle | null> {
  return async (sessionId, materialId) => {
    const record = await getMaterial(sessionId, materialId);
    return record
      ? {
          id: record.id,
          kind: record.kind,
          title: record.title,
          hasBytes: record.rawAssetId !== null,
          read: () => readBytes(record),
        }
      : null;
  };
}
