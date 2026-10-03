/**
 * Phase 2 of the material library (RFC #1716): the scenarios, shared by the
 * PGlite suite and the PostgreSQL one so both engines run the same
 * assertions. The PostgreSQL suite adds the races that need parallel
 * connections.
 *
 * Built on the owner-extraction harness: the real persistence provider on an
 * empty database, sources seeded the way uploads are.
 */
import { createHash } from 'node:crypto';

import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import sharp from 'sharp';
import { expect, vi } from 'vitest';

import { claimOwner } from '@/lib/persistence/owner-claims';
import {
  createMaterialFolder,
  deleteEmptyMaterialFolder,
  listMaterialFolders,
  moveMaterials,
  renameMaterial,
  renameMaterialFolder,
} from '@/lib/persistence/material-library';
import { FOLDER_COUNT_LIMIT } from '@/lib/utils/folder-name-validation';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { withMaterialRoots } from '@/lib/persistence/material-roots';
import {
  allocateOwnerMaterialBytes,
  publishOwnerMaterialUpload,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';
import {
  listSessionScopeMaterials,
  readResolvedMaterialRaw,
  readResolvedMaterialText,
  resolveMaterial,
  resolvedMaterialId,
} from '@/lib/server/agent-runtime/material-resolver';
import {
  runClaimedOwnerExtraction,
  runNextOwnerExtraction,
  startOwnerExtractionRunner,
} from '@/lib/server/material-extraction/owner-extraction';
import {
  claimNextOwnerMaterialExtraction,
  type OwnerExtractionClaim,
} from '@/lib/persistence/owner-material-extraction';
import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { buildMaterialMediaTool } from '@/lib/server/agent-runtime/material-media';
import { resolveRawMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { buildVoiceCloneTools } from '@/lib/server/agent-runtime/voice-clone-tools';
import {
  attachOwnerMaterialsToSession,
  ensureSessionMaterialLinkSchema,
  getLinkedOwnerMaterial,
  getSessionOwnerMaterial,
  listLinkedOwnerMaterials,
  listSessionOwnerLibrary,
  attachedMaterialIds,
} from '@/lib/persistence/session-material-links';

import {
  ACCOUNT,
  ANON,
  OTHER,
  bootExtractionHarness,
  collectEntries,
  rootsOf,
  ensure,
  entryExists,
  seedSource,
  stateOf,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_owner-extraction-scenarios';

export { ACCOUNT, ANON, OTHER, type ExtractionHarness, type ExtractionScenarioPool };

export type LibraryHarness = ExtractionHarness & {
  /** Material byte-store objects written or seeded by key, besides `objects/<id>`. */
  objects: Map<string, Buffer>;
};

export async function bootLibraryHarness(
  pool: ExtractionScenarioPool,
  databaseUrl: string,
): Promise<LibraryHarness> {
  const h = Object.assign(await bootExtractionHarness(pool, databaseUrl), {
    objects: new Map<string, Buffer>(),
  });
  await ensureAgentSessionMaterialSchema(pool as never);
  await ensureSessionMaterialLinkSchema(pool as never);
  // Seeded sources name `objects/<id>` (see seedSource); session copies their own keys.
  const objects = h.objects;
  setMaterialByteStoreForTests({
    put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const id = key.startsWith('objects/') ? key.slice('objects/'.length) : undefined;
      const value = objects.get(key) ?? (id ? h.sources.get(id) : undefined);
      if (!value) throw new Error(`missing material bytes: ${key}`);
      return value;
    },
    delete: async (key) => void objects.delete(key),
  });
  return h;
}

export async function seedSession(
  h: ExtractionHarness,
  id: string,
  owner: string = ACCOUNT,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id) VALUES ($1, $2, 'p', $3)`,
    [id, owner, `stage-${id}`],
  );
}

/** A ready image derivative of `sourceId`, as a publication files one. */
export async function seedDerivative(
  h: ExtractionHarness,
  id: string,
  sourceId: string,
  owner: string = ACCOUNT,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, derived_from, mime, bytes, original_name, oss_key, sha256,
        status, extraction, created_at, asset_id)
     VALUES ($1, $2, 'image', $3, 'image/png', 3, $1, '', $4, 'ready', NULL, $5, NULL)`,
    [id, owner, sourceId, createHash('sha256').update(id).digest('hex'), h.clock.now],
  );
}

/** A session copy the binder made before links: a row naming the owner material. */
export async function seedCopy(
  h: ExtractionHarness,
  sessionId: string,
  copyId: string,
  ownerMaterialId: string | null,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO agent_session_materials
       (id, session_id, kind, title, owner_material_id, raw_asset_id, text_chars,
        extraction_status)
     VALUES ($1, $2, 'source', 'copy.pdf', $3, $4, 0, 'idle')`,
    [copyId, sessionId, ownerMaterialId, `materials/${sessionId}/${copyId}/raw`],
  );
}

async function linksOf(h: ExtractionHarness, sessionId: string): Promise<string[]> {
  const result = await h.pool.query<{ material_id: string }>(
    `SELECT material_id FROM agent_session_material_links WHERE session_id = $1
      ORDER BY material_id`,
    [sessionId],
  );
  return result.rows.map((row) => row.material_id);
}

async function copyCount(h: ExtractionHarness): Promise<number> {
  const result = await h.pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM agent_session_materials',
  );
  return Number(result.rows[0]!.count);
}

const attach = (h: ExtractionHarness, sessionId: string, ids: string[], owner = ACCOUNT) =>
  attachOwnerMaterialsToSession(h.provider, { sessionId, ownerId: owner, materialIds: ids });

/**
 * Attaching links by id: no copy and no new session row, repeats collapse,
 * and the link reaches the source and its derivatives.
 */
export async function attachByIdScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-b');
  await seedDerivative(h, 'img-a1', 'src-a');

  const first = await attach(h, 'ses-1', ['src-b', 'src-a', 'src-b']);
  expect(first.status).toBe('attached');
  if (first.status !== 'attached') return;
  expect(first.materials.map((m) => [m.materialId, m.attachment])).toEqual([
    ['src-b', 'link'],
    ['src-a', 'link'],
  ]);
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a', 'src-b']);
  expect(await copyCount(h)).toBe(0);

  // Attaching again changes nothing.
  h.clock.now += 1;
  await attach(h, 'ses-1', ['src-a']);
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a', 'src-b']);

  const listed = await listLinkedOwnerMaterials(h.pool as never, 'ses-1');
  expect(listed.map((m) => m.id).sort()).toEqual(['img-a1', 'src-a', 'src-b']);
  // A derivative follows its source.
  const ids = listed.map((m) => m.id);
  expect(ids.indexOf('img-a1')).toBeGreaterThan(ids.indexOf('src-a'));

  expect((await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'img-a1'))?.derivedFrom).toBe(
    'src-a',
  );
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toMatchObject({
    id: 'src-a',
    kind: 'source',
    folderId: null,
    extractionResult: null,
  });
}

/** A session that already holds a copy keeps reading it: no link, no duplicate. */
export async function existingCopyScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-b');
  await seedSource(h, 'src-c');
  // A copy that names its source, and one the pre-upgrade binder keyed on the id.
  await seedCopy(h, 'ses-1', 'mat_copy', 'src-a');
  await seedCopy(h, 'ses-1', 'src-b', null);

  const outcome = await attach(h, 'ses-1', ['src-a', 'src-b', 'src-c']);
  expect(outcome).toMatchObject({
    status: 'attached',
    materials: [
      { materialId: 'mat_copy', attachment: 'copy' },
      { materialId: 'src-b', attachment: 'copy' },
      { materialId: 'src-c', attachment: 'link' },
    ],
  });
  expect(await linksOf(h, 'ses-1')).toEqual(['src-c']);
  expect(await copyCount(h)).toBe(2);
}

/**
 * Only the owner's ready, undeleted sources attach. One that is not makes the
 * whole call unavailable and attaches nothing.
 */
export async function attachRefusalScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSession(h, 'ses-other', OTHER);
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-deleted');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-deleted']);
  await seedSource(h, 'src-uploading');
  await h.pool.query(`UPDATE owner_material SET status = 'uploading' WHERE id = $1`, [
    'src-uploading',
  ]);
  await seedSource(h, 'src-foreign', { owner: OTHER });
  await seedDerivative(h, 'img-a1', 'src-a');

  for (const bad of ['src-deleted', 'src-uploading', 'src-foreign', 'img-a1', 'missing']) {
    expect(await attach(h, 'ses-1', ['src-a', bad])).toEqual({ status: 'unavailable' });
  }
  expect(await linksOf(h, 'ses-1')).toEqual([]);
  // Another owner's session is not this owner's to attach to.
  expect(await attach(h, 'ses-other', ['src-a'])).toEqual({ status: 'session_missing' });
  expect(await attach(h, 'ses-none', ['src-a'])).toEqual({ status: 'session_missing' });
}

/**
 * A deleted source stops answering through its link -- the source and its
 * derivatives -- while the link row stays.
 */
export async function deletedThroughLinkScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await attach(h, 'ses-1', ['src-a']);

  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-a']);
  expect(await listLinkedOwnerMaterials(h.pool as never, 'ses-1')).toEqual([]);
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toBeNull();
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'img-a1')).toBeNull();
  expect(await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'img-a1')).toBeNull();
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a']);
}

/** Library scope reaches the owner's unattached materials, never another owner's. */
export async function libraryReachScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await seedSource(h, 'src-foreign', { owner: OTHER });

  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toBeNull();
  expect((await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'src-a'))?.id).toBe('src-a');
  expect((await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'img-a1'))?.id).toBe('img-a1');
  expect(await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'src-foreign')).toBeNull();
}

/**
 * A claim moves the session and the materials together and keeps both ids:
 * the link still reaches the material, and an attachment made with the
 * anonymous owner afterwards lands for the account.
 */
export async function linkAcrossClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-anon', ANON);
  await seedSource(h, 'src-a', { owner: ANON });
  await seedSource(h, 'src-b', { owner: ANON });
  await attach(h, 'ses-anon', ['src-a'], ANON);

  await claimOwner(ANON, ACCOUNT, { provider: h.provider });

  expect((await getLinkedOwnerMaterial(h.pool as never, 'ses-anon', 'src-a'))?.ownerId).toBe(
    ACCOUNT,
  );
  // A run that started before the claim still names the anonymous owner.
  expect(await attach(h, 'ses-anon', ['src-b'], ANON)).toMatchObject({ status: 'attached' });
  expect(await linksOf(h, 'ses-anon')).toEqual(['src-a', 'src-b']);
}

/** Extract one source of `owner` to `done` with the harness's fake providers. */
async function extractToDone(h: ExtractionHarness, id: string, owner = ACCOUNT): Promise<void> {
  await ensure(h, id, owner);
  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  expect((await stateOf(h, id)).status).toBe('done');
}

/**
 * One resolver for both kinds of id: a session row wins over an owner
 * material of the same id, the link reaches owner materials, library scope
 * reaches unattached ones, and each reads its own bytes and text.
 */
export async function resolverScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a', { bytes: Buffer.from('%PDF-a') });
  await seedSource(h, 'src-b');
  await seedSource(h, 'src-old');
  await seedCopy(h, 'ses-1', 'src-old', null);
  await attachOwnerMaterialsToSession(h.provider, {
    sessionId: 'ses-1',
    ownerId: ACCOUNT,
    materialIds: ['src-a'],
  });

  const listed = await listSessionScopeMaterials('ses-1');
  expect(listed.map((m) => [m.origin, resolvedMaterialId(m)])).toEqual([
    ['session', 'src-old'],
    ['owner', 'src-a'],
  ]);

  // The copy keyed on the owner id keeps meaning the copy, in either scope.
  expect((await resolveMaterial('ses-1', 'src-old'))?.origin).toBe('session');
  expect((await resolveMaterial('ses-1', 'src-old', 'library'))?.origin).toBe('session');
  // Unattached: only library scope reaches it.
  expect(await resolveMaterial('ses-1', 'src-b')).toBeNull();
  expect((await resolveMaterial('ses-1', 'src-b', 'library'))?.origin).toBe('owner');
  expect(await resolveMaterial('ses-1', 'missing', 'library')).toBeNull();

  const linked = (await resolveMaterial('ses-1', 'src-a'))!;
  expect(await readResolvedMaterialRaw('ses-1', linked)).toEqual({
    bytes: Buffer.from('%PDF-a'),
    mime: 'application/pdf',
  });
  // No extraction yet: no text.
  expect(await readResolvedMaterialText('ses-1', linked)).toBeNull();

  await extractToDone(h, 'src-a');
  const done = (await resolveMaterial('ses-1', 'src-a'))!;
  const text = await readResolvedMaterialText('ses-1', done);
  expect(text?.text).toContain('# Lesson');
  expect(text?.revision).toBe((await stateOf(h, 'src-a')).extraction_result!.revision);
}

/**
 * After a claim re-keys the text's pool entry to the account, a reader still
 * holding the anonymous owner reads it through the fenced re-read, with the
 * revision of the result it found; a source deleted since reads nothing.
 */
export async function textAcrossClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-anon', { owner: ANON });
  await seedSource(h, 'src-gone', { owner: ANON });
  await extractToDone(h, 'src-anon', ANON);
  await extractToDone(h, 'src-gone', ANON);
  const stale = {
    id: 'src-anon',
    ownerId: ANON,
    extractionResult: (await stateOf(h, 'src-anon')).extraction_result,
  };
  const staleGone = {
    id: 'src-gone',
    ownerId: ANON,
    extractionResult: (await stateOf(h, 'src-gone')).extraction_result,
  };

  await claimOwner(ANON, ACCOUNT, { provider: h.provider });
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);

  const read = await readOwnerMaterialText(stale);
  expect(read?.text).toContain('# Lesson');
  expect(read?.revision).toBe(stale.extractionResult!.revision);
  expect(await readOwnerMaterialText(staleGone)).toBeNull();
}

/** Run one material tool of a conversation with the production dependencies. */
async function runTool(sessionId: string, name: string, params: Record<string, unknown>) {
  const tool = buildMaterialTools({ sessionId, waitForDelay: async () => undefined }).find(
    (candidate) => candidate.name === name,
  )!;
  return (await tool.execute('call', params as never)) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  };
}

/**
 * The library flow through the real tools: an unattached source is invisible
 * in session scope, extracted on the owner chain in library scope, then read
 * and searched by its own id with the revision of its result. Nothing is
 * attached along the way.
 */
export async function libraryToolFlowScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');

  expect((await runTool('ses-1', 'read_material', { materialId: 'src-a' })).details).toEqual({
    status: 'not_found',
  });
  const listed = await runTool('ses-1', 'list_materials', { scope: 'library' });
  expect(listed.details.materials).toEqual([
    expect.objectContaining({
      materialId: 'src-a',
      attached: false,
      extraction: { status: 'idle' },
    }),
  ]);

  const extract = await runTool('ses-1', 'extract_material', {
    materialId: 'src-a',
    scope: 'library',
  });
  expect(extract.details).toEqual({ materialId: 'src-a', status: 'pending', started: true });
  // Again: already queued, not started a second time.
  expect(
    (await runTool('ses-1', 'extract_material', { materialId: 'src-a', scope: 'library' })).details,
  ).toMatchObject({ status: 'pending', started: false });

  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  const waited = await runTool('ses-1', 'wait_for_materials', {
    materialIds: ['src-a'],
    scope: 'library',
    timeoutSec: 1,
  });
  expect(waited.details).toMatchObject({ complete: true, materials: [{ status: 'done' }] });

  const revision = (await stateOf(h, 'src-a')).extraction_result!.revision;
  const read = await runTool('ses-1', 'read_material', { materialId: 'src-a', scope: 'library' });
  expect(read.content[0]!.text).toContain('# Lesson');
  expect(read.details).toMatchObject({ materialId: 'src-a', revision, offset: 0 });

  const search = await runTool('ses-1', 'search_material', { query: 'lesson', scope: 'library' });
  expect(search.details.hits).toEqual([expect.objectContaining({ materialId: 'src-a', revision })]);

  // Library reads attach nothing.
  expect(await linksOf(h, 'ses-1')).toEqual([]);
}

/**
 * The library listing: omitted folderId lists every folder, null lists
 * Unfiled only; query matches names and types literally; derivatives of a
 * deleted source and other owners' materials never appear.
 */
export async function libraryListingScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-unfiled');
  h.clock.now += 1;
  await seedSource(h, 'src-filed', { folderId: 'fold-1' });
  await seedDerivative(h, 'img-filed', 'src-filed');
  await h.pool.query(`UPDATE owner_material SET folder_id = 'fold-1' WHERE id = 'img-filed'`);
  await seedSource(h, 'src-gone');
  await seedDerivative(h, 'img-gone', 'src-gone');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);
  await seedSource(h, 'src-100%_done');
  await seedSource(h, 'src-foreign', { owner: OTHER });

  const ids = async (options: Parameters<typeof listSessionOwnerLibrary>[2]) =>
    (await listSessionOwnerLibrary(h.pool as never, 'ses-1', options)).map((m) => m.id).sort();

  expect(await ids({})).toEqual(['img-filed', 'src-100%_done', 'src-filed', 'src-unfiled']);
  expect(await ids({ folderId: null })).toEqual(['src-100%_done', 'src-unfiled']);
  expect(await ids({ folderId: 'fold-1' })).toEqual(['img-filed', 'src-filed']);
  // Literal: % and _ match only themselves.
  expect(await ids({ query: '100%_' })).toEqual(['src-100%_done']);
  expect(await ids({ query: 'UNFILED' })).toEqual(['src-unfiled']);
  expect(await ids({ query: '%' })).toEqual(['src-100%_done']);

  // Keyset paging, newest first.
  const firstPage = await listSessionOwnerLibrary(h.pool as never, 'ses-1', { limit: 2 });
  const secondPage = await listSessionOwnerLibrary(h.pool as never, 'ses-1', {
    limit: 2,
    before: firstPage.at(-1)!.id,
  });
  expect([...firstPage, ...secondPage].map((m) => m.id).sort()).toEqual(await ids({}));
}

/**
 * What a listing derives from rows it may not include: a derivative's page
 * and time come from its source's result even when the source is filtered
 * out; a copy counts as attached; a text-only listing skips derivatives, so
 * newer images never crowd an older source out of a search.
 */
export async function listingDerivedFieldsScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await h.pool.query(
    `UPDATE owner_material
        SET extraction = '{"status":"done"}'::jsonb,
            extraction_result = $2::jsonb
      WHERE id = $1`,
    [
      'src-a',
      JSON.stringify({
        revision: 'rev-a',
        text: { assetId: 'pool-text', chars: 4 },
        extractor: { id: 'x', version: '1', options: {} },
        stats: {},
        derivatives: [
          {
            id: 'img-a1',
            kind: 'image',
            assetId: 'p',
            title: 't',
            mime: 'image/png',
            bytes: 3,
            sha256: 's',
            timeMs: 1500,
          },
        ],
        completedAt: 0,
      }),
    ],
  );
  h.clock.now += 1;
  for (let index = 0; index < 5; index += 1) {
    await seedDerivative(h, index === 0 ? 'img-a1' : `img-a${index + 1}`, 'src-a');
  }
  await seedSource(h, 'src-copied');
  await seedSource(h, 'src-old-copy');
  await seedSource(h, 'src-none');
  await seedCopy(h, 'ses-1', 'mat_copy', 'src-copied');
  await seedCopy(h, 'ses-1', 'src-old-copy', null);

  // The query matches the derivative only; its source is not in the result.
  const byName = await listSessionOwnerLibrary(h.pool as never, 'ses-1', { query: 'img-a1' });
  expect(byName.map((m) => [m.id, m.lineage])).toEqual([['img-a1', { timeMs: 1500 }]]);

  expect(
    [
      ...(await attachedMaterialIds(h.pool as never, 'ses-1', [
        'src-copied',
        'src-old-copy',
        'src-none',
      ])),
    ].sort(),
  ).toEqual(['src-copied', 'src-old-copy']);

  const withText = await listSessionOwnerLibrary(h.pool as never, 'ses-1', {
    withTextOnly: true,
    limit: 2,
  });
  expect(withText.map((m) => m.id)).toEqual(['src-a']);
}

/** A ready source whose original lives only in the pool, uploaded the way the route does. */
export async function seedPoolSource(
  h: ExtractionHarness,
  id: string,
  bytes: Buffer,
  mime: string,
) {
  await registerOwnerMaterial(
    h.pool as never,
    {
      id,
      ownerId: ACCOUNT,
      kind: 'source',
      mime,
      bytes: bytes.byteLength,
      originalName: `${id}.bin`,
      ossKey: '',
      extraction: { status: 'idle' },
    },
    { maxCount: 100, maxTotalBytes: 1_000_000 },
  );
  const assetId = await allocateOwnerMaterialBytes(h.provider, ACCOUNT, bytes, mime);
  await publishOwnerMaterialUpload(h.provider, ACCOUNT, id, {
    assetId,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/**
 * Every consumer of original bytes reads the same three kinds of material:
 * a linked source in the pool, a linked source from before the pool, and a
 * session copy. A pre-pool object that no longer matches its digest reads as
 * unavailable, and the consumers say so instead of using other bytes.
 */
export async function rawConsumersScenario(h: LibraryHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  const video = Buffer.from('fake-mp4');
  await seedPoolSource(h, 'src-pool', video, 'video/mp4');
  await seedSource(h, 'src-old', { mime: 'audio/mpeg', bytes: Buffer.from('fake-mp3') });
  await seedSource(h, 'src-bad', { mime: 'audio/mpeg', bytes: Buffer.from('fake-mp3-bad') });
  await seedCopy(h, 'ses-1', 'mat_copy', null);
  h.objects.set('materials/ses-1/mat_copy/raw', Buffer.from('copied'));
  await attachOwnerMaterialsToSession(h.provider, {
    sessionId: 'ses-1',
    ownerId: ACCOUNT,
    materialIds: ['src-pool', 'src-old', 'src-bad'],
  });
  // The stored object changes after its digest was recorded.
  h.sources.set('src-bad', Buffer.from('tampered'));

  const read = async (id: string) => (await resolveRawMaterial('ses-1', id))!.read();
  expect(await read('src-pool')).toEqual({ bytes: video, mime: 'video/mp4' });
  expect(await read('src-old')).toEqual({ bytes: Buffer.from('fake-mp3'), mime: 'audio/mpeg' });
  expect((await read('mat_copy'))?.bytes).toEqual(Buffer.from('copied'));
  expect(await read('src-bad')).toBeNull();
  // Unattached: no consumer reaches it in the session.
  await seedSource(h, 'src-loose');
  expect(await resolveRawMaterial('ses-1', 'src-loose')).toBeNull();

  const clip = buildVoiceCloneTools({
    sessionId: 'ses-1',
    clipAudio: async () => Buffer.alloc(0),
  }).find((tool) => tool.name === 'clip_audio')!;
  await expect(
    clip.execute('call', { materialId: 'src-bad', startSec: 0, endSec: 10 } as never),
  ).rejects.toThrow('material bytes are unavailable');

  const media = buildMaterialMediaTool({ sessionId: 'ses-1' });
  const result = (await media.execute('call', {
    materialId: 'src-bad',
    stageId: 'stage-1',
  } as never)) as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.content[0]!.text).toBe('Media bytes are unavailable.');
  expect(result.isError).toBe(true);
}

interface CourseEntryRow {
  principal: string;
  bytes: number | string;
  committed_at: unknown;
  expires_at: unknown;
  unreferenced_at: unknown;
}

async function entryOf(h: ExtractionHarness, assetId: string): Promise<CourseEntryRow> {
  const result = await h.pool.query<CourseEntryRow>(
    `SELECT entries.principal, blobs.byte_size AS bytes, entries.committed_at,
            entries.expires_at, entries.unreferenced_at
       FROM asset_entries AS entries
       JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
      WHERE entries.id = $1`,
    [assetId],
  );
  return result.rows[0]!;
}

/** A course whose one slide shows an image element naming `src`, as patch_stage writes it. */
function courseNaming(stageId: string, src: string) {
  return {
    stage: { id: stageId, name: 'Course', createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        order: 1,
        title: 'Cells',
        type: 'slide',
        createdAt: 1,
        updatedAt: 1,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#2563eb'],
              fontColor: '#111827',
              fontName: 'Inter',
            },
            elements: [
              { id: 'img-1', type: 'image', src, left: 0, top: 0, width: 100, height: 100 },
            ],
          },
        },
      },
    ],
    outline: {
      outlines: [],
      requirement: 'Course',
      generationComplete: false,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/**
 * Copy-on-use (RFC #1716 §4): every use of a material in a course allocates
 * a pending entry of its own in the owner's partition, never the material's
 * entry, and each counts in full. The course write naming it commits it with
 * a reference of its own, so withdrawing the material's root -- what
 * deleting the material does -- leaves the course's copy committed and
 * readable while the material's entry becomes unreferenced.
 */
export async function copyOnUseScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  const image = Buffer.from('fake-png-for-a-course');
  await seedPoolSource(h, 'src-img', image, 'image/png');
  await attachOwnerMaterialsToSession(h.provider, {
    sessionId: 'ses-1',
    ownerId: ACCOUNT,
    materialIds: ['src-img'],
  });
  const libraryEntry = (
    await h.pool.query<{ asset_id: string }>(
      `SELECT asset_id FROM owner_material WHERE id = 'src-img'`,
    )
  ).rows[0]!.asset_id;

  // The owner's logical usage, as the pool's quota check computes it.
  const usage = async () =>
    Number(
      (
        await h.pool.query<{ used: string }>(
          `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS used
             FROM asset_entries AS entries
             JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
            WHERE entries.principal = $1 AND entries.unreferenced_at IS NULL`,
          [assetPrincipalForOwner(ACCOUNT).key],
        )
      ).rows[0]!.used,
    );
  const before = await usage();
  const media = buildMaterialMediaTool({ sessionId: 'ses-1', ownerId: ACCOUNT });
  const copyIntoCourse = async () =>
    (
      (await media.execute('call', {
        materialId: 'src-img',
        stageId: 'stage-course',
      } as never)) as {
        details: { src: string };
      }
    ).details.src;
  const first = await copyIntoCourse();
  const second = await copyIntoCourse();

  expect(first).toMatch(/^ast_/);
  expect(new Set([first, second, libraryEntry]).size).toBe(3);
  // The same bytes are stored once, but every use counts in full.
  expect(await usage()).toBe(before + 2 * image.byteLength);
  for (const id of [first, second]) {
    const entry = await entryOf(h, id);
    expect(entry.principal).toBe(assetPrincipalForOwner(ACCOUNT).key);
    expect(Number(entry.bytes)).toBe(image.byteLength);
    // Pending: nothing names it yet, and it carries the deadline it expires on.
    expect(entry.committed_at).toBeNull();
    expect(entry.expires_at).not.toBeNull();
  }

  const courses = createOwnerBoundDocumentStore({
    pool: h.pool as never,
    ownerId: ACCOUNT,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  await courses.saveDocument(courseNaming('stage-course', first) as never);
  const refs = await h.pool.query<{ asset_id: string }>(
    `SELECT asset_id FROM document_asset_refs WHERE stage_id = 'stage-course'`,
  );
  expect(refs.rows.map((row) => row.asset_id)).toEqual([first]);
  expect((await entryOf(h, first)).committed_at).not.toBeNull();
  // The copy no page names stays pending until it expires.
  expect((await entryOf(h, second)).committed_at).toBeNull();

  // What deleting the material does to its bytes: its root is withdrawn.
  await withMaterialRoots(
    h.provider,
    { ownerId: ACCOUNT, fence: 'request', materialIds: ['src-img'] },
    ({ changeRoots }) =>
      changeRoots({ remove: [{ materialId: 'src-img', assetIds: [libraryEntry] }] }),
  );
  expect((await entryOf(h, libraryEntry)).unreferenced_at).not.toBeNull();
  const course = await entryOf(h, first);
  expect(course.committed_at).not.toBeNull();
  expect(course.unreferenced_at).toBeNull();
  const read = await h.provider.assetStore.resolve(assetPrincipalForOwner(ACCOUNT), first);
  expect(Buffer.from(read!.bytes)).toEqual(image);

  // The collector, past the pending deadline and the grace period: the copy
  // no page named and the material's withdrawn entry are reclaimed; the
  // course's copy stays and still reads.
  await collectEntries(h, 2 * 24 * 60 * 60 * 1_000);
  expect(await entryExists(h, second)).toBe(false);
  expect(await entryExists(h, libraryEntry)).toBe(false);
  expect(await entryExists(h, first)).toBe(true);
  const after = await h.provider.assetStore.resolve(assetPrincipalForOwner(ACCOUNT), first);
  expect(Buffer.from(after!.bytes)).toEqual(image);
}

/**
 * Library scope reaches an unattached material of the owner and leaves it
 * unattached; session scope does not reach it; another owner's material is
 * reached by neither.
 */
export async function mediaLibraryScopeScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedPoolSource(h, 'src-loose', Buffer.from('fake-png-loose'), 'image/png');
  await seedSource(h, 'src-foreign', { owner: OTHER, mime: 'image/png' });
  const media = buildMaterialMediaTool({ sessionId: 'ses-1', ownerId: ACCOUNT });
  const run = async (materialId: string, scope?: 'session' | 'library') =>
    (await media.execute('call', {
      materialId,
      stageId: 'stage-course',
      ...(scope ? { scope } : {}),
    } as never)) as { isError?: boolean; details: Record<string, unknown> };

  const unattached = await run('src-loose');
  expect(unattached.isError).toBe(true);
  expect(unattached.details).toEqual({ materialId: 'src-loose' });

  const fromLibrary = await run('src-loose', 'library');
  expect(fromLibrary.isError).toBeUndefined();
  expect(fromLibrary.details.src).toMatch(/^ast_/);
  expect(await linksOf(h, 'ses-1')).toEqual([]);

  expect((await run('src-foreign', 'library')).isError).toBe(true);
}

async function entryIds(h: ExtractionHarness): Promise<string[]> {
  const result = await h.pool.query<{ id: string }>('SELECT id FROM asset_entries ORDER BY id');
  return result.rows.map((row) => row.id);
}

/** Queue and claim one video source of `owner`: its run allocates a transcript and a keyframe. */
async function claimedVideo(
  h: ExtractionHarness,
  id: string,
  owner = ACCOUNT,
): Promise<OwnerExtractionClaim> {
  await seedSource(h, id, { owner, mime: 'video/mp4', bytes: Buffer.from(`mp4-${id}`) });
  await ensure(h, id, owner);
  return (await claimNextOwnerMaterialExtraction(h.pool as never, {
    leaseTtlMs: 60_000,
    now: h.clock.now,
    createToken: () => `token-${id}`,
  }))!;
}

/**
 * The run's persistence, with `after(n)` called once the n-th transaction of
 * the run has committed (the transcript's allocation is the first, the
 * keyframe's the second, the publication the third, a release the fourth).
 * `fail(n)` makes the n-th transaction fail as the run sees it: `before` it
 * runs, so nothing commits, or `after` it committed, the way a connection
 * dropped while COMMIT's answer was in flight looks.
 */
function persistenceWith(
  h: ExtractionHarness,
  after: (transaction: number) => Promise<void>,
  fail: (transaction: number) => 'before' | 'after' | undefined = () => undefined,
) {
  let transactions = 0;
  return {
    ...h.provider,
    withTransaction: async <T>(body: (tx: never) => Promise<T>): Promise<T> => {
      transactions += 1;
      const failure = fail(transactions);
      if (failure === 'before') throw new Error('connection reset');
      const result = await h.provider.withTransaction(body as never);
      await after(transactions);
      if (failure === 'after') throw new Error('connection reset');
      return result as T;
    },
  };
}

/**
 * A run refused for certain removes what it allocated: the source deleted
 * after both outputs were stored (the publication is refused), even when a
 * claim moved the owner to the account in between, and a claim found lost
 * before publishing. A publication whose outcome is uncertain keeps them.
 */
export async function releaseRefusedOutputsScenario(h: ExtractionHarness): Promise<void> {
  const uploads = await entryIds(h);

  // Deleted after the outputs were allocated, with a claim of the owner first.
  const deleted = await claimedVideo(h, 'vid-deleted', ANON);
  const deletedRun = persistenceWith(h, async (transaction) => {
    if (transaction === 1) await claimOwner(ANON, ACCOUNT, { provider: h.provider });
    if (transaction === 2) {
      await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['vid-deleted']);
    }
  });
  expect(
    await runClaimedOwnerExtraction(deleted, h.deps({ persistence: deletedRun as never })),
  ).toBe('not-authorized');
  expect(await entryIds(h)).toEqual(uploads);

  // The claim is found lost after the outputs were allocated.
  const lost = await claimedVideo(h, 'vid-lost');
  const state = { lost: false };
  const lostRun = persistenceWith(h, async (transaction) => {
    if (transaction === 2) state.lost = true;
  });
  expect(
    await runClaimedOwnerExtraction(lost, h.deps({ persistence: lostRun as never }), state),
  ).toBe('not-authorized');
  expect(await entryIds(h)).toEqual(uploads);

  // The publication fails before it ran, as far as the run knows it may have
  // committed: keep both.
  const uncertain = await claimedVideo(h, 'vid-uncertain');
  const uncertainRun = persistenceWith(
    h,
    async () => undefined,
    (n) => (n === 3 ? 'before' : undefined),
  );
  await expect(
    runClaimedOwnerExtraction(uncertain, h.deps({ persistence: uncertainRun as never })),
  ).rejects.toThrow('connection reset');
  const kept = (await entryIds(h)).filter((id) => !uploads.includes(id));
  expect(kept).toHaveLength(2);
}

/**
 * The edges of releasing: a publication that committed and then lost its
 * answer keeps its entries and roots; a root call refused because an output
 * is gone removes the rest; a release that fails only warns and keeps the
 * refusal the run reported.
 */
export async function releaseEdgesScenario(h: ExtractionHarness): Promise<void> {
  // Committed, then the answer was lost: published, so nothing is removed.
  const committed = await claimedVideo(h, 'vid-committed');
  const committedRun = persistenceWith(
    h,
    async () => undefined,
    (n) => (n === 3 ? 'after' : undefined),
  );
  await expect(
    runClaimedOwnerExtraction(committed, h.deps({ persistence: committedRun as never })),
  ).rejects.toThrow('connection reset');
  const published = (await stateOf(h, 'vid-committed')).extraction_result!;
  expect((await stateOf(h, 'vid-committed')).status).toBe('done');
  const publishedIds = [published.text.assetId, ...published.derivatives.map((d) => d.assetId)];
  for (const id of publishedIds) expect(await entryExists(h, id)).toBe(true);
  const roots = await h.pool.query<{ asset_id: string }>(
    `SELECT asset_id FROM asset_root_refs WHERE asset_id = ANY($1::text[])`,
    [publishedIds],
  );
  expect(roots.rows).toHaveLength(2);

  // The keyframe's entry is gone before the publication: the root call
  // refuses it, and the transcript's entry is removed too.
  const before = await entryIds(h);
  const refused = await claimedVideo(h, 'vid-refused');
  const refusedRun = persistenceWith(h, async (n) => {
    if (n === 2) {
      const newest = (await entryIds(h)).filter((id) => !before.includes(id));
      // Both outputs are allocated; drop one of them.
      await h.pool.query('DELETE FROM asset_entries WHERE id = $1', [newest[0]]);
    }
  });
  await expect(
    runClaimedOwnerExtraction(refused, h.deps({ persistence: refusedRun as never })),
  ).rejects.toThrow('no longer stored');
  expect(await entryIds(h)).toEqual(before);

  // The release itself fails: the run still reports the refusal, the entries
  // are left to expire, and the failure is logged.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const failing = await claimedVideo(h, 'vid-release-fails');
    const failingRun = persistenceWith(
      h,
      async (n) => {
        if (n === 2) {
          await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', [
            'vid-release-fails',
          ]);
        }
      },
      (n) => (n === 4 ? 'before' : undefined),
    );
    expect(
      await runClaimedOwnerExtraction(failing, h.deps({ persistence: failingRun as never })),
    ).toBe('not-authorized');
    expect((await entryIds(h)).filter((id) => !before.includes(id))).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('vid-release-fails'),
      expect.any(Error),
    );
  } finally {
    warn.mockRestore();
  }
}

async function until(check: () => Promise<boolean>, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The owner-extraction runner extracts what is queued, and its stop waits for
 * a run under way: shutdown closes the pool only after the run published.
 */
export async function ownerRunnerScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-b');
  await ensure(h, 'src-a');
  await ensure(h, 'src-b');
  const runner = startOwnerExtractionRunner({
    dependencies: async () => h.deps(),
    scanIntervalMs: 10,
    maxConcurrent: 2,
  });
  try {
    await until(async () => (await stateOf(h, 'src-a')).status === 'done');
    await until(async () => (await stateOf(h, 'src-b')).status === 'done');
  } finally {
    await runner.stop();
  }

  // A run held inside its provider when stop is called.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const original = h.documentExtract.getMockImplementation() as (
    ...args: unknown[]
  ) => Promise<unknown>;
  h.documentExtract.mockImplementationOnce(async (...args: unknown[]) => {
    await held;
    return original(...args);
  });
  await seedSource(h, 'src-slow');
  await ensure(h, 'src-slow');
  const second = startOwnerExtractionRunner({
    dependencies: async () => h.deps(),
    scanIntervalMs: 10,
  });
  await until(async () => (await stateOf(h, 'src-slow')).status === 'running');
  let stopped = false;
  const stopping = second.stop().then((outcome) => {
    stopped = true;
    return outcome;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stopped).toBe(false);
  release();
  expect(await stopping).toEqual({ drained: true, running: 0 });
  expect((await stateOf(h, 'src-slow')).status).toBe('done');

  // A provider that does not return before the wait runs out: stop says the
  // runner is not drained instead of returning as if it were.
  let releaseStuck!: () => void;
  const stuck = new Promise<void>((resolve) => (releaseStuck = resolve));
  h.documentExtract.mockImplementationOnce(async (...args: unknown[]) => {
    await stuck;
    return original(...args);
  });
  await seedSource(h, 'src-stuck');
  await ensure(h, 'src-stuck');
  const third = startOwnerExtractionRunner({
    dependencies: async () => h.deps(),
    scanIntervalMs: 10,
  });
  await until(async () => (await stateOf(h, 'src-stuck')).status === 'running');
  expect(await third.stop({ timeoutMs: 100 })).toEqual({ drained: false, running: 1 });
  expect((await stateOf(h, 'src-stuck')).status).toBe('running');
  // Let the stuck run finish so the test leaves nothing behind.
  releaseStuck();
  await until(async () => (await stateOf(h, 'src-stuck')).status === 'done');
}

/**
 * A real PNG, so the derivative pipeline can prepare it: a small solid one,
 * or a large noisy one that stays tens of kilobytes as WebP.
 */
async function png(color: string, noisy = false): Promise<string> {
  const bytes = await sharp({
    create: {
      width: noisy ? 256 : 8,
      height: noisy ? 256 : 8,
      channels: 3,
      background: color,
      ...(noisy ? { noise: { type: 'gaussian' as const, mean: 128, sigma: 60 } } : {}),
    },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/** A provider artifact whose markdown names its images by file, as MinerU's does. */
async function mineruLikeArtifact(noisy = false) {
  return {
    metadata: { pageCount: 3 },
    blocks: [
      {
        id: 'document-text',
        type: 'markdown',
        text: [
          '# Lesson',
          '![Cell diagram](images/fig-1.jpg)',
          '<table><tr><td><img src="images/fig-2.jpg"></td></tr></table>',
          '![gone](images/missing.jpg)',
          '![remote](https://example.com/x.png)',
        ].join('\n\n'),
      },
    ],
    assets: [
      {
        id: 'img_1',
        type: 'image',
        data: await png('#ff0000', noisy),
        pageNumber: 2,
        metadata: { path: 'fig-1.jpg' },
      },
      {
        id: 'img_2',
        type: 'image',
        data: await png('#00ff00', noisy),
        metadata: { path: 'fig-2.jpg' },
      },
      { id: 'img_3', type: 'image', data: 'not-an-image', metadata: { path: 'bad.jpg' } },
    ],
  };
}

/**
 * A document's embedded images become derivatives of its source, and its text
 * names them instead of the provider's files: in the pool, rooted, filed with
 * the source, with their page. A reader sees each reference resolved to the
 * derivative's own id, and a source that reuses the result sees its own.
 */
export async function documentImagesScenario(h: ExtractionHarness): Promise<void> {
  h.documentExtract.mockImplementation((async () => mineruLikeArtifact()) as never);
  await seedSource(h, 'src-doc', { folderId: 'fold-1' });
  await ensure(h, 'src-doc');
  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  const state = await stateOf(h, 'src-doc');
  expect(state.status).toBe('done');
  const result = state.extraction_result!;
  expect(result.derivatives.map((d) => [d.key, d.mime, d.pageNumber])).toEqual([
    ['img-1', 'image/webp', 2],
    ['img-2', 'image/webp', undefined],
  ]);
  expect(result.stats).toMatchObject({ imageCount: 2 });

  // Stored: keys, no provider files, alt text for what was not kept.
  const stored = Buffer.from(
    (await h.provider.assetStore.resolve(assetPrincipalForOwner(ACCOUNT), result.text.assetId))!
      .bytes,
  ).toString();
  expect(stored).toContain('![Cell diagram](openmaic-derivative:img-1)');
  expect(stored).toContain('<img src="openmaic-derivative:img-2">');
  expect(stored).toContain(String.raw`\[image: gone\]`);
  expect(stored).toContain('![remote](https://example.com/x.png)');
  expect(stored).not.toContain('images/');

  // Each derivative: an owner material, rooted, filed with its source.
  for (const derivative of result.derivatives) {
    expect(await rootsOf(h, derivative.id)).toEqual([derivative.assetId]);
    expect((await stateOf(h, derivative.id)).folder_id).toBe('fold-1');
  }

  // Read: references name the derivatives.
  const [first, second] = result.derivatives;
  const read = (await readOwnerMaterialText({
    id: 'src-doc',
    ownerId: ACCOUNT,
    extractionResult: result,
  }))!;
  expect(read.text).toContain(`![Cell diagram](material:${first!.id})`);
  expect(read.text).toContain(`<img src="material:${second!.id}">`);
  expect(read.text).not.toContain('openmaic-derivative:');

  // Reuse: same bytes, another source. One extraction, the same text entry,
  // derivatives of its own, and its reader sees its own ids.
  await seedSource(h, 'src-copy', { bytes: h.sources.get('src-doc') });
  await ensure(h, 'src-copy');
  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  expect(h.documentExtract).toHaveBeenCalledTimes(1);
  const reused = (await stateOf(h, 'src-copy')).extraction_result!;
  expect(reused.reusedFrom).toBe('src-doc');
  expect(reused.text.assetId).toBe(result.text.assetId);
  expect(reused.derivatives.map((d) => d.key)).toEqual(['img-1', 'img-2']);
  expect(reused.derivatives.map((d) => d.id)).not.toContain(first!.id);
  const readCopy = (await readOwnerMaterialText({
    id: 'src-copy',
    ownerId: ACCOUNT,
    extractionResult: reused,
  }))!;
  expect(readCopy.text).toContain(`![Cell diagram](material:${reused.derivatives[0]!.id})`);
  expect(readCopy.text).not.toContain(first!.id);
}

/**
 * A document whose text fits the owner's pool quota but whose images do not
 * publishes nothing: the source fails with its reason, and the text's entry,
 * already allocated, is removed rather than left holding quota.
 */
export async function documentImagesQuotaScenario(h: ExtractionHarness): Promise<void> {
  h.documentExtract.mockImplementation((async () => mineruLikeArtifact(true)) as never);
  await seedSource(h, 'src-big');
  await ensure(h, 'src-big');
  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  const state = await stateOf(h, 'src-big');
  expect(state).toMatchObject({ status: 'failed', extraction_result: null });
  expect(state.extraction_error).toMatch(/no room/);
  expect(await entryIds(h)).toEqual([]);
  // The text did fit: the run got as far as the images.
  expect(h.documentExtract).toHaveBeenCalledTimes(1);
}

async function folderOfMaterial(h: ExtractionHarness, id: string): Promise<string | null> {
  return (await stateOf(h, id)).folder_id;
}

/**
 * Folders: create (the same name returns the folder), list with counts and a
 * literal query, rename (unchanged, taken, invalid), the per-owner limit.
 */
export async function foldersScenario(h: ExtractionHarness): Promise<void> {
  const create = (name: string, owner = ACCOUNT) =>
    createMaterialFolder(h.provider, { ownerId: owner, name, fence: 'request' });
  const made = await create('  Biology ');
  expect(made).toMatchObject({ status: 'ok', created: true, folder: { name: 'Biology' } });
  const again = await create('BIOLOGY');
  expect(again).toMatchObject({ status: 'ok', created: false });
  if (made.status !== 'ok' || again.status !== 'ok') return;
  expect(again.folder.id).toBe(made.folder.id);
  expect(await create('   ')).toEqual({ status: 'invalid_name', reason: 'empty' });
  expect(await create('x'.repeat(41))).toEqual({ status: 'invalid_name', reason: 'tooLong' });

  const chem = await create('Chem_100%');
  if (chem.status !== 'ok') throw new Error('expected a folder');
  await seedSource(h, 'src-a', { folderId: made.folder.id });
  // The seed helper files by id; the folder exists already.
  const listed = await listMaterialFolders(h.pool as never, ACCOUNT);
  expect(listed.map((f) => [f.name, f.materialCount])).toEqual([
    ['Biology', 1],
    ['Chem_100%', 0],
  ]);
  expect(
    (await listMaterialFolders(h.pool as never, ACCOUNT, { query: '100%' })).map((f) => f.name),
  ).toEqual(['Chem_100%']);
  expect(await listMaterialFolders(h.pool as never, OTHER)).toEqual([]);

  const rename = (folderId: string, name: string) =>
    renameMaterialFolder(h.provider, { ownerId: ACCOUNT, folderId, name, fence: 'request' });
  expect(await rename(made.folder.id, 'Biology')).toMatchObject({ status: 'unchanged' });
  expect(await rename(made.folder.id, 'chem_100%')).toEqual({ status: 'name_taken' });
  expect(await rename(made.folder.id, 'Cell biology')).toMatchObject({
    status: 'renamed',
    folder: { name: 'Cell biology' },
  });
  expect(await rename('missing', 'X')).toEqual({ status: 'not_found' });
  expect(
    await renameMaterialFolder(h.provider, {
      ownerId: OTHER,
      folderId: made.folder.id,
      name: 'Mine',
      fence: 'request',
    }),
  ).toEqual({ status: 'not_found' });

  for (
    let index = (await listMaterialFolders(h.pool as never, ACCOUNT)).length;
    index < FOLDER_COUNT_LIMIT;
    index += 1
  ) {
    expect((await create(`Folder ${index}`)).status).toBe('ok');
  }
  expect(await create('One too many')).toEqual({ status: 'limit', limit: FOLDER_COUNT_LIMIT });
  // At the limit, a name the owner already has still returns its folder.
  expect(await create('cell BIOLOGY')).toMatchObject({ status: 'ok', created: false });
}

/**
 * Moving: into a folder and back to Unfiled, derivatives with their source,
 * all or nothing, never a derivative, a deleted or another owner's material,
 * and `unchanged` when nothing moves.
 */
export async function moveScenario(h: ExtractionHarness): Promise<void> {
  const folder = await createMaterialFolder(h.provider, {
    ownerId: ACCOUNT,
    name: 'Unit 1',
    fence: 'request',
  });
  if (folder.status !== 'ok') throw new Error('expected a folder');
  const target = folder.folder.id;
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await seedSource(h, 'src-b');
  await seedSource(h, 'src-gone');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);
  await seedSource(h, 'src-foreign', { owner: OTHER });
  const move = (ids: string[], folderId: string | null) =>
    moveMaterials(h.provider, { ownerId: ACCOUNT, materialIds: ids, folderId, fence: 'request' });

  expect(await move(['src-a', 'src-b'], target)).toMatchObject({ status: 'moved', movedCount: 2 });
  expect(await folderOfMaterial(h, 'src-a')).toBe(target);
  expect(await folderOfMaterial(h, 'img-a1')).toBe(target);
  expect(await folderOfMaterial(h, 'src-b')).toBe(target);
  expect(await move(['src-a'], target)).toMatchObject({ status: 'unchanged', movedCount: 0 });

  for (const bad of ['img-a1', 'src-gone', 'src-foreign', 'missing']) {
    expect(await move(['src-a', bad], null)).toEqual({ status: 'not_movable', materialIds: [bad] });
  }
  // Nothing moved by the refused calls.
  expect(await folderOfMaterial(h, 'src-a')).toBe(target);
  expect(await move(['src-a'], 'no-such-folder')).toEqual({ status: 'folder_not_found' });

  expect(await move(['src-a'], null)).toMatchObject({ status: 'moved', folderId: null });
  // One already there, one not: one moved, and its derivative with it.
  expect(await move(['src-a', 'src-b'], target)).toMatchObject({ status: 'moved', movedCount: 1 });
  expect(await folderOfMaterial(h, 'img-a1')).toBe(target);
  await move(['src-a'], null);
  expect(await folderOfMaterial(h, 'src-a')).toBeNull();
  expect(await folderOfMaterial(h, 'img-a1')).toBeNull();
  expect(await folderOfMaterial(h, 'src-b')).toBe(target);
}

/** Renaming a source's display name; derivatives and others' materials refused. */
export async function renameMaterialScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await seedSource(h, 'src-foreign', { owner: OTHER });
  const rename = (materialId: string, name: string) =>
    renameMaterial(h.provider, { ownerId: ACCOUNT, materialId, name, fence: 'request' });
  // The original filename is what it shows until renamed.
  expect(await rename('src-a', 'src-a.pdf')).toMatchObject({ status: 'unchanged' });
  expect(await rename('src-a', ' Lesson 1 ')).toEqual({
    status: 'renamed',
    materialId: 'src-a',
    name: 'Lesson 1',
  });
  const row = await h.pool.query<{ display_name: string; original_name: string }>(
    'SELECT display_name, original_name FROM owner_material WHERE id = $1',
    ['src-a'],
  );
  expect(row.rows[0]).toEqual({ display_name: 'Lesson 1', original_name: 'src-a.pdf' });
  expect(await rename('src-a', 'Lesson 1')).toMatchObject({ status: 'unchanged' });
  expect(await rename('img-a1', 'Mine')).toEqual({ status: 'derivative' });
  expect(await rename('src-foreign', 'Mine')).toEqual({ status: 'not_found' });
  expect(await rename('src-a', '')).toEqual({ status: 'invalid_name' });
}

/** Deleting a folder: refused while a live material is in it; tombstones do not count. */
export async function deleteFolderScenario(h: ExtractionHarness): Promise<void> {
  const folder = await createMaterialFolder(h.provider, {
    ownerId: ACCOUNT,
    name: 'Unit 1',
    fence: 'request',
  });
  if (folder.status !== 'ok') throw new Error('expected a folder');
  const id = folder.folder.id;
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-old');
  await moveMaterials(h.provider, {
    ownerId: ACCOUNT,
    materialIds: ['src-a', 'src-old'],
    folderId: id,
    fence: 'request',
  });
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-old']);
  const remove = (owner = ACCOUNT) =>
    deleteEmptyMaterialFolder(h.provider, { ownerId: owner, folderId: id, fence: 'request' });

  expect(await remove()).toEqual({ status: 'not_empty', materialCount: 1 });
  expect(await remove(OTHER)).toEqual({ status: 'not_found' });
  await moveMaterials(h.provider, {
    ownerId: ACCOUNT,
    materialIds: ['src-a'],
    folderId: null,
    fence: 'request',
  });
  expect(await remove()).toEqual({ status: 'deleted' });
  expect(await folderOfMaterial(h, 'src-old')).toBeNull();
  expect(await listMaterialFolders(h.pool as never, ACCOUNT)).toEqual([]);
  expect(await remove()).toEqual({ status: 'not_found' });
}

/**
 * The fences: a request of a claimed (retired) owner is refused; an agent
 * run's write follows the claim to the account.
 */
export async function organizeAcrossClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-anon', { owner: ANON });
  await claimOwner(ANON, ACCOUNT, { provider: h.provider });
  await expect(
    createMaterialFolder(h.provider, { ownerId: ANON, name: 'Late', fence: 'request' }),
  ).rejects.toThrow();
  const background = await createMaterialFolder(h.provider, {
    ownerId: ANON,
    name: 'From the run',
    fence: 'background',
  });
  expect(background).toMatchObject({ status: 'ok', created: true });
  if (background.status !== 'ok') return;
  expect(
    await moveMaterials(h.provider, {
      ownerId: ANON,
      materialIds: ['src-anon'],
      folderId: background.folder.id,
      fence: 'background',
    }),
  ).toMatchObject({ status: 'moved' });
  expect((await listMaterialFolders(h.pool as never, ACCOUNT)).map((f) => f.materialCount)).toEqual(
    [1],
  );
}
