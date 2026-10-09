/**
 * Owner-level extraction (`lib/persistence/owner-material-extraction.ts`,
 * `lib/server/material-extraction/owner-extraction.ts`): the scenarios,
 * shared by the PGlite suite and the PostgreSQL one so both engines run the
 * same assertions. The PostgreSQL suite adds the cases that need connections
 * running in parallel.
 *
 * Each scenario boots the persistence provider on an empty database, seeds
 * owner materials directly, and drives the service with counting fake
 * extractors. Leases are decided by an injected clock, not by waiting.
 */
import { OwnerMaterialBytesUnavailableError } from '@/lib/server/materials/owner-material-bytes';
import { MaterialExtractionError } from '@/lib/server/material-extraction/errors';
import { createHash, randomUUID } from 'node:crypto';

import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { AssetCollector } from '@openmaic/storage/asset/collector';
import { AssetRootTargetError, changeAssetRoots } from '@openmaic/storage/asset/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import { expect, vi } from 'vitest';
import * as imageParser from '@/lib/server/material-extraction/document-image-parser';

import type { DocumentExtractorProvider, MediaExtractorProvider } from '@/lib/document';
import { resolveConfiguredAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { assetReferencePrincipalsForOwner } from '@/lib/persistence/owner-assets';
import { claimOwner, resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import {
  checkOwnerExtractionClaim,
  claimNextOwnerMaterialExtraction,
  ensureOwnerMaterialExtraction,
  heartbeatOwnerMaterialExtraction,
  MAX_OWNER_EXTRACTION_CLAIMS,
  OwnerExtractionClaimLostError,
  publishOwnerMaterialExtraction,
  settleOwnerMaterialExtractionFailure,
  type OwnerExtractionClaim,
  type OwnerExtractionResult,
} from '@/lib/persistence/owner-material-extraction';
import {
  allocateOwnerMaterialBytes,
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  publicMaterial,
  publishOwnerMaterialUpload,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import { STAGE_META_OWNERSHIP } from '@/lib/persistence/stage-meta-ownership';
import {
  OWNER_EXTRACTION_LEASE_TTL_MS,
  runClaimedOwnerExtraction,
  runNextOwnerExtraction,
  type OwnerExtractionDependencies,
} from '@/lib/server/material-extraction/owner-extraction';

export interface ExtractionScenarioPool {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
  end(): Promise<void>;
}

export interface ExtractionHarness {
  pool: ExtractionScenarioPool;
  provider: ServerPersistenceProvider;
  clock: { now: number };
  /** Bytes each source's object key resolves to. */
  sources: Map<string, Buffer>;
  documentExtract: ReturnType<typeof vi.fn>;
  mediaExtract: ReturnType<typeof vi.fn>;
  /** Result-affecting settings per extractor id; mutable per scenario. */
  options: Map<string, Record<string, string>>;
  deps(overrides?: Partial<OwnerExtractionDependencies>): OwnerExtractionDependencies;
}

export const ANON = 'anon:2d7b5f6e-0e3f-4a4b-9c5d-3e4f5a6b7c8d';
export const ACCOUNT = 'user:alice';
export const OTHER = 'user:carol';
const START = 1_800_000_000_000;
const TTL = OWNER_EXTRACTION_LEASE_TTL_MS;
/** One PNG-ish payload the fake media extractor returns as a keyframe. */
export const KEYFRAME = Buffer.alloc(2_000, 7);

function documentProvider(extract: ReturnType<typeof vi.fn>): DocumentExtractorProvider {
  return {
    id: 'test-doc' as never,
    displayName: 'Test document',
    version: '1',
    supportedMimeTypes: ['application/pdf'],
    capabilities: {
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    },
    extract: extract as never,
  };
}

function mediaProvider(extract: ReturnType<typeof vi.fn>): MediaExtractorProvider {
  return {
    id: 'test-media' as never,
    displayName: 'Test media',
    version: '1',
    supportedMimeTypes: ['video/mp4', 'video/webm', 'audio/webm'],
    capabilities: { transcript: true, keyframes: true, synopsis: false, ocr: false, async: false },
    availability: async () => ({ available: true }),
    extract: extract as never,
  };
}

export async function bootExtractionHarness(
  pool: ExtractionScenarioPool,
  databaseUrl: string,
): Promise<ExtractionHarness> {
  resetClaimParticipantsForTests();
  const provider = await getServerPersistenceProvider(databaseUrl, () => pool as never);
  // Every core claim participant's tables, so a scenario can claim an owner.
  await ensureAgentSessionSchema(pool as never);
  await ensureUserSkillSchema(pool as never);
  const clock = { now: START };
  const sources = new Map<string, Buffer>();
  const options = new Map<string, Record<string, string>>();
  const documentExtract = vi.fn(async () => ({
    metadata: { pageCount: 2 },
    blocks: [{ id: 'b1', type: 'markdown', text: '# Lesson\n\n![](images/fig-1.jpg)\n\nBody' }],
    assets: [{ id: 'img_1', type: 'image', data: 'aW1n' }],
  }));
  const mediaExtract = vi.fn(async () => ({
    metadata: { durationMs: 4_000 },
    transcript: [{ id: 's1', startMs: 0, endMs: 4_000, text: 'Hello class' }],
    assets: [
      {
        id: 'keyframe-001',
        type: 'image',
        mimeType: 'image/png',
        data: `data:image/png;base64,${KEYFRAME.toString('base64')}`,
        description: 'lecture at 1.500 seconds',
        metadata: { timeMs: 1_500 },
      },
    ],
  }));
  const harness: ExtractionHarness = {
    pool,
    provider,
    clock,
    sources,
    documentExtract,
    mediaExtract,
    options,
    deps: (overrides = {}) => ({
      persistence: provider,
      providers: () => [documentProvider(documentExtract)],
      mediaProviders: () => [mediaProvider(mediaExtract)],
      configuredProviderIds: () => [],
      readSource: async (claim) => {
        const bytes = sources.get(claim.materialId);
        if (!bytes) throw new Error(`no test bytes for ${claim.materialId}`);
        return bytes;
      },
      resultOptions: (id) => options.get(id) ?? {},
      now: () => clock.now,
      ...overrides,
    }),
  };
  return harness;
}

interface SeedOptions {
  owner?: string;
  mime?: string;
  bytes?: Buffer;
  /** `null` stores no digest: the source has no reliable content identity. */
  sha256?: string | null;
  folderId?: string;
}

/** A ready source material, registered and finalized the way an upload is. */
export async function seedSource(
  h: ExtractionHarness,
  id: string,
  seed: SeedOptions = {},
): Promise<void> {
  const owner = seed.owner ?? ACCOUNT;
  const bytes = seed.bytes ?? Buffer.from(`%PDF-${id}`);
  await registerOwnerMaterial(
    h.pool as unknown as ConnectableQueryable,
    {
      id,
      ownerId: owner,
      kind: 'source',
      mime: seed.mime ?? 'application/pdf',
      bytes: bytes.byteLength,
      originalName: `${id}.pdf`,
      ossKey: `objects/${id}`,
      extraction: { status: 'idle' },
    },
    { maxCount: 100, maxTotalBytes: 1_000_000_000 },
  );
  const digest =
    seed.sha256 === undefined ? createHash('sha256').update(bytes).digest('hex') : seed.sha256;
  await finalizeOwnerMaterial(h.pool as never, id, bytes.byteLength, digest ?? 'pending');
  if (seed.sha256 === null) {
    await h.pool.query('UPDATE owner_material SET sha256 = NULL WHERE id = $1', [id]);
  }
  if (seed.folderId) {
    await h.pool.query(
      `INSERT INTO material_folders (owner_id, id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $2, lower($2), 0, 0) ON CONFLICT DO NOTHING`,
      [owner, seed.folderId],
    );
    await h.pool.query('UPDATE owner_material SET folder_id = $2 WHERE id = $1', [
      id,
      seed.folderId,
    ]);
  }
  h.sources.set(id, bytes);
}

interface StateRow {
  reason_code: string | null;
  owner_id: string;
  status: string | null;
  extraction_token: string | null;
  extraction_claims: number;
  extraction_error: string | null;
  extraction_result: OwnerExtractionResult | null;
  extraction_cache_key: string | null;
  folder_id: string | null;
}

export async function stateOf(h: ExtractionHarness, id: string): Promise<StateRow> {
  const result = await h.pool.query<StateRow>(
    `SELECT owner_id, (extraction->>'status') AS status, (extraction->>'reasonCode') AS reason_code, extraction_token,
            extraction_claims::int AS extraction_claims, extraction_error, extraction_result,
            extraction_cache_key, folder_id
       FROM owner_material WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

export async function rootsOf(h: ExtractionHarness, rootId: string): Promise<string[]> {
  const result = await h.pool.query<{ asset_id: string }>(
    `SELECT asset_id FROM asset_root_refs WHERE root_kind = 'material' AND root_id = $1
      ORDER BY asset_id`,
    [rootId],
  );
  return result.rows.map((row) => row.asset_id);
}

async function entryCount(h: ExtractionHarness): Promise<number> {
  const result = await h.pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM asset_entries',
  );
  return Number(result.rows[0]!.count);
}

async function rootCount(h: ExtractionHarness): Promise<number> {
  const result = await h.pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM asset_root_refs',
  );
  return Number(result.rows[0]!.count);
}

export async function ensure(h: ExtractionHarness, id: string, owner = ACCOUNT) {
  return ensureOwnerMaterialExtraction(h.provider.withTransaction, owner, id);
}

export function claim(h: ExtractionHarness): Promise<OwnerExtractionClaim | null> {
  return claimNextOwnerMaterialExtraction(h.pool as never, {
    leaseTtlMs: TTL,
    now: h.clock.now,
    createToken: randomUUID,
  });
}

/** Run the worker until the queue is empty. */
export async function drain(h: ExtractionHarness, deps = h.deps()): Promise<number> {
  let runs = 0;
  while (await runNextOwnerExtraction(deps, { heartbeatIntervalMs: 60_000 })) runs += 1;
  return runs;
}

export function expire(h: ExtractionHarness): void {
  h.clock.now += TTL + 1;
}

// ---------------------------------------------------------------------------

/** ensure-started: idle/failed queue once; pending, running and done stay; others refuse. */
export async function ensureStartedScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-a');
  await registerOwnerMaterial(
    h.pool as unknown as ConnectableQueryable,
    { id: 'src-uploading', ownerId: ACCOUNT, kind: 'source', bytes: 1, ossKey: 'objects/u' },
    { maxCount: 100, maxTotalBytes: 1_000_000 },
  );
  await seedSource(h, 'src-deleted');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-deleted']);

  expect(await ensure(h, 'src-a')).toEqual({ status: 'pending', queued: true });
  expect(await ensure(h, 'src-a')).toEqual({ status: 'pending', queued: false });
  expect(await ensure(h, 'src-uploading')).toBeNull();
  expect(await ensure(h, 'src-deleted')).toBeNull();
  // Another owner's source is not found, not started.
  expect(await ensure(h, 'src-a', OTHER)).toBeNull();

  expect(await drain(h)).toBe(1);
  const done = await stateOf(h, 'src-a');
  expect(done.status).toBe('done');
  expect(await ensure(h, 'src-a')).toEqual({ status: 'done', queued: false });
  expect(await drain(h)).toBe(0);
  expect((await stateOf(h, 'src-a')).extraction_result).toEqual(done.extraction_result);
}

/**
 * An upload queues its extraction in the transaction that publishes it: the
 * published row is pending with a fresh claim budget, a refused publication
 * queues nothing, Parse finds it already started, the scanner takes it to
 * done, and a second upload of the same bytes reuses that result.
 */
export async function uploadQueuesExtractionScenario(h: ExtractionHarness): Promise<void> {
  const bytes = Buffer.from('%PDF-uploaded lesson');
  const upload = async (id: string, owner = ACCOUNT) => {
    await registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      {
        id,
        ownerId: ACCOUNT,
        kind: 'source',
        mime: 'application/pdf',
        bytes: bytes.byteLength,
        originalName: `${id}.pdf`,
        ossKey: '',
        extraction: { status: 'idle' },
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    const assetId = await allocateOwnerMaterialBytes(h.provider, ACCOUNT, bytes, 'application/pdf');
    h.sources.set(id, bytes);
    return publishOwnerMaterialUpload(h.provider, owner, id, {
      assetId,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  const leaseOf = async (id: string) =>
    (
      await h.pool.query<{ status: string; lease: unknown }>(
        'SELECT status, extraction_lease_at AS lease FROM owner_material WHERE id = $1',
        [id],
      )
    ).rows[0];

  const published = await upload('src-up');
  if (published === 'refused') throw new Error('the upload was refused');
  expect(published.extraction).toEqual({ status: 'pending' });
  expect(publicMaterial(published).extraction).toEqual({ status: 'pending' });
  expect(await stateOf(h, 'src-up')).toMatchObject({
    status: 'pending',
    extraction_claims: 0,
    extraction_token: null,
    extraction_error: null,
  });
  expect(await leaseOf('src-up')).toEqual({ status: 'ready', lease: null });

  // A publication refused (here: another owner) writes nothing, the queue included.
  expect(await upload('src-refused', OTHER)).toBe('refused');
  expect((await stateOf(h, 'src-refused')).status).toBe('idle');
  expect((await leaseOf('src-refused'))!.status).toBe('uploading');

  // Parse of a just-uploaded source finds it started and changes nothing.
  const queued = await stateOf(h, 'src-up');
  expect(await ensure(h, 'src-up')).toEqual({ status: 'pending', queued: false });
  expect(await stateOf(h, 'src-up')).toEqual(queued);

  expect(await drain(h)).toBe(1);
  expect((await stateOf(h, 'src-up')).status).toBe('done');
  expect(h.documentExtract).toHaveBeenCalledTimes(1);

  // The same bytes uploaded again: queued too, and served from the owner's cache.
  await upload('src-up-again');
  expect(await drain(h)).toBe(1);
  const again = await stateOf(h, 'src-up-again');
  expect(again.status).toBe('done');
  expect(again.extraction_result).toMatchObject({ reusedFrom: 'src-up' });
  expect(h.documentExtract).toHaveBeenCalledTimes(1);
}

/**
 * Two conversations starting the same source, at once and again after it is
 * done: one extraction, one result (T13). A failed source restarts under a
 * fresh token.
 */
export async function twoConversationsOneExtractionScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-shared');
  const [first, second] = await Promise.all([ensure(h, 'src-shared'), ensure(h, 'src-shared')]);
  expect([first?.queued, second?.queued].filter(Boolean)).toHaveLength(1);
  expect(await drain(h)).toBe(1);
  await ensure(h, 'src-shared');
  expect(await drain(h)).toBe(0);
  expect(h.documentExtract).toHaveBeenCalledTimes(1);

  const state = await stateOf(h, 'src-shared');
  expect(state).toMatchObject({ status: 'done', extraction_token: null });
  const result = state.extraction_result!;
  expect(result.revision).toEqual(expect.any(String));
  expect(result.extractor).toEqual({ id: 'test-doc', version: '1', options: {} });
  // The fake provider's image is not a readable image, so it is not kept,
  // and the text's reference to it becomes its alt text rather than a file
  // nothing holds. (Kept images: documentImagesScenario.)
  expect(result.derivatives).toEqual([]);
  expect(await rootsOf(h, 'src-shared')).toEqual([result.text.assetId]);
  const text = await h.provider.assetStore.resolve(
    { key: `owner:${ACCOUNT}` },
    result.text.assetId as never,
  );
  const stored = Buffer.from(text!.bytes).toString();
  expect(stored).toContain(String.raw`\[image\]`);
  expect(stored).not.toContain('images/fig-1.jpg');

  // A failed source restarts, with a token no earlier claim held.
  await seedSource(h, 'src-retry');
  await ensure(h, 'src-retry');
  const failed = await claim(h);
  await settleOwnerMaterialExtractionFailure(h.pool as never, failed!, {
    reason: 'unreadable',
    retryable: false,
  });
  expect((await stateOf(h, 'src-retry')).status).toBe('failed');
  expect(await ensure(h, 'src-retry')).toEqual({ status: 'pending', queued: true });
  const again = await claim(h);
  expect(again!.token).not.toBe(failed!.token);
  expect(again!.claims).toBe(1);
}

/** Takeovers spend the budget and end in a stated failure; a heartbeat keeps the lease. */
export async function claimBudgetScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-stuck');
  await ensure(h, 'src-stuck');
  const tokens = new Set<string>();
  for (let index = 0; index < MAX_OWNER_EXTRACTION_CLAIMS; index += 1) {
    const next = await claim(h);
    expect(next).toMatchObject({ materialId: 'src-stuck', claims: index + 1 });
    tokens.add(next!.token);
    expire(h);
  }
  expect(tokens.size).toBe(MAX_OWNER_EXTRACTION_CLAIMS);
  expect(await claim(h)).toBeNull();
  expect(await stateOf(h, 'src-stuck')).toMatchObject({
    status: 'failed',
    extraction_token: null,
    extraction_error: 'extraction did not finish within its claim budget',
    reason_code: 'processing_interrupted',
  });

  await seedSource(h, 'src-alive');
  await ensure(h, 'src-alive');
  const alive = await claim(h);
  h.clock.now += TTL - 1;
  expect(await heartbeatOwnerMaterialExtraction(h.pool as never, alive!, h.clock.now)).toBe(true);
  h.clock.now += TTL - 1;
  expect(await claim(h)).toBeNull();
  expect((await stateOf(h, 'src-alive')).extraction_claims).toBe(1);
}

/**
 * A superseded claim writes nothing: A→B, and A's late completion, failure,
 * heartbeat and allocation; then a manual restart after which an even older
 * claim comes back. The current result, its revision and its roots survive.
 */
export async function supersededClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-race');
  await ensure(h, 'src-race');
  const a = (await claim(h))!;
  expire(h);
  const b = (await claim(h))!;
  // While B still runs, A's publication is refused by its token alone: the
  // source is running, undeleted and A's owner's.
  const early = await h.provider.withTransaction((tx) =>
    h.provider
      .assetStoreIn(tx)
      .put({ key: `owner:${ACCOUNT}` }, new Blob(['early']), { contentType: 'text/markdown' }),
  );
  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      a,
      {
        cacheKey: null,
        text: { assetId: early, chars: 5 },
        extractor: { id: 'late', version: '1', options: {} },
        stats: {},
        derivatives: [],
      },
      h.clock.now,
    ),
  ).toBe('not-authorized');
  expect(await stateOf(h, 'src-race')).toMatchObject({
    status: 'running',
    extraction_token: b.token,
  });
  expect(await rootsOf(h, 'src-race')).toEqual([]);
  expect(await runClaimedOwnerExtraction(b, h.deps())).toBe('published');
  const won = await stateOf(h, 'src-race');
  const roots = await rootsOf(h, 'src-race');
  const entries = await entryCount(h);

  expect(await heartbeatOwnerMaterialExtraction(h.pool as never, a, h.clock.now)).toBe(false);
  expect(
    await settleOwnerMaterialExtractionFailure(h.pool as never, a, {
      reason: 'late',
      retryable: true,
    }),
  ).toBeNull();
  // A's run is refused at its first allocation: nothing is stored for it.
  await expect(runClaimedOwnerExtraction(a, h.deps())).rejects.toBeInstanceOf(
    OwnerExtractionClaimLostError,
  );
  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      a,
      {
        cacheKey: null,
        text: won.extraction_result!.text,
        extractor: { id: 'late', version: '1', options: {} },
        stats: {},
        derivatives: [],
      },
      h.clock.now,
    ),
  ).toBe('not-authorized');
  expect(await stateOf(h, 'src-race')).toEqual(won);
  expect(await rootsOf(h, 'src-race')).toEqual(roots);
  expect(await entryCount(h)).toBe(entries);

  // W claims, loses the lease to X, X fails for good; the teacher restarts it
  // and Y claims. W's claim stays dead through all of it.
  await seedSource(h, 'src-restarted');
  await ensure(h, 'src-restarted');
  const w = (await claim(h))!;
  expire(h);
  const x = (await claim(h))!;
  await settleOwnerMaterialExtractionFailure(h.pool as never, x, {
    reason: 'unreadable',
    retryable: false,
  });
  await ensure(h, 'src-restarted');
  const y = (await claim(h))!;
  expect(new Set([w.token, x.token, y.token]).size).toBe(3);
  expect(await heartbeatOwnerMaterialExtraction(h.pool as never, w, h.clock.now)).toBe(false);
  expect(
    await settleOwnerMaterialExtractionFailure(h.pool as never, w, {
      reason: 'late',
      retryable: false,
    }),
  ).toBeNull();
  await expect(runClaimedOwnerExtraction(w, h.deps())).rejects.toBeInstanceOf(
    OwnerExtractionClaimLostError,
  );
  expect((await stateOf(h, 'src-restarted')).extraction_token).toBe(y.token);
  expect(await runClaimedOwnerExtraction(y, h.deps())).toBe('published');
}

/** A deleted source is not claimed, and a claim of one cannot write. */
export async function deletedSourceScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-gone-pending');
  await ensure(h, 'src-gone-pending');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', [
    'src-gone-pending',
  ]);
  expect(await claim(h)).toBeNull();

  await seedSource(h, 'src-gone-running');
  await ensure(h, 'src-gone-running');
  const running = (await claim(h))!;
  // Allocated before the deletion, published after it: refused, no root.
  const allocated = await h.provider.withTransaction(async (tx) => {
    await checkOwnerExtractionClaim(tx, running, ACCOUNT);
    return h.provider
      .assetStoreIn(tx)
      .put({ key: `owner:${ACCOUNT}` }, new Blob(['text']), { contentType: 'text/markdown' });
  });
  const before = await entryCount(h);
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', [
    'src-gone-running',
  ]);
  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      running,
      {
        cacheKey: null,
        text: { assetId: allocated, chars: 4 },
        extractor: { id: 'test-doc', version: '1', options: {} },
        stats: {},
        derivatives: [],
      },
      h.clock.now,
    ),
  ).toBe('not-authorized');
  expect(await heartbeatOwnerMaterialExtraction(h.pool as never, running, h.clock.now)).toBe(false);
  await expect(runClaimedOwnerExtraction(running, h.deps())).rejects.toBeInstanceOf(
    OwnerExtractionClaimLostError,
  );
  expect(await entryCount(h)).toBe(before);
  expect(await rootsOf(h, 'src-gone-running')).toEqual([]);
  expect((await stateOf(h, 'src-gone-running')).extraction_result).toBeNull();
}

/**
 * A claim of the owner between allocating and publishing: the run publishes
 * once, for the account (D2: the work continues), its pending entry moved
 * with the claim. A superseded claim stays refused after the move.
 */
export async function ownerClaimMidRunScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-anon', { owner: ANON });
  await ensure(h, 'src-anon', ANON);
  const stale = (await claim(h))!;
  expire(h);
  const current = (await claim(h))!;
  let transactions = 0;
  const persistence = {
    ...h.provider,
    withTransaction: async <T>(body: (tx: never) => Promise<T>): Promise<T> => {
      const result = await h.provider.withTransaction(body as never);
      transactions += 1;
      // After the text allocation commits, before the publication.
      if (transactions === 1) await claimOwner(ANON, ACCOUNT, { provider: h.provider });
      return result as T;
    },
  };
  expect(
    await runClaimedOwnerExtraction(current, h.deps({ persistence: persistence as never })),
  ).toBe('published');
  const state = await stateOf(h, 'src-anon');
  expect(state).toMatchObject({ owner_id: ACCOUNT, status: 'done' });
  const textAssetId = state.extraction_result!.text.assetId;
  const entry = await h.pool.query<{ principal: string; committed: boolean }>(
    'SELECT principal, committed_at IS NOT NULL AS committed FROM asset_entries WHERE id = $1',
    [textAssetId],
  );
  expect(entry.rows[0]).toEqual({ principal: `owner:${ACCOUNT}`, committed: true });
  expect(await rootsOf(h, 'src-anon')).toEqual([textAssetId]);

  // The claim forwards the old owner, but the old token is still not current.
  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      stale,
      {
        cacheKey: null,
        text: state.extraction_result!.text,
        extractor: { id: 'late', version: '1', options: {} },
        stats: {},
        derivatives: [],
      },
      h.clock.now,
    ),
  ).toBe('not-authorized');
  expect((await stateOf(h, 'src-anon')).extraction_result).toEqual(state.extraction_result);
}

/** A publication that fails part-way leaves nothing: no roots, no rows, no result. */
export async function publishRollbackScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-rollback');
  await ensure(h, 'src-rollback');
  const current = (await claim(h))!;
  const allocated = await h.provider.withTransaction(async (tx) => {
    await checkOwnerExtractionClaim(tx, current, ACCOUNT);
    return h.provider
      .assetStoreIn(tx)
      .put({ key: `owner:${ACCOUNT}` }, new Blob(['text']), { contentType: 'text/markdown' });
  });
  const base = {
    cacheKey: 'k',
    text: { assetId: allocated, chars: 4 },
    extractor: { id: 'test-doc', version: '1', options: {} },
    stats: {},
  };

  // A named entry that does not exist refuses the root call, before any write.
  await expect(
    publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      current,
      { ...base, text: { assetId: 'missing-asset', chars: 4 }, derivatives: [] },
      h.clock.now,
    ),
  ).rejects.toBeInstanceOf(AssetRootTargetError);

  // A derivative row that cannot be inserted fails AFTER the root call wrote
  // its rows, committed the entries and raised the rule version: the id is
  // free as a root but already taken as a material. Everything must roll back.
  await seedSource(h, 'src-occupied');
  await h.pool.query('UPDATE asset_reference_tracking SET rule_version = 1');
  const failure = await publishOwnerMaterialExtraction(
    h.provider.withTransaction,
    current,
    {
      ...base,
      derivatives: [
        {
          id: 'src-occupied',
          kind: 'image',
          assetId: allocated,
          title: 'clash',
          mime: 'image/png',
          bytes: 4,
          sha256: 'x',
        },
      ],
    },
    h.clock.now,
  ).catch((error: unknown) => error);
  // A primary-key violation can only come from the derivative insert, which
  // runs after the root call.
  expect((failure as { code?: unknown }).code).toBe('23505');
  const ruleVersion = await h.pool.query<{ v: number }>(
    'SELECT rule_version AS v FROM asset_reference_tracking',
  );
  expect(Number(ruleVersion.rows[0]!.v)).toBe(1);
  expect((await stateOf(h, 'src-occupied')).status).toBe('idle');
  expect(await stateOf(h, 'src-rollback')).toMatchObject({
    status: 'running',
    extraction_token: current.token,
    extraction_result: null,
    extraction_cache_key: null,
  });
  expect(await rootCount(h)).toBe(0);
  const pending = await h.pool.query<{ committed: boolean }>(
    'SELECT committed_at IS NOT NULL AS committed FROM asset_entries WHERE id = $1',
    [allocated],
  );
  expect(pending.rows[0]).toEqual({ committed: false });

  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      current,
      { ...base, derivatives: [] },
      h.clock.now,
    ),
  ).toBe('published');
  expect(await rootsOf(h, 'src-rollback')).toEqual([allocated]);
  // The same raise, committed this time.
  const raised = await h.pool.query<{ v: number }>(
    'SELECT rule_version AS v FROM asset_reference_tracking',
  );
  expect(Number(raised.rows[0]!.v)).toBe(2);
}

/**
 * The owner's cache: same content, extractor and settings reuse one result
 * under the reusing source's own roots and derivative ids; another owner,
 * other settings, a source without a digest, a deleted donor and a donor
 * whose entry is gone all extract.
 */
export async function ownerCacheScenario(h: ExtractionHarness): Promise<void> {
  const video = Buffer.from('mp4-lecture');
  for (const id of ['vid-1', 'vid-2']) {
    await seedSource(h, id, { mime: 'video/mp4', bytes: video, folderId: `f-${id}` });
    await ensure(h, id);
  }
  expect(await drain(h)).toBe(2);
  expect(h.mediaExtract).toHaveBeenCalledTimes(1);
  const donor = (await stateOf(h, 'vid-1')).extraction_result!;
  const reused = await stateOf(h, 'vid-2');
  expect(reused.extraction_result).toMatchObject({
    reusedFrom: 'vid-1',
    text: donor.text,
    extractor: donor.extractor,
  });
  expect(reused.extraction_result!.revision).not.toBe(donor.revision);
  const [donorFrame] = donor.derivatives;
  const [reusedFrame] = reused.extraction_result!.derivatives;
  expect(reusedFrame.id).not.toBe(donorFrame.id);
  expect(reusedFrame.assetId).toBe(donorFrame.assetId);
  // Named after the source that reuses it, not the donor.
  expect(donorFrame.title).toBe('vid-1 at 1.500 seconds');
  expect(reusedFrame.title).toBe('vid-2 at 1.500 seconds');
  expect(await rootsOf(h, 'vid-2')).toEqual([donor.text.assetId]);
  expect(await rootsOf(h, reusedFrame.id)).toEqual([donorFrame.assetId]);
  const frameRow = await h.pool.query<{
    derived_from: string;
    folder_id: string;
    original_name: string;
  }>('SELECT derived_from, folder_id, original_name FROM owner_material WHERE id = $1', [
    reusedFrame.id,
  ]);
  expect(frameRow.rows[0]).toEqual({
    derived_from: 'vid-2',
    folder_id: 'f-vid-2',
    original_name: 'vid-2 at 1.500 seconds',
  });

  // Another owner with the same bytes never hits.
  await seedSource(h, 'vid-other', { owner: OTHER, mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-other', OTHER);
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(2);

  // A changed ASR model changes the key.
  h.options.set('test-media', { asrModel: 'whisper-large' });
  await seedSource(h, 'vid-3', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-3');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(3);
  const keyed = await stateOf(h, 'vid-3');
  expect(keyed.extraction_result!.extractor.options).toEqual({ asrModel: 'whisper-large' });
  expect(keyed.extraction_cache_key).not.toBe((await stateOf(h, 'vid-1')).extraction_cache_key);
  h.options.clear();

  // No digest, no key, no hit.
  await seedSource(h, 'vid-nodigest', { mime: 'video/mp4', bytes: video, sha256: null });
  await ensure(h, 'vid-nodigest');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(4);
  expect((await stateOf(h, 'vid-nodigest')).extraction_cache_key).toBeNull();

  // Deleted donors are not reused (vid-1 and vid-2 both hold the key) --
  // including one deleted after it was found, before the hit is published.
  await seedSource(h, 'vid-late-hit', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-late-hit');
  const lateHit = (await claim(h))!;
  await h.pool.query(`UPDATE owner_material SET deleted_at = 1 WHERE id IN ('vid-1', 'vid-2')`);
  expect(
    await publishOwnerMaterialExtraction(
      h.provider.withTransaction,
      lateHit,
      {
        cacheKey: donor.text.assetId,
        donor: {
          materialId: 'vid-1',
          revision: donor.revision,
          roots: [{ rootId: 'vid-1', assetId: donor.text.assetId }],
        },
        text: donor.text,
        extractor: donor.extractor,
        stats: donor.stats,
        derivatives: [],
      },
      h.clock.now,
    ),
  ).toBe('donor-changed');
  expect(await stateOf(h, 'vid-late-hit')).toMatchObject({
    status: 'running',
    extraction_result: null,
  });
  expect(await rootsOf(h, 'vid-late-hit')).toEqual([]);
  await settleOwnerMaterialExtractionFailure(h.pool as never, lateHit, {
    reason: 'test',
    retryable: false,
  });
  await seedSource(h, 'vid-4', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-4');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(5);
  expect((await stateOf(h, 'vid-4')).extraction_result!.reusedFrom).toBeUndefined();

  // A donor whose entry is gone (reclaimed) is a miss under lock, not a hit.
  const lost = (await stateOf(h, 'vid-4')).extraction_result!;
  await h.pool.query('DELETE FROM asset_root_refs WHERE asset_id = $1', [lost.text.assetId]);
  await h.pool.query('DELETE FROM asset_entries WHERE id = $1', [lost.text.assetId]);
  await seedSource(h, 'vid-5', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-5');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(6);
  const fresh = (await stateOf(h, 'vid-5')).extraction_result!;
  expect(fresh.reusedFrom).toBeUndefined();
  expect(await rootsOf(h, 'vid-5')).toEqual([fresh.text.assetId]);
}

/** Media derivatives: own ids, lineage, page/time, the source's folder, a root each. */
export async function mediaDerivativeScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'vid-filed', {
    mime: 'video/mp4',
    bytes: Buffer.from('mp4'),
    folderId: 'f-unit',
  });
  await ensure(h, 'vid-filed');
  await drain(h);
  const result = (await stateOf(h, 'vid-filed')).extraction_result!;
  expect(result.derivatives).toEqual([
    expect.objectContaining({
      kind: 'image',
      title: 'vid-filed at 1.500 seconds',
      mime: 'image/png',
      bytes: KEYFRAME.byteLength,
      timeMs: 1_500,
    }),
  ]);
  const [frame] = result.derivatives;
  const row = await h.pool.query<Record<string, unknown>>(
    `SELECT owner_id, kind, derived_from, folder_id, asset_id, status, oss_key
       FROM owner_material WHERE id = $1`,
    [frame.id],
  );
  expect(row.rows[0]).toEqual({
    owner_id: ACCOUNT,
    kind: 'image',
    derived_from: 'vid-filed',
    folder_id: 'f-unit',
    asset_id: frame.assetId,
    status: 'ready',
    oss_key: '',
  });
  expect(await rootsOf(h, frame.id)).toEqual([frame.assetId]);
  const text = await h.provider.assetStore.resolve(
    { key: `owner:${ACCOUNT}` },
    result.text.assetId as never,
  );
  expect(Buffer.from(text!.bytes).toString()).toBe('[00:00:00.000 - 00:00:04.000] Hello class');
}

/**
 * A pool that has room for the text but not the keyframe: the extraction
 * fails for good with a stated reason, nothing is published, and the text's
 * pending entry is left to expire. A manual restart is allowed.
 */
export async function quotaFailureScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'vid-big', { mime: 'video/mp4', bytes: Buffer.from('mp4') });
  await ensure(h, 'vid-big');
  await drain(h);
  const state = await stateOf(h, 'vid-big');
  expect(state).toMatchObject({
    status: 'failed',
    extraction_result: null,
    reason_code: 'storage_full',
  });
  expect(state.extraction_error).toMatch(/no room/);
  expect(await rootCount(h)).toBe(0);
  // The transcript's entry fitted, then the keyframe's was refused: the run
  // can never publish, so it removed the transcript's entry instead of
  // leaving it to hold quota until it expires. The refused one stored nothing.
  expect(await entryCount(h)).toBe(0);
  expect(await ensure(h, 'vid-big')).toEqual({ status: 'pending', queued: true });
}

/** Bootstrap reruns; the upload's insert and the public view keep their shape. */
export async function schemaCompatibilityScenario(h: ExtractionHarness): Promise<void> {
  await ensureOwnerMaterialSchema(h.pool as never);
  await ensureOwnerMaterialSchema(h.pool as never);
  await seedSource(h, 'src-view');
  const row = await h.pool.query<Record<string, unknown>>(
    `SELECT extraction_claims, extraction_token, extraction_result FROM owner_material WHERE id = $1`,
    ['src-view'],
  );
  expect(row.rows[0]).toEqual({
    extraction_claims: 0,
    extraction_token: null,
    extraction_result: null,
  });
  await ensure(h, 'src-view');
  await drain(h);
  const { listOwnerMaterials } = await import('@/lib/persistence/owner-materials');
  const [view] = (await listOwnerMaterials(h.pool as never, ACCOUNT)).map(publicMaterial);
  expect(Object.keys(view).sort()).toEqual(
    ['bytes', 'createdAt', 'extraction', 'kind', 'materialId', 'mime', 'originalName'].sort(),
  );
  expect(view.extraction).toEqual({ status: 'done' });
}

/**
 * A heartbeat that finds the claim taken over stops the run before it opens
 * an allocation: no transaction, no entry, no settlement of the new claim.
 */
export async function heartbeatLossScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-slow');
  await ensure(h, 'src-slow');
  let began!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (began = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.documentExtract.mockImplementationOnce(async () => {
    began();
    await gate;
    return {
      metadata: { pageCount: 1 },
      blocks: [{ id: 'b', type: 'text', text: 'slow' }],
      assets: [],
    };
  });
  let transactions = 0;
  const persistence = {
    ...h.provider,
    withTransaction: <T>(body: (tx: never) => Promise<T>): Promise<T> => {
      transactions += 1;
      return h.provider.withTransaction(body as never) as Promise<T>;
    },
  };
  const run = runNextOwnerExtraction(h.deps({ persistence: persistence as never }), {
    heartbeatIntervalMs: 10,
  });
  await started;
  expire(h);
  const takeover = (await claim(h))!;
  // Several heartbeat intervals: the stale run's heartbeat has seen the loss.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const entries = await entryCount(h);
  release();
  expect(await run).toBe(true);
  expect(transactions).toBe(0);
  expect(await entryCount(h)).toBe(entries);
  expect(await stateOf(h, 'src-slow')).toMatchObject({
    status: 'running',
    extraction_token: takeover.token,
    extraction_error: null,
  });
}

/** The entry pass of the app's collector, run as if `aheadMs` had passed. */
export async function collectEntries(h: ExtractionHarness, aheadMs = 60_000): Promise<void> {
  const collector = new AssetCollector(
    h.pool as never,
    await resolveConfiguredAssetByteStore(h.pool as never),
    {
      withTransaction: h.provider.withTransaction,
      graceMs: 1_000,
      documentReferences: true,
      assetReferencePrincipals: assetReferencePrincipalsForOwner,
      documentOwnership: STAGE_META_OWNERSHIP,
      now: () => new Date(Date.now() + aheadMs),
    },
  );
  await collector.collectPass();
}

export async function entryExists(h: ExtractionHarness, assetId: string): Promise<boolean> {
  const found = await h.pool.query('SELECT 1 FROM asset_entries WHERE id = $1', [assetId]);
  return found.rows.length > 0;
}

/** What deleting a material does to its roots (Phase 2): withdraw every one, mark it deleted. */
async function deleteWithRoots(h: ExtractionHarness, materialId: string): Promise<void> {
  const result = (await stateOf(h, materialId)).extraction_result!;
  await h.provider.withTransaction(async (tx) => {
    await changeAssetRoots(tx, {
      principals: [`owner:${ACCOUNT}`],
      remove: [
        { rootKind: 'material', rootId: materialId, assetIds: [result.text.assetId] },
        ...result.derivatives.map((derivative) => ({
          rootKind: 'material',
          rootId: derivative.id,
          assetIds: [derivative.assetId],
        })),
      ],
    });
    await tx.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', [materialId]);
  });
}

/**
 * A cache hit and the collector, in both orders. Hit first: the reusing
 * source's roots keep the shared entries through the donor's deletion and a
 * collector pass. Collector first: the donor is deleted and its entries
 * released between finding the hit and publishing it, and the run extracts
 * instead of publishing a result whose entries are gone.
 */
export async function cacheCollectorOrderScenario(h: ExtractionHarness): Promise<void> {
  const video = Buffer.from('mp4-collector');
  await seedSource(h, 'vid-donor', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-donor');
  await drain(h);
  await seedSource(h, 'vid-reuser', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-reuser');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(1);
  const shared = (await stateOf(h, 'vid-reuser')).extraction_result!;
  expect(shared.reusedFrom).toBe('vid-donor');

  await deleteWithRoots(h, 'vid-donor');
  await collectEntries(h);
  expect(await entryExists(h, shared.text.assetId)).toBe(true);
  expect(await entryExists(h, shared.derivatives[0].assetId)).toBe(true);
  expect(await rootsOf(h, 'vid-reuser')).toEqual([shared.text.assetId]);

  // Collector first. A new donor with other bytes, and a source of the same
  // bytes whose run finds it, then loses it before the hit is published.
  const lecture = Buffer.from('mp4-second-lecture');
  await seedSource(h, 'vid-donor-2', { mime: 'video/mp4', bytes: lecture });
  await ensure(h, 'vid-donor-2');
  await drain(h);
  const doomed = (await stateOf(h, 'vid-donor-2')).extraction_result!;
  await seedSource(h, 'vid-late', { mime: 'video/mp4', bytes: lecture });
  await ensure(h, 'vid-late');
  const late = (await claim(h))!;
  let first = true;
  const persistence = {
    ...h.provider,
    withTransaction: async <T>(body: (tx: never) => Promise<T>): Promise<T> => {
      if (first) {
        // The hit's publication is the run's first transaction.
        first = false;
        await deleteWithRoots(h, 'vid-donor-2');
        await collectEntries(h);
      }
      return h.provider.withTransaction(body as never) as Promise<T>;
    },
  };
  expect(await runClaimedOwnerExtraction(late, h.deps({ persistence: persistence as never }))).toBe(
    'published',
  );
  expect(await entryExists(h, doomed.text.assetId)).toBe(false);
  expect(h.mediaExtract).toHaveBeenCalledTimes(3);
  const fresh = (await stateOf(h, 'vid-late')).extraction_result!;
  expect(fresh.reusedFrom).toBeUndefined();
  expect(fresh.text.assetId).not.toBe(doomed.text.assetId);
  expect(await rootsOf(h, 'vid-late')).toEqual([fresh.text.assetId]);
}

/**
 * Two sources of the same bytes extracted at the same time: neither finds a
 * result to reuse, both extract, and each publishes its own result under its
 * own roots and derivative ids. No single-flight across sources is promised.
 */
export async function sameKeyConcurrentSourcesScenario(h: ExtractionHarness): Promise<void> {
  const video = Buffer.from('mp4-twins');
  for (const id of ['vid-twin-a', 'vid-twin-b']) {
    await seedSource(h, id, { mime: 'video/mp4', bytes: video });
    await ensure(h, id);
  }
  const original = h.mediaExtract.getMockImplementation() as (...args: unknown[]) => unknown;
  let arrived = 0;
  let releaseAll!: () => void;
  const bothExtracting = new Promise<void>((resolve) => (releaseAll = resolve));
  h.mediaExtract.mockImplementation(async (...args: unknown[]) => {
    arrived += 1;
    if (arrived === 2) releaseAll();
    await bothExtracting;
    return original(...args);
  });
  const deps = h.deps();
  const runs = await Promise.all([
    runNextOwnerExtraction(deps, { heartbeatIntervalMs: 60_000 }),
    runNextOwnerExtraction(deps, { heartbeatIntervalMs: 60_000 }),
  ]);
  expect(runs).toEqual([true, true]);
  expect(h.mediaExtract).toHaveBeenCalledTimes(2);
  const a = await stateOf(h, 'vid-twin-a');
  const b = await stateOf(h, 'vid-twin-b');
  expect([a.status, b.status]).toEqual(['done', 'done']);
  expect(a.extraction_cache_key).toBe(b.extraction_cache_key);
  for (const [id, state] of [
    ['vid-twin-a', a],
    ['vid-twin-b', b],
  ] as const) {
    const result = state.extraction_result!;
    expect(result.reusedFrom).toBeUndefined();
    expect(await rootsOf(h, id)).toEqual([result.text.assetId]);
    const frames = await h.pool.query<{ id: string }>(
      'SELECT id FROM owner_material WHERE derived_from = $1',
      [id],
    );
    expect(frames.rows.map((row) => row.id)).toEqual(result.derivatives.map((d) => d.id));
  }
  expect(a.extraction_result!.text.assetId).not.toBe(b.extraction_result!.text.assetId);
  expect(a.extraction_result!.derivatives[0].id).not.toBe(b.extraction_result!.derivatives[0].id);
}

/**
 * A claim into an account that already has a result for the same bytes:
 * both results move or stay intact under the account, and the account's next
 * source of those bytes reuses one of them.
 */
export async function claimIntoSameContentScenario(h: ExtractionHarness): Promise<void> {
  const video = Buffer.from('mp4-shared-lecture');
  await seedSource(h, 'vid-anon', { owner: ANON, mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-anon', ANON);
  await seedSource(h, 'vid-account', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-account');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(2);
  const before = {
    anon: (await stateOf(h, 'vid-anon')).extraction_result!,
    account: (await stateOf(h, 'vid-account')).extraction_result!,
  };

  await claimOwner(ANON, ACCOUNT, { provider: h.provider });

  for (const [id, result] of [
    ['vid-anon', before.anon],
    ['vid-account', before.account],
  ] as const) {
    const state = await stateOf(h, id);
    expect(state).toMatchObject({ owner_id: ACCOUNT, status: 'done' });
    expect(state.extraction_result).toEqual(result);
    expect(await rootsOf(h, id)).toEqual([result.text.assetId]);
    const entries = await h.pool.query<{ principal: string }>(
      'SELECT DISTINCT principal FROM asset_entries WHERE id = ANY($1::text[])',
      [[result.text.assetId, ...result.derivatives.map((d) => d.assetId)]],
    );
    expect(entries.rows).toEqual([{ principal: `owner:${ACCOUNT}` }]);
  }
  const frames = await h.pool.query<{ owner_id: string }>(
    `SELECT DISTINCT owner_id FROM owner_material WHERE derived_from IN ('vid-anon', 'vid-account')`,
  );
  expect(frames.rows).toEqual([{ owner_id: ACCOUNT }]);

  await seedSource(h, 'vid-next', { mime: 'video/mp4', bytes: video });
  await ensure(h, 'vid-next');
  await drain(h);
  expect(h.mediaExtract).toHaveBeenCalledTimes(2);
  const reused = (await stateOf(h, 'vid-next')).extraction_result!;
  expect(['vid-anon', 'vid-account']).toContain(reused.reusedFrom);
  expect(await rootsOf(h, 'vid-next')).toEqual([reused.text.assetId]);
}

/**
 * A document fallback that once succeeded is reused when the provider ahead
 * of it fails again: the preferred provider runs (and fails) as before, the
 * fallback does not run a second time.
 */
export async function fallbackReuseScenario(h: ExtractionHarness): Promise<void> {
  const flaky = vi.fn(async () => {
    throw Object.assign(new Error('upstream unavailable'), { status: 503 });
  });
  const fallback = h.documentExtract;
  const provider = (id: string, extract: ReturnType<typeof vi.fn>): DocumentExtractorProvider => ({
    ...documentProvider(extract),
    id: id as never,
  });
  const deps = h.deps({
    providers: () => [provider('test-flaky', flaky), provider('test-doc', fallback)],
  });
  const bytes = Buffer.from('%PDF-fallback');
  for (const id of ['doc-first', 'doc-second']) {
    await seedSource(h, id, { bytes });
    await ensure(h, id);
  }
  await drain(h, deps);
  expect(flaky).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledTimes(1);
  const first = (await stateOf(h, 'doc-first')).extraction_result!;
  const second = (await stateOf(h, 'doc-second')).extraction_result!;
  expect(first.extractor).toMatchObject({ id: 'test-doc' });
  expect(second).toMatchObject({ reusedFrom: 'doc-first', text: first.text });
  expect(await rootsOf(h, 'doc-second')).toEqual([first.text.assetId]);
}

/**
 * A donor that is still `done` but no longer roots its result -- its entries
 * still exist, unreferenced -- is not reused: a hit needs a result something
 * still keeps alive, and reusing it would revive entries on their way out.
 */
export async function withdrawnDonorScenario(h: ExtractionHarness): Promise<void> {
  const bytes = Buffer.from('%PDF-withdrawn');
  await seedSource(h, 'doc-donor', { bytes });
  await ensure(h, 'doc-donor');
  await drain(h);
  const donor = (await stateOf(h, 'doc-donor')).extraction_result!;
  await h.provider.withTransaction((tx) =>
    changeAssetRoots(tx, {
      principals: [`owner:${ACCOUNT}`],
      remove: [{ rootKind: 'material', rootId: 'doc-donor', assetIds: [donor.text.assetId] }],
    }),
  );
  expect(await entryExists(h, donor.text.assetId)).toBe(true);
  await seedSource(h, 'doc-after', { bytes });
  await ensure(h, 'doc-after');
  await drain(h);
  expect(h.documentExtract).toHaveBeenCalledTimes(2);
  const fresh = (await stateOf(h, 'doc-after')).extraction_result!;
  expect(fresh.reusedFrom).toBeUndefined();
  expect(fresh.text.assetId).not.toBe(donor.text.assetId);
  const stamped = await h.pool.query<{ unreferenced: boolean }>(
    'SELECT unreferenced_at IS NOT NULL AS unreferenced FROM asset_entries WHERE id = $1',
    [donor.text.assetId],
  );
  expect(stamped.rows[0]).toEqual({ unreferenced: true });
}

/**
 * The same bytes uploaded as video and as audio are extracted apart, in both
 * orders: the type decides whether keyframes are taken, so neither may reuse
 * the other's result. A second upload under the same type still reuses.
 */
export async function sameBytesOtherMimeScenario(h: ExtractionHarness): Promise<void> {
  const modeAware = vi.fn(async (input: { mimeType: string }) => ({
    metadata: { durationMs: 4_000 },
    transcript: [{ id: 's1', startMs: 0, endMs: 4_000, text: 'Hello class' }],
    assets: input.mimeType.startsWith('video/')
      ? [
          {
            id: 'keyframe-001',
            type: 'image',
            mimeType: 'image/png',
            data: `data:image/png;base64,${KEYFRAME.toString('base64')}`,
            metadata: { timeMs: 1_500 },
          },
        ]
      : [],
  }));
  const deps = h.deps({ mediaProviders: () => [mediaProvider(modeAware)] });
  const run = async (id: string, mime: string, bytes: Buffer) => {
    await seedSource(h, id, { mime, bytes });
    await ensure(h, id);
    await drain(h, deps);
    return (await stateOf(h, id)).extraction_result!;
  };

  const first = Buffer.from('webm-first');
  const video = await run('webm-video', 'video/webm', first);
  const audio = await run('webm-audio', 'audio/webm', first);
  expect(modeAware).toHaveBeenCalledTimes(2);
  expect(video.derivatives).toHaveLength(1);
  expect(audio.reusedFrom).toBeUndefined();
  expect(audio.derivatives).toEqual([]);

  const second = Buffer.from('webm-second');
  const audioFirst = await run('webm-audio-2', 'audio/webm', second);
  const videoAfter = await run('webm-video-2', 'video/webm', second);
  expect(modeAware).toHaveBeenCalledTimes(4);
  expect(audioFirst.derivatives).toEqual([]);
  expect(videoAfter.reusedFrom).toBeUndefined();
  expect(videoAfter.derivatives).toHaveLength(1);

  const again = await run('webm-video-3', 'video/webm', first);
  expect(modeAware).toHaveBeenCalledTimes(4);
  expect(again.reusedFrom).toBe('webm-video');
}

/**
 * A run whose claim is found lost calls no further provider: not the next
 * document fallback, and not a media extractor. Nothing is published.
 */
export async function lostClaimStopsProvidersScenario(h: ExtractionHarness): Promise<void> {
  const state = { lost: false };
  const flaky = vi.fn(async () => {
    state.lost = true;
    throw Object.assign(new Error('upstream unavailable'), { status: 503 });
  });
  const fallback = h.documentExtract;
  const provider = (id: string, extract: ReturnType<typeof vi.fn>): DocumentExtractorProvider => ({
    ...documentProvider(extract),
    id: id as never,
  });
  const deps = h.deps({
    providers: () => [provider('test-flaky', flaky), provider('test-doc', fallback)],
  });
  await seedSource(h, 'doc-lost');
  await ensure(h, 'doc-lost');
  const documentClaim = (await claim(h))!;
  expect(await runClaimedOwnerExtraction(documentClaim, deps, state)).toBe('not-authorized');
  expect(flaky).toHaveBeenCalledTimes(1);
  expect(fallback).not.toHaveBeenCalled();

  await seedSource(h, 'vid-lost', { mime: 'video/mp4', bytes: Buffer.from('mp4-lost') });
  await ensure(h, 'vid-lost');
  const mediaClaim = (await claim(h))!;
  expect(await runClaimedOwnerExtraction(mediaClaim, h.deps(), { lost: true })).toBe(
    'not-authorized',
  );
  expect(h.mediaExtract).not.toHaveBeenCalled();
  for (const id of ['doc-lost', 'vid-lost']) {
    expect(await stateOf(h, id)).toMatchObject({ status: 'running', extraction_result: null });
  }
}

/**
 * A claim found lost while the cache lookup waits on the database, the
 * lookup then a miss: the run stops there and calls no provider, on the
 * document and on the media path.
 */
export async function lostDuringLookupScenario(h: ExtractionHarness): Promise<void> {
  const runLosingInLookup = async (current: OwnerExtractionClaim) => {
    const state = { lost: false };
    const pool = h.provider.pool;
    const persistence = {
      ...h.provider,
      pool: {
        query: async (text: string, params?: unknown[]) => {
          const result = await pool.query(text, params as never);
          // The heartbeat lands while the lookup is in flight.
          if (text.includes('donor.extraction_cache_key = $2')) state.lost = true;
          return result;
        },
      },
    };
    return runClaimedOwnerExtraction(current, h.deps({ persistence: persistence as never }), state);
  };

  await seedSource(h, 'doc-lookup');
  await ensure(h, 'doc-lookup');
  expect(await runLosingInLookup((await claim(h))!)).toBe('not-authorized');
  expect(h.documentExtract).not.toHaveBeenCalled();

  await seedSource(h, 'vid-lookup', { mime: 'video/mp4', bytes: Buffer.from('mp4-lookup') });
  await ensure(h, 'vid-lookup');
  expect(await runLosingInLookup((await claim(h))!)).toBe('not-authorized');
  expect(h.mediaExtract).not.toHaveBeenCalled();
  for (const id of ['doc-lookup', 'vid-lookup']) {
    expect(await stateOf(h, id)).toMatchObject({ status: 'running', extraction_result: null });
  }
}

/** Parser errors stop provider fallback and retain the existing claim budget. */
export async function parserFailureScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'parser-timeout');
  await ensure(h, 'parser-timeout');
  const fallback = vi.fn(h.documentExtract.getMockImplementation()!);
  const providers = () => [
    documentProvider(h.documentExtract),
    { ...documentProvider(fallback), id: 'fallback-doc' as never },
  ];
  // Preserve the origin's existing transient classification, rather than
  // adding a retry mechanism for parser failures.
  const timeout = Object.assign(new Error('worker timed out'), { code: 'ETIMEDOUT' });
  const parser = vi
    .spyOn(imageParser, 'runDocumentImageWorker')
    .mockRejectedValue(new imageParser.DocumentImageParseError(timeout));
  try {
    for (let n = 1; n <= MAX_OWNER_EXTRACTION_CLAIMS; n++) {
      expect(await runNextOwnerExtraction(h.deps({ providers }))).toBe(true);
      const state = await stateOf(h, 'parser-timeout');
      expect(state.status).toBe(n < MAX_OWNER_EXTRACTION_CLAIMS ? 'pending' : 'failed');
      expect(state.extraction_result).toBeNull();
      expect(
        (
          await h.pool.query<{ extraction_error: string }>(
            'SELECT extraction_error FROM owner_material WHERE id = $1',
            ['parser-timeout'],
          )
        ).rows[0].extraction_error,
      ).toContain('Document image parse failed: worker timed out');
    }
    expect(await runNextOwnerExtraction(h.deps({ providers }))).toBe(false);
    expect(h.documentExtract).toHaveBeenCalledTimes(MAX_OWNER_EXTRACTION_CLAIMS);
    expect(fallback).not.toHaveBeenCalled();
    expect(await rootsOf(h, 'parser-timeout')).toEqual([]);
  } finally {
    parser.mockRestore();
  }
}

/** Public failure reasons survive only a terminal, current claim. */
export async function failureReasonScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-unavailable');
  await ensure(h, 'src-unavailable');
  await drain(
    h,
    h.deps({
      readSource: async (claim) => {
        throw new OwnerMaterialBytesUnavailableError(claim.materialId);
      },
    }),
  );
  expect(await stateOf(h, 'src-unavailable')).toMatchObject({
    status: 'failed',
    reason_code: 'source_unavailable',
  });
  await ensure(h, 'src-unavailable');
  expect(await stateOf(h, 'src-unavailable')).toMatchObject({
    status: 'pending',
    reason_code: null,
  });
  const old = await claim(h);
  expect(await stateOf(h, 'src-unavailable')).toMatchObject({
    status: 'running',
    reason_code: null,
  });
  await settleOwnerMaterialExtractionFailure(h.pool as never, old!, {
    reason: 'temporary private detail',
    retryable: true,
    reasonCode: 'storage_full',
  });
  expect(await stateOf(h, 'src-unavailable')).toMatchObject({
    status: 'pending',
    reason_code: null,
  });
  const current = await claim(h);
  expect(
    await settleOwnerMaterialExtractionFailure(h.pool as never, old!, {
      reason: 'late private detail',
      retryable: false,
      reasonCode: 'storage_full',
    }),
  ).toBeNull();
  await runClaimedOwnerExtraction(current!, h.deps());
  expect(await stateOf(h, 'src-unavailable')).toMatchObject({
    status: 'done',
    reason_code: null,
    extraction_error: null,
  });

  await seedSource(h, 'vid-no-service', { mime: 'video/mp4' });
  await ensure(h, 'vid-no-service');
  await drain(
    h,
    h.deps({
      mediaProviders: () => [
        {
          ...mediaProvider(h.mediaExtract),
          availability: async () => ({ available: false, reason: 'private config' }),
        },
      ],
    }),
  );
  expect(await stateOf(h, 'vid-no-service')).toMatchObject({
    status: 'failed',
    reason_code: 'service_unavailable',
    extraction_claims: 1,
  });

  await seedSource(h, 'vid-empty', { mime: 'video/mp4' });
  await ensure(h, 'vid-empty');
  await drain(
    h,
    h.deps({
      mediaProviders: () => [mediaProvider(vi.fn(async () => ({ metadata: {}, transcript: [] })))],
    }),
  );
  expect(await stateOf(h, 'vid-empty')).toMatchObject({
    status: 'failed',
    reason_code: 'no_text_extracted',
    extraction_claims: 1,
  });

  await seedSource(h, 'src-unknown');
  await ensure(h, 'src-unknown');
  await drain(
    h,
    h.deps({
      readSource: async () => {
        throw new Error('quota exceeded: private detail');
      },
    }),
  );
  expect(await stateOf(h, 'src-unknown')).toMatchObject({
    status: 'failed',
    reason_code: null,
    extraction_error: 'quota exceeded: private detail',
  });

  await seedSource(h, 'doc-failed');
  await ensure(h, 'doc-failed');
  h.documentExtract.mockRejectedValueOnce(
    new MaterialExtractionError('private document failure', false, { reasonCode: 'storage_full' }),
  );
  await drain(h);
  expect(await stateOf(h, 'doc-failed')).toMatchObject({ status: 'failed', reason_code: null });
}
