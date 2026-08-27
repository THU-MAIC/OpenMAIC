/**
 * Session-scoped web materials — host adapter.
 *
 * The durable row is stored in the package's `agent_session_materials` table
 * (create/list/read paging over `PgAgentSessionMaterialStore`, lazy-bound like
 * `store.ts` / `user-skill-store.ts`). The bytes are not kept on the row: the
 * extracted markdown is stored through the host's hash-addressed asset
 * registry/byte store and the row records the returned asset id — the neutral
 * counterpart of the reference's `ossKey` linkage. `fetch_url` is this
 * adapter's first consumer; `read_material` / `search_material` resolve a
 * row's recorded asset id back to bytes through the same registry. Later
 * slices can persist uploads and derived records through the same store.
 */
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  createMaterialId,
  toAssetId,
  type AgentSessionMaterial,
  type AgentSessionMeta,
  type AssetPrincipal,
  type ListAgentSessionMaterialsOptions,
} from '@openmaic/storage';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { getAgentSessionStore } from './store';
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

/** Each session's material bytes form their own asset-registry partition. */
export function materialPrincipal(sessionId: string): AssetPrincipal {
  return { key: `session-materials:${sessionId}` };
}

/**
 * Persist a fetched web page as a session material: the extracted markdown
 * goes into the asset registry, the material row records the returned asset
 * id plus the fetch's provenance (title / source URL / text character count).
 * A confirmed material-row failure removes the just-stored asset. Ambiguous
 * database outcomes are verified before cleanup so a committed row never has
 * its asset removed underneath it.
 */
export async function createWebMaterial(
  sessionId: string,
  page: ExtractedWebPage,
): Promise<AgentSessionMaterial> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const id = createMaterialId();
  const body = Buffer.from(page.markdown, 'utf8');
  const principal = materialPrincipal(sessionId);
  // Initialize the row store before writing bytes, narrowing the non-atomic
  // asset/metadata handoff to the two business writes themselves.
  const store = await getAgentSessionMaterialStore();
  const textAssetId = await provider.assetStore.put(
    principal,
    new Blob([body], { type: 'text/markdown' }),
    { contentType: 'text/markdown' },
  );
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'web',
      title: page.title.slice(0, 180) || undefined,
      sourceUrl: page.sourceUrl,
      textAssetId,
      textChars: page.markdown.length,
    });
  } catch (error) {
    // A database connection can fail after PostgreSQL committed the INSERT.
    // Verify absence before compensating; otherwise cleanup could delete the
    // asset underneath a durable material row. If verification itself fails,
    // preserve the asset and let orphan reconciliation handle it rather than
    // risk creating a dangling row.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await provider.assetStore.remove(principal, textAssetId).catch(() => undefined);
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
 * the asset registry under the session's own partition and the material row
 * records the returned asset id (`rawAssetId`), mirroring
 * {@link createWebMaterial}'s asset/metadata handoff. The kind is `source`,
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
  const provider = await getServerPersistenceProvider(connectionString);
  const id = createMaterialId();
  const body = Buffer.from(input.bytes);
  const principal = materialPrincipal(sessionId);
  const store = await getAgentSessionMaterialStore();
  const assetId = await provider.assetStore.put(
    principal,
    new Blob([body], { type: input.mimeType }),
    { contentType: input.mimeType },
  );
  try {
    return await store.createMaterial(sessionId, {
      id,
      kind: 'source',
      title: input.filename,
      rawAssetId: assetId,
      textChars: 0,
    });
  } catch (error) {
    // Same ambiguous-commit discipline as createWebMaterial: only remove the
    // asset when the row is confirmed absent.
    const committed = await store.getMaterial(sessionId, id).catch(() => undefined);
    if (committed) return committed;
    if (committed === null) {
      await provider.assetStore.remove(principal, assetId).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Bind owner-library uploads to a session by copying their private bytes into
 * the session asset partition and creating the material rows the agent reads.
 * Rebinding the same id is idempotent.
 */
export async function bindOwnerMaterialsToSession(
  sessionId: string,
  ownerId: string,
  materialIds: readonly string[],
): Promise<Array<{ materialId: string; originalName?: string; mime?: string; bytes: number }>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const records = await getReadyOwnerMaterials(provider.pool, ownerId, materialIds);
  const byId = new Map(records.map((record) => [record.id, record]));
  if (materialIds.some((id) => !byId.has(id))) {
    throw new SessionMaterialBindingError('one or more materials are unavailable');
  }
  const store = await getAgentSessionMaterialStore();
  const bound = [];
  for (const id of materialIds) {
    const record = byId.get(id)!;
    if (!(await store.getMaterial(sessionId, id))) {
      const source = await provider.assetStore.resolve(
        { key: `owner-materials:${ownerId}` },
        toAssetId(record.assetId),
      );
      if (!source) throw new SessionMaterialBindingError(`material ${id} bytes are unavailable`);
      const rawAssetId = await provider.assetStore.put(
        materialPrincipal(sessionId),
        new Blob([new Uint8Array(source.bytes)], { type: record.mime ?? source.mime }),
        { contentType: record.mime ?? source.mime },
      );
      try {
        await store.createMaterial(sessionId, {
          id,
          kind: 'source',
          title: record.originalName ?? id,
          rawAssetId,
          textChars: 0,
        });
      } catch (error) {
        if (!(await store.getMaterial(sessionId, id))) {
          await provider.assetStore
            .remove(materialPrincipal(sessionId), rawAssetId)
            .catch(() => undefined);
          throw error;
        }
      }
    }
    bound.push({
      materialId: id,
      ...(record.originalName ? { originalName: record.originalName } : {}),
      ...(record.mime ? { mime: record.mime } : {}),
      bytes: record.bytes,
    });
  }
  return bound;
}

/**
 * The HTTP-visible projection of one material row — the same shape the
 * `list_materials` agent tool exposes. Asset ids stay off the wire: the
 * registry handles are internal to the host seam, and nothing downstream of
 * the store should depend on them.
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
 * Resolve a material's recorded text asset to its bytes, or `null` when the
 * asset is absent. The lookup is scoped to the session's own asset-registry
 * partition, so a foreign or stale `textAssetId` — even one read off another
 * session's row — resolves as a miss, never as another session's content.
 */
export async function resolveSessionMaterialText(
  sessionId: string,
  textAssetId: string,
): Promise<Buffer | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const resolved = await provider.assetStore.resolve(
    materialPrincipal(sessionId),
    toAssetId(textAssetId),
  );
  if (!resolved) return null;
  return Buffer.from(resolved.bytes);
}

/**
 * Persist raw bytes (e.g. an uploaded audio/video source or a derived clip)
 * into the session's material asset partition and return the allocated asset
 * id, for the material row's `rawAssetId` slot.
 */
export async function storeSessionMaterialRawAsset(
  sessionId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  // Copy into a fresh ArrayBuffer-backed view: BlobPart requires an
  // ArrayBuffer-backed typed array, and a caller-supplied Buffer may be backed
  // by a pool or SharedArrayBuffer.
  return provider.assetStore.put(
    materialPrincipal(sessionId),
    new Blob([new Uint8Array(bytes)], { type: mime }),
    { contentType: mime },
  );
}

/**
 * Resolve a material row's raw bytes (audio/video source or derived clip) to
 * their bytes plus recorded media type, or `null` when the asset is absent.
 * Scoped to the session's own partition like `resolveSessionMaterialText`.
 */
export async function resolveSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  const resolved = await provider.assetStore.resolve(
    materialPrincipal(sessionId),
    toAssetId(rawAssetId),
  );
  if (!resolved) return null;
  return { bytes: Buffer.from(resolved.bytes), mime: resolved.mime };
}

/**
 * Remove a raw asset from the session's material partition (compensation for a
 * failed material-row write). A no-op for foreign/absent ids.
 */
export async function removeSessionMaterialRawAsset(
  sessionId: string,
  rawAssetId: string,
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  await provider.assetStore.remove(materialPrincipal(sessionId), toAssetId(rawAssetId));
}

/**
 * Safe metadata and typed-tool guidance for materials bound to one session.
 * Material contents stay in the asset registry and are available only through
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
