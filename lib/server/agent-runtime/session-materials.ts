/**
 * Session-scoped web materials — host adapter.
 *
 * The durable row is stored in the package's `agent_session_materials` table
 * (create/list/read paging over `PgAgentSessionMaterialStore`, lazy-bound like
 * `store.ts` / `user-skill-store.ts`). The bytes are not kept on the row: the
 * extracted markdown is stored through the neutral material byte store and
 * the row records its object key. The package's legacy `textAssetId` and
 * `rawAssetId` field names remain as compatibility columns, but their values
 * are byte-store keys rather than registry ids.
 */
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  createMaterialId,
  type AgentSessionMaterial,
  type AgentSessionMeta,
  type ListAgentSessionMaterialsOptions,
} from '@openmaic/storage';
import {
  attachOwnerMaterialsToSession,
  ensureSessionMaterialLinkSchema,
} from '@/lib/persistence/session-material-links';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';

import { getAgentSessionStore } from './store';
import type { ExtractedWebPage } from './fetch-url';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';

interface AgentSessionMaterialStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionMaterialStore>;
}

const MATERIAL_STORE_STATE_KEY = Symbol.for('openmaic.agent-session-material.store');

export class SessionMaterialBindingError extends Error {
  override readonly name = 'SessionMaterialBindingError';
}
const globalState = globalThis as typeof globalThis & {
  [MATERIAL_STORE_STATE_KEY]?: AgentSessionMaterialStoreState;
};
const storeState = (globalState[MATERIAL_STORE_STATE_KEY] ??= {});

async function createMaterialStore(connectionString: string): Promise<PgAgentSessionMaterialStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  // The material table references agent_sessions(id), so the agent-session
  // schema (provisioned by getAgentSessionStore) must exist first — the same
  // dependency the URL trust-gate table has inside that schema.
  await withSchemaBootstrapLock(pool as unknown as ConnectableQueryable, async (locked) => {
    await ensureAgentSessionMaterialSchema(locked);
    // Links reference agent_sessions too, and are read beside the copies.
    await ensureSessionMaterialLinkSchema(locked);
  });
  return new PgAgentSessionMaterialStore(pool);
}

/**
 * Return the process-wide session-material store, initializing its schema
 * lazily. Failed initialization is cleared so a later request can retry after
 * the database becomes available.
 */
export function getAgentSessionMaterialStore(): Promise<PgAgentSessionMaterialStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createMaterialStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}

/**
 * The pool, once the session-material schema -- the links table included -- is
 * provisioned. Every read or write of `agent_session_material_links` goes
 * through here: on a database upgraded from before links, the table is
 * created by this lazy bootstrap, and a query that did not wait for it would
 * find no table.
 */
export async function getSessionMaterialQueryable(): Promise<Queryable> {
  await getAgentSessionMaterialStore();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  return (await getServerPersistenceProvider(connectionString)).pool;
}

function sessionMaterialPrefix(sessionId: string): string {
  return `materials/${sessionId}/`;
}

function sessionMaterialKey(sessionId: string, materialId: string, name: string): string {
  return `${sessionMaterialPrefix(sessionId)}${materialId}/${name}`;
}

function rawObjectName(mime: string): string {
  return `raw.${Buffer.from(mime, 'utf8').toString('base64url')}`;
}

function rawObjectMime(key: string): string {
  const encoded = key
    .split('/')
    .at(-1)
    ?.match(/^raw\.([A-Za-z0-9_-]+)$/)?.[1];
  if (!encoded) return 'application/octet-stream';
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8') || 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

function isSessionMaterialKey(sessionId: string, key: string): boolean {
  return key.startsWith(sessionMaterialPrefix(sessionId));
}

/**
 * Persist a fetched web page as a session material: the extracted markdown
 * goes into the byte store, the material row records the object key plus the
 * fetch's provenance (title / source URL / text character count). A confirmed
 * material-row failure removes the just-stored object. Ambiguous
 * database outcomes are verified before cleanup so a committed row never has
 * its asset removed underneath it.
 */
export async function createWebMaterial(
  sessionId: string,
  page: ExtractedWebPage,
): Promise<AgentSessionMaterial> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const id = createMaterialId();
  const body = Buffer.from(page.markdown, 'utf8');
  const textObjectKey = sessionMaterialKey(sessionId, id, 'text.md');
  const byteStore = getMaterialByteStore();
  // Initialize the row store before writing bytes, narrowing the non-atomic
  // byte/metadata handoff to the two business writes themselves.
  const store = await getAgentSessionMaterialStore();
  await byteStore.put(textObjectKey, body, 'text/markdown');
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId: textObjectKey,
      textChars: page.markdown.length,
    });
  } catch (error) {
    // A database connection can fail after PostgreSQL committed the INSERT.
    // Verify absence before compensating; otherwise cleanup could delete the
    // object underneath a durable material row. If verification itself fails,
    // preserve the object and let orphan reconciliation handle it rather than
    // risk creating a dangling row.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await byteStore.delete(textObjectKey).catch(() => undefined);
    }
    throw error;
  }
}

/** A user-uploaded source file, persisted through the same seams as a fetch. */
export interface CreateSourceMaterialInput {
  /** Display name of the uploaded file (the `x-material-filename` header). */
  filename: string;
  /** Canonical MIME type of the uploaded bytes. */
  mimeType: string;
  /** The uploaded bytes. */
  bytes: Buffer;
}

/**
 * Persist a user-uploaded file as a session material: the raw bytes go into
 * the byte store under the session's own prefix and the material row records
 * its object key in the compatibility `rawAssetId` column. The kind is `source`,
 * the same vocabulary the reference uses for uploads: source records carry no
 * readable text by design (the agent reads extraction or image derivatives
 * instead), so `textChars` stays 0 and only `rawAssetId` is recorded. A
 * confirmed material-row failure removes the just-stored asset; ambiguous
 * database outcomes are verified before cleanup, exactly like the web path.
 */
export async function createSourceMaterial(
  sessionId: string,
  input: CreateSourceMaterialInput,
): Promise<AgentSessionMaterial> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const id = createMaterialId();
  const body = Buffer.from(input.bytes);
  const rawObjectKey = sessionMaterialKey(sessionId, id, rawObjectName(input.mimeType));
  const byteStore = getMaterialByteStore();
  const store = await getAgentSessionMaterialStore();
  await byteStore.put(rawObjectKey, body, input.mimeType);
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'source',
      title: input.filename,
      rawAssetId: rawObjectKey,
      textChars: 0,
    });
  } catch (error) {
    // Same ambiguous-commit discipline as createWebMaterial: only remove the
    // asset when the row is confirmed absent.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await byteStore.delete(rawObjectKey).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Attach owner-library sources to a session when a message is sent (RFC #1716
 * §4): by id, through `agent_session_material_links`. Nothing is copied and no
 * session row is minted; every consumer reads the source as it is now
 * (`./material-resolver.ts`). A source the session already holds a copy of --
 * from before links -- keeps that copy, so the conversation never lists one
 * file twice. Repeating an attachment changes nothing.
 *
 * Refused as a whole, attaching nothing, unless every id is the owner's ready,
 * undeleted source: another owner's, a derivative, an upload still in
 * progress or a deleted one is `SessionMaterialBindingError`.
 *
 * Returns the id the conversation knows each material by (the source's own id
 * for a link, the copy's id for a copy) with the metadata the message records.
 */
export async function bindOwnerMaterialsToSession(
  sessionId: string,
  ownerId: string,
  materialIds: readonly string[],
): Promise<Array<{ materialId: string; originalName?: string; mime?: string; bytes: number }>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  // The links table is provisioned with the session-material schema.
  await getAgentSessionMaterialStore();
  const provider = await getServerPersistenceProvider(connectionString);
  const outcome = await attachOwnerMaterialsToSession(provider, {
    sessionId,
    ownerId,
    materialIds,
  });
  if (outcome.status !== 'attached') {
    throw new SessionMaterialBindingError('one or more materials are unavailable');
  }
  return outcome.materials.map(({ materialId, record }) => ({
    materialId,
    ...(record.originalName ? { originalName: record.originalName } : {}),
    ...(record.mime ? { mime: record.mime } : {}),
    bytes: record.bytes,
  }));
}

/**
 * The HTTP-visible projection of one material row — the same shape the
 * `list_materials` agent tool exposes. Object keys stay off the wire.
 */
export function publicMaterialView(record: AgentSessionMaterial): Record<string, unknown> {
  return {
    materialId: record.id,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    textChars: record.textChars,
    extraction: record.extraction,
    createdAt: record.createdAt,
  };
}

/**
 * Resolve a session the owner may reach, or `null` — the materials routes'
 * ownership gate. Materials are session-scoped, so an HTTP client must name
 * the session it means; the session's own owner row is the authorization, and
 * a foreign or missing session answers the same `null` (no existence oracle).
 */
export async function resolveOwnedSession(
  sessionId: string,
  ownerId: string,
): Promise<AgentSessionMeta | null> {
  const store = await getAgentSessionStore();
  const session = await store.getSession(sessionId);
  return session && session.ownerId === ownerId ? session : null;
}

/** Newest-first session material listing with keyset paging. */
export async function listSessionMaterials(
  sessionId: string,
  options?: ListAgentSessionMaterialsOptions,
): Promise<AgentSessionMaterial[]> {
  const store = await getAgentSessionMaterialStore();
  return store.listMaterials(sessionId, options);
}

/** Session-scoped material read; foreign and nonexistent ids read as absent. */
export async function getSessionMaterial(
  sessionId: string,
  materialId: string,
): Promise<AgentSessionMaterial | null> {
  const store = await getAgentSessionMaterialStore();
  return store.getMaterial(sessionId, materialId);
}

/**
 * Resolve a material's recorded text object to its bytes, or `null` when the
 * object is absent. The lookup is scoped to the session's own byte prefix, so
 * a foreign or stale `textAssetId` — even one read off another
 * session's row — resolves as a miss, never as another session's content.
 */
export async function resolveSessionMaterialText(
  sessionId: string,
  textAssetId: string,
): Promise<Buffer | null> {
  if (!isSessionMaterialKey(sessionId, textAssetId)) return null;
  try {
    return await getMaterialByteStore().get(textAssetId);
  } catch {
    return null;
  }
}

/**
 * Persist raw bytes (e.g. an uploaded audio/video source or a derived clip)
 * into the session's material byte prefix and return its object key for the
 * material row's compatibility `rawAssetId` slot.
 */
export async function storeSessionMaterialRawAsset(
  sessionId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const key = sessionMaterialKey(sessionId, createMaterialId(), rawObjectName(mime));
  await getMaterialByteStore().put(key, bytes, mime);
  return key;
}

/**
 * Resolve a material row's raw bytes (audio/video source or derived clip) to
 * their bytes plus encoded media type, or `null` when the object is absent.
 * Scoped to the session's own prefix like `resolveSessionMaterialText`.
 */
export async function resolveSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!isSessionMaterialKey(sessionId, rawAssetId)) return null;
  try {
    return { bytes: await getMaterialByteStore().get(rawAssetId), mime: rawObjectMime(rawAssetId) };
  } catch {
    return null;
  }
}

/**
 * Remove a raw object from the session's material prefix (compensation for a
 * failed material-row write). A no-op for foreign keys.
 */
export async function removeSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<void> {
  if (!isSessionMaterialKey(sessionId, rawAssetId)) return;
  await getMaterialByteStore().delete(rawAssetId);
}
