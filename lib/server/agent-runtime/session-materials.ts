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
import { createHash } from 'node:crypto';

import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  createMaterialId,
  isMaterialExtractionErrorCode,
  type AgentSessionMaterial,
  type AgentSessionMaterialKind,
  type AgentSessionMeta,
  type AgentSessionStore,
  type ListAgentSessionMaterialsOptions,
  type MaterialExtractionState,
} from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getMaterialByteStore, type MaterialByteStore } from '@/lib/server/materials/bytes';
import {
  isLegacySessionMaterialObjectKey,
  isSessionMaterialObjectKey,
  legacySessionMaterialObjectPrefix,
  sessionMaterialObjectKey,
  sessionMaterialObjectPrefix,
} from '@/lib/server/materials/object-keys';
import {
  verifyOwnerMaterialBytes,
  type VerifiedOwnerMaterialAsset,
} from '@/lib/server/materials/owner-assets';

import { getAgentSessionStore, nodePostgresTransaction } from './store';
import { isPptxMaterial } from './pptx-mime';
import type { ExtractedWebPage } from './fetch-url';

interface AgentSessionMaterialStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionMaterialStore>;
}

const MATERIAL_STORE_STATE_KEY = Symbol.for('openmaic.agent-session-material.store');

export class SessionMaterialBindingError extends Error {
  override readonly name = 'SessionMaterialBindingError';
}

export interface SessionMaterialBindingDependencies {
  queryable?: Queryable;
  byteStore?: MaterialByteStore;
  sessionStore?: Pick<AgentSessionStore, 'getSession'>;
  materialStore?: Pick<
    PgAgentSessionMaterialStore,
    | 'claimMaterialWrite'
    | 'createMaterial'
    | 'deleteMaterial'
    | 'discardMaterialWrite'
    | 'executeClaimedMaterialWrite'
    | 'finalizeMaterialWrite'
    | 'getMaterial'
  >;
}

export interface SessionMaterialCleanupDependencies {
  byteStore?: MaterialByteStore;
  sessionStore?: Pick<AgentSessionStore, 'softDeleteSession'>;
  materialStore?: Pick<
    PgAgentSessionMaterialStore,
    'getDeletedSessionMaterialsForCleanup' | 'purgeDeletedSessionMaterials'
  > &
    Partial<
      Pick<
        PgAgentSessionMaterialStore,
        'getDeletedSessionMaterialWriteClaimsForCleanup' | 'purgeDeletedSessionMaterialWriteClaims'
      >
    >;
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
  await ensureAgentSessionMaterialSchema(pool);
  return new PgAgentSessionMaterialStore(pool, { withTransaction: nodePostgresTransaction(pool) });
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

function sessionMaterialKey(sessionId: string, materialId: string, name: string): string {
  return sessionMaterialObjectKey(sessionId, materialId, name);
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
  return (
    isSessionMaterialObjectKey(sessionId, key) || isLegacySessionMaterialObjectKey(sessionId, key)
  );
}

export interface SessionMaterialObjectWrite {
  sessionId: string;
  materialId: string;
  objectKey: string;
  claimId: string;
}

export interface SessionMaterialObjectWriteDependencies {
  byteStore?: MaterialByteStore;
  materialStore?: Pick<
    PgAgentSessionMaterialStore,
    | 'claimMaterialWrite'
    | 'discardMaterialWrite'
    | 'executeClaimedMaterialWrite'
    | 'finalizeMaterialWrite'
  >;
}

async function writeSessionMaterialObject(
  input: {
    sessionId: string;
    materialId: string;
    materialKind: AgentSessionMaterialKind;
    derivedFrom?: string;
    objectSlot: 'text' | 'raw';
    objectKey: string;
    bytes: Buffer;
    mime: string;
    existingMaterialTracksObject?: boolean;
    preserveClaimOnFailure?: boolean;
  },
  dependencies: SessionMaterialObjectWriteDependencies = {},
): Promise<SessionMaterialObjectWrite> {
  if (!isSessionMaterialKey(input.sessionId, input.objectKey)) {
    throw new Error('session material write requires its canonical session object key');
  }
  const store = dependencies.materialStore ?? (await getAgentSessionMaterialStore());
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  const claim = await store.claimMaterialWrite(input.sessionId, {
    materialId: input.materialId,
    materialKind: input.materialKind,
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
    objectSlot: input.objectSlot,
    objectKey: input.objectKey,
  });
  try {
    const published = await store.executeClaimedMaterialWrite(claim.id, async () => {
      try {
        await byteStore.put(input.objectKey, input.bytes, input.mime);
      } catch {
        throw new Error('session material byte write failed');
      }
    });
    if (!published) {
      await store.discardMaterialWrite(input.sessionId, claim.id);
      throw new Error('session material write rejected after session deletion');
    }
  } catch (error) {
    if (input.existingMaterialTracksObject) {
      await store.discardMaterialWrite(input.sessionId, claim.id).catch(() => undefined);
    } else if (input.preserveClaimOnFailure) {
      // Deterministic shared keys may belong to a concurrent successful writer.
      // Retain this claim instead of deleting a winner's object.
    } else {
      const removed = await byteStore
        .delete(input.objectKey)
        .then(() => true)
        .catch(() => false);
      if (removed) {
        await store.discardMaterialWrite(input.sessionId, claim.id).catch(() => undefined);
      }
    }
    throw error;
  }
  return {
    sessionId: input.sessionId,
    materialId: input.materialId,
    objectKey: input.objectKey,
    claimId: claim.id,
  };
}

export async function finalizeSessionMaterialObjectWrite(
  write: SessionMaterialObjectWrite,
  dependencies: SessionMaterialObjectWriteDependencies = {},
): Promise<boolean> {
  const store = dependencies.materialStore ?? (await getAgentSessionMaterialStore());
  const finalized = await store.finalizeMaterialWrite(write.sessionId, write.claimId);
  if (finalized) return true;
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  await byteStore.delete(write.objectKey);
  await store.discardMaterialWrite(write.sessionId, write.claimId);
  return false;
}

export async function discardSessionMaterialObjectWrite(
  write: SessionMaterialObjectWrite,
  dependencies: SessionMaterialObjectWriteDependencies = {},
): Promise<void> {
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  await byteStore.delete(write.objectKey);
  const store = dependencies.materialStore ?? (await getAgentSessionMaterialStore());
  await store.discardMaterialWrite(write.sessionId, write.claimId);
}

/** One owner upload maps to a stable, globally distinct snapshot id per session. */
export function boundSessionMaterialId(sessionId: string, ownerMaterialId: string): string {
  const digest = createHash('sha256')
    .update('openmaic:owner-material-session-snapshot:v1\0', 'utf8')
    .update(JSON.stringify([sessionId, ownerMaterialId]), 'utf8')
    .digest('hex');
  return `mat_${digest}`;
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
  const store = await getAgentSessionMaterialStore();
  const write = await writeSessionMaterialObject(
    {
      sessionId,
      materialId: id,
      materialKind: 'web',
      objectSlot: 'text',
      objectKey: textObjectKey,
      bytes: body,
      mime: 'text/markdown',
    },
    { byteStore, materialStore: store },
  );
  try {
    const created = await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId: textObjectKey,
      textChars: page.markdown.length,
    });
    if (!(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))) {
      throw new Error('session was deleted before the web material became visible');
    }
    return created;
  } catch (error) {
    // A database connection can fail after PostgreSQL committed the INSERT.
    // Verify absence before compensating; otherwise cleanup could delete the
    // object underneath a durable material row. If verification itself fails,
    // preserve the object and let orphan reconciliation handle it rather than
    // risk creating a dangling row.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) {
      if (!(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))) {
        throw new Error('session was deleted before the web material became visible', {
          cause: error,
        });
      }
      return committed;
    }
    if (committed === null) {
      await discardSessionMaterialObjectWrite(write, { byteStore, materialStore: store }).catch(
        () => undefined,
      );
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
  const write = await writeSessionMaterialObject(
    {
      sessionId,
      materialId: id,
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey: rawObjectKey,
      bytes: body,
      mime: input.mimeType,
    },
    { byteStore, materialStore: store },
  );
  try {
    const created = await store.createMaterial(sessionId, {
      id,
      kind: 'source',
      title: input.filename,
      rawAssetId: rawObjectKey,
      textChars: 0,
    });
    if (!(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))) {
      throw new Error('session was deleted before the source material became visible');
    }
    return created;
  } catch (error) {
    // Same ambiguous-commit discipline as createWebMaterial: only remove the
    // asset when the row is confirmed absent.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) {
      if (!(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))) {
        throw new Error('session was deleted before the source material became visible', {
          cause: error,
        });
      }
      return committed;
    }
    if (committed === null) {
      await discardSessionMaterialObjectWrite(write, { byteStore, materialStore: store }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * Bind owner-library uploads to a session by copying their private bytes into
 * the session byte prefix and creating the material rows the agent reads.
 * Rebinding the same id is idempotent.
 */
export async function bindOwnerMaterialsToSession(
  sessionId: string,
  ownerId: string,
  materialIds: readonly string[],
  dependencies: SessionMaterialBindingDependencies = {},
): Promise<Array<{ materialId: string; originalName?: string; mime?: string; bytes: number }>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && (!dependencies.queryable || !dependencies.materialStore)) {
    throw new Error('Agent runtime requires DATABASE_URL');
  }
  const sessionStore = dependencies.sessionStore ?? (await getAgentSessionStore());
  const targetSession = await sessionStore.getSession(sessionId);
  if (!targetSession || targetSession.ownerId !== ownerId) {
    throw new SessionMaterialBindingError('target session is unavailable');
  }
  const queryable =
    dependencies.queryable ?? (await getServerPersistenceProvider(connectionString!)).pool;
  const records = await getReadyOwnerMaterials(queryable, ownerId, materialIds);
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  const byId = new Map(records.map((record) => [record.id, record]));
  if (materialIds.some((id) => !byId.has(id))) {
    throw new SessionMaterialBindingError('one or more materials are unavailable');
  }
  const verified = new Map<string, VerifiedOwnerMaterialAsset>();
  for (const id of materialIds) {
    const asset = await verifyOwnerMaterialBytes(byId.get(id)!, byteStore);
    if (!asset) throw new SessionMaterialBindingError(`material ${id} bytes are unavailable`);
    verified.set(id, asset);
  }
  const store = dependencies.materialStore ?? (await getAgentSessionMaterialStore());
  const bound: Array<{
    materialId: string;
    originalName?: string;
    mime?: string;
    bytes: number;
  }> = [];
  try {
    for (const ownerMaterialId of materialIds) {
      const asset = verified.get(ownerMaterialId)!;
      const record = asset.record;
      const materialId = boundSessionMaterialId(sessionId, ownerMaterialId);
      const mime = record.mime ?? 'application/octet-stream';
      const rawObjectKey = sessionMaterialKey(sessionId, materialId, rawObjectName(mime));
      const existing = await store.getMaterial(sessionId, materialId);
      if (existing) {
        if (
          existing.kind !== 'source' ||
          existing.rawAssetId !== rawObjectKey ||
          existing.derivedFrom !== null
        ) {
          throw new SessionMaterialBindingError('session material snapshot identity conflict');
        }
        const snapshotBytes = await byteStore.get(rawObjectKey).catch(() => null);
        if (!snapshotBytes?.equals(asset.bytes)) {
          const write = await writeSessionMaterialObject(
            {
              sessionId,
              materialId,
              materialKind: 'source',
              objectSlot: 'raw',
              objectKey: rawObjectKey,
              bytes: asset.bytes,
              mime,
              existingMaterialTracksObject: true,
            },
            { byteStore, materialStore: store },
          );
          if (
            !(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))
          ) {
            throw new SessionMaterialBindingError(
              'target session was deleted during snapshot repair',
            );
          }
        }
      } else {
        const write = await writeSessionMaterialObject(
          {
            sessionId,
            materialId,
            materialKind: 'source',
            objectSlot: 'raw',
            objectKey: rawObjectKey,
            bytes: asset.bytes,
            mime,
            preserveClaimOnFailure: true,
          },
          { byteStore, materialStore: store },
        );
        try {
          await store.createMaterial(sessionId, {
            id: materialId,
            kind: 'source',
            title: record.originalName ?? ownerMaterialId,
            rawAssetId: rawObjectKey,
            textChars: 0,
          });
        } catch (error) {
          const committed = await store.getMaterial(sessionId, materialId).catch(() => undefined);
          if (committed) {
            if (committed.kind !== 'source' || committed.rawAssetId !== rawObjectKey) throw error;
          } else if (committed === null) {
            throw error;
          } else {
            throw error;
          }
        }
        if (
          !(await finalizeSessionMaterialObjectWrite(write, { byteStore, materialStore: store }))
        ) {
          throw new SessionMaterialBindingError('target session was deleted during snapshot bind');
        }
      }
      bound.push({
        materialId,
        ...(record.originalName ? { originalName: record.originalName } : {}),
        ...(record.mime ? { mime: record.mime } : {}),
        bytes: record.bytes,
      });
    }
    return bound;
  } catch (error) {
    // Previously committed items are valid independent snapshots and remain as
    // retryable partial progress. Rolling them back can invalidate a concurrent
    // bind that already returned the same deterministic snapshot id.
    if (error instanceof SessionMaterialBindingError) throw error;
    throw new SessionMaterialBindingError('material snapshot binding failed', { cause: error });
  }
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
    extraction: publicMaterialExtractionView(record.extraction),
    createdAt: record.createdAt,
  };
}

/** Closed public projection; historical raw errors and provider diagnostics never cross the wire. */
export function publicMaterialExtractionView(
  extraction: MaterialExtractionState,
): Record<string, unknown> {
  const stats = extraction.stats;
  const publicStats = stats
    ? {
        chars: stats.chars,
        pages: stats.pages,
        imageCount: stats.imageCount,
        ...(stats.truncated === undefined ? {} : { truncated: stats.truncated }),
        ...(stats.durationSec === undefined ? {} : { durationSec: stats.durationSec }),
        ...(stats.asrChunks === undefined ? {} : { asrChunks: stats.asrChunks }),
      }
    : undefined;
  return {
    status: extraction.status,
    attempts: extraction.attempts,
    ...(extraction.error
      ? {
          errorCode: isMaterialExtractionErrorCode(extraction.error)
            ? extraction.error
            : 'MATERIAL_EXTRACTION_FAILED',
        }
      : {}),
    ...(publicStats ? { stats: publicStats } : {}),
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
  materialId: string,
  materialKind: AgentSessionMaterialKind,
  bytes: Buffer,
  mime: string,
  options: {
    derivedFrom?: string;
    objectSlot?: 'text' | 'raw';
    dependencies?: SessionMaterialObjectWriteDependencies;
  } = {},
): Promise<SessionMaterialObjectWrite> {
  const objectSlot = options.objectSlot ?? 'raw';
  const key = sessionMaterialKey(
    sessionId,
    materialId,
    objectSlot === 'text' ? 'text.md' : rawObjectName(mime),
  );
  return writeSessionMaterialObject(
    {
      sessionId,
      materialId,
      materialKind,
      ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
      objectSlot,
      objectKey: key,
      bytes,
      mime,
    },
    options.dependencies,
  );
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

/**
 * Retryable cleanup for one tombstoned, owner-matched session. Metadata remains
 * as an inaccessible pointer until every byte object is confirmed absent.
 */
export async function cleanupDeletedSessionMaterials(
  sessionId: string,
  ownerId: string,
  dependencies: SessionMaterialCleanupDependencies = {},
): Promise<boolean> {
  const store = dependencies.materialStore ?? (await getAgentSessionMaterialStore());
  const materials = await store.getDeletedSessionMaterialsForCleanup(sessionId, ownerId);
  if (materials === null) return false;
  const claims = store.getDeletedSessionMaterialWriteClaimsForCleanup
    ? await store.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, ownerId)
    : [];
  if (claims === null) return false;
  const objectKeys = [
    ...new Set(
      [
        ...materials.flatMap((material) => [material.textAssetId, material.rawAssetId]),
        ...claims.map((claim) => claim.objectKey),
      ].filter((key): key is string => Boolean(key)),
    ),
  ];
  if (objectKeys.some((key) => !isSessionMaterialKey(sessionId, key))) {
    throw new Error('session material cleanup encountered a foreign object key');
  }
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  for (const key of objectKeys) await byteStore.delete(key);
  if (byteStore.deletePrefix) {
    await byteStore.deletePrefix(sessionMaterialObjectPrefix(sessionId));
    const legacyPrefix = legacySessionMaterialObjectPrefix(sessionId);
    if (legacyPrefix) await byteStore.deletePrefix(legacyPrefix);
  }
  await store.purgeDeletedSessionMaterials(sessionId, ownerId);
  if (store.purgeDeletedSessionMaterialWriteClaims) {
    await store.purgeDeletedSessionMaterialWriteClaims(sessionId, ownerId);
  }
  return true;
}

/** Tombstone the owned session, then clean its independent material snapshot. */
export async function deleteOwnedSessionWithMaterials(
  sessionId: string,
  ownerId: string,
  dependencies: SessionMaterialCleanupDependencies = {},
): Promise<boolean> {
  const sessionStore = dependencies.sessionStore ?? (await getAgentSessionStore());
  await sessionStore.softDeleteSession(sessionId, ownerId);
  return cleanupDeletedSessionMaterials(sessionId, ownerId, dependencies);
}

/**
 * Safe metadata and typed-tool guidance for materials bound to one session.
 * Material contents stay in the byte store and are available only through
 * the session-scoped material tools, never through this block.
 */
export function sessionMaterialsPromptBlock(materials: AgentSessionMaterial[]): string {
  if (materials.length === 0) return '';

  return [
    '## Registered session materials',
    '',
    'These materials are associated with this session:',
    ...materials.map(
      (material) =>
        `- "${material.title ?? material.id}" (${material.kind}, ${material.textChars} characters)`,
    ),
    '',
    'Material workflow: call `list_materials` to inspect the session materials and discover `mat_` ids; call `extract_material` on an uploaded source, then `wait_for_materials`; call `read_material` on the resulting extraction `mat_` id to read its text in pages (continue with the returned `nextOffset`); call `search_material` to locate case-insensitive literal text across the readable materials.',
    'To reuse session image, video, or audio bytes in a page, call `use_material_media` and use the returned stable `src`.',
    'A `web` material was already fetched and extracted; read it directly with `read_material` and page through offsets.',
    ...(materials.some((material) => isPptxMaterial({ originalName: material.title }))
      ? [
          'A registered .pptx can be imported INTO a stage as appended pages with `import_pptx` (layout-preserving: original slides become pages; the stage keeps its own title). Use that instead of an AI rewrite when the user wants the PowerPoint\u2019s own pages.',
        ]
      : []),
  ].join('\n');
}
