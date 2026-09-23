/**
 * Claiming anonymous work: the scenarios, shared by the PGlite suite and the
 * PostgreSQL one so both engines run the same assertions. The PostgreSQL suite
 * adds the concurrency cases, which need connections that really run in
 * parallel.
 *
 * Each scenario gets an empty database behind `pool`, boots the persistence
 * provider on it, seeds one anonymous owner's work in every owner-keyed store
 * core ships, and claims it into an account.
 */
import type { Scene } from '@openmaic/dsl';
import type { AssetStore } from '@openmaic/storage';
import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { PgUserSkillStore, ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import { expect } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { assetPrincipalForOwner, createOwnerAssetStore } from '@/lib/persistence/owner-assets';
import {
  claimOwner,
  OwnerClaimError,
  registerClaimParticipant,
  resetClaimParticipantsForTests,
} from '@/lib/persistence/owner-claims';
import { registerOwnerMaterial } from '@/lib/persistence/owner-materials';
import {
  canonicalizeOwner,
  canonicalizeStoredOwner,
  forwardOwnerWrite,
  isOwnerRetiredError,
} from '@/lib/persistence/owner-merges';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

export interface ClaimScenarioPool extends TransactionSource {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
  end(): Promise<void>;
}

export const ANON = 'anon:0b5a3f4e-8c1d-4e2f-9a3b-1c2d3e4f5a6b';
export const ANON_2 = 'anon:1c6b4f5e-9d2e-4f3a-8b4c-2d3e4f5a6b7c';
export const ACCOUNT = 'proxy:alice';
export const OTHER_ACCOUNT = 'proxy:carol';
export const VIEWER = 'proxy:bob';
const NOW = 1_800_000_000_000;
const ISO_NOW = new Date(NOW).toISOString();

const NO_ROLES: ReadonlySet<string> = new Set();

export function anonymousPrincipal(ownerId = ANON): OwnerPrincipal {
  return { ownerId, kind: 'anonymous', roles: NO_ROLES, assurance: 'unverified-legacy' };
}

export function accountPrincipal(ownerId = ACCOUNT): OwnerPrincipal {
  return { ownerId, kind: 'user', roles: new Set(['course:publish']), assurance: 'verified' };
}

/** A course whose one scene shows `assetId` (when given), so the course references it. */
export function courseNaming(stageId: string, assetId?: string) {
  const scene = {
    id: `${stageId}-scene`,
    stageId,
    order: 0,
    title: 'Scene',
    type: 'slide',
    createdAt: NOW,
    updatedAt: NOW,
    content: {
      type: 'slide',
      canvas: {
        id: `${stageId}-canvas`,
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2563eb'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        elements: assetId
          ? [
              {
                id: `${stageId}-image`,
                type: 'image',
                src: assetId,
                left: 0,
                top: 0,
                width: 100,
                height: 100,
              },
            ]
          : [],
      },
    },
  } as unknown as Scene;
  return {
    stage: { id: stageId, name: stageId, createdAt: NOW, updatedAt: NOW },
    scenes: [scene],
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

export interface ClaimHarness {
  pool: ClaimScenarioPool;
  provider: ServerPersistenceProvider;
  /** The owner-bound store a request by `principal` writes through. */
  documents(principal: OwnerPrincipal, source?: TransactionSource): ReturnType<typeof store>;
  /** The asset store a request by `ownerId` uses, fenced as the route mounts it. */
  assets(ownerId: string): AssetStore;
  sessions: PgAgentSessionStore;
  skills: PgUserSkillStore;
}

function store(pool: TransactionSource, principal: OwnerPrincipal) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId: principal.ownerId,
    principal,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

/** Boot the provider (and the lazily provisioned agent tables) on an empty database. */
export async function bootClaimHarness(
  pool: ClaimScenarioPool,
  databaseUrl: string,
): Promise<ClaimHarness> {
  resetClaimParticipantsForTests();
  const provider = await getServerPersistenceProvider(databaseUrl, () => pool as never);
  await ensureAgentSessionSchema(pool as never);
  await ensureUserSkillSchema(pool as never);
  return {
    pool,
    provider,
    documents: (principal, source = pool) => store(source, principal),
    assets: (ownerId) =>
      createOwnerAssetStore(provider.assetStore, {
        ownerId,
        queryable: pool,
        transactions: {
          withTransaction: provider.withTransaction,
          storeIn: provider.assetStoreIn,
        },
      }),
    sessions: new PgAgentSessionStore(pool as never, { withTransaction: provider.withTransaction }),
    skills: new PgUserSkillStore(pool as never, { withTransaction: provider.withTransaction }),
  };
}

export interface SeededWork {
  assetId: string;
  sessionId: string;
  skillId: string;
}

/**
 * One anonymous owner's work in every core store, and an account whose
 * library collides with it: a folder of the same name ("Drafts" / "drafts")
 * and a folder with the same id ("f-shared").
 */
export async function seedAnonymousWork(h: ClaimHarness, owner = ANON): Promise<SeededWork> {
  const anonDocs = h.documents(anonymousPrincipal(owner));
  const accountDocs = h.documents(accountPrincipal());
  const assetId = await h
    .assets(owner)
    .put(assetPrincipalForOwner(owner), new Blob(['png-bytes'], { type: 'image/png' }), {
      contentType: 'image/png',
    });
  await anonDocs.createFolder('f-drafts', 'Drafts');
  await anonDocs.createFolder('f-shared', 'Ideas');
  await anonDocs.saveDocument(courseNaming('anon-course', assetId) as never);
  await anonDocs.setStageFolder('anon-course', 'f-drafts');
  await anonDocs.saveDocument(courseNaming('anon-idea') as never);
  await anonDocs.setStageFolder('anon-idea', 'f-shared');
  await accountDocs.createFolder('f-shared', 'Reading');
  await accountDocs.createFolder('f-account-drafts', 'drafts');
  await accountDocs.saveDocument(courseNaming('account-course') as never);

  await registerOwnerMaterial(
    h.pool as unknown as ConnectableQueryable,
    { id: `mat-${owner}`, ownerId: owner, kind: 'source', bytes: 10, ossKey: `k-${owner}` },
    { maxCount: 10, maxTotalBytes: 1_000 },
  );
  const session = await h.sessions.createSession({ ownerId: owner, prompt: 'make a course' });
  const skill = await h.skills.create(owner, {
    name: 'my-notes',
    title: 'Notes',
    description: 'How I take notes',
    content: 'Take notes.',
  });
  // The handle the claimed my-notes would first be renamed to: it must be skipped.
  await h.skills.create(owner, {
    name: 'my-notes-2',
    title: 'More notes',
    description: 'A second notes skill',
    content: 'More notes.',
  });
  await h.skills.create(ACCOUNT, {
    name: 'my-notes',
    title: 'Account notes',
    description: 'The account’s own',
    content: 'Mine.',
  });
  await h.provider.runtimeStore.createSession({
    id: `rt-${owner}`,
    kind: 'chat',
    stageId: 'anon-course',
    learnerKey: owner,
    status: 'active',
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
  });
  return { assetId, sessionId: session.id, skillId: skill.id };
}

/** Rows anything still holds under `owner`, per table. */
export async function rowsUnder(pool: ClaimScenarioPool, owner: string) {
  const count = async (sql: string, value = owner) =>
    Number(
      (await pool.query<{ n: string | number }>(`SELECT COUNT(*)::text AS n FROM ${sql}`, [value]))
        .rows[0]!.n,
    );
  return {
    courses: await count('stage_meta WHERE owner_id = $1'),
    folders: await count('document_folders WHERE owner_id = $1'),
    materials: await count('owner_material WHERE owner_id = $1'),
    sessions: await count('agent_sessions WHERE owner_id = $1'),
    sessionEvents: await count('agent_owner_session_events WHERE owner_id = $1'),
    sessionEventCounters: await count('agent_owner_session_event_counters WHERE owner_id = $1'),
    skills: await count('agent_user_skill WHERE owner_id = $1'),
    runtime: await count('runtime_sessions WHERE learner_key = $1'),
    assets: await count('asset_entries WHERE principal = $1', assetPrincipalForOwner(owner).key),
    // The retired ownership column, where an installation still has it.
    legacyDocumentOwners: (await hasLegacyOwnerColumn(pool))
      ? await count('document_stages WHERE owner_id = $1')
      : 0,
  };
}

async function hasLegacyOwnerColumn(pool: ClaimScenarioPool): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('document_stages') AND attname = 'owner_id'
          AND NOT attisdropped
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

/** Give `document_stages` the retired ownership column, as an upgraded installation has it. */
export async function addLegacyOwnerColumn(pool: ClaimScenarioPool): Promise<void> {
  await pool.query('ALTER TABLE document_stages ADD COLUMN IF NOT EXISTS owner_id TEXT');
}

const NOTHING = {
  courses: 0,
  folders: 0,
  materials: 0,
  sessions: 0,
  sessionEvents: 0,
  sessionEventCounters: 0,
  skills: 0,
  runtime: 0,
  assets: 0,
  legacyDocumentOwners: 0,
};

async function merges(pool: ClaimScenarioPool) {
  return (
    await pool.query<{ from_owner_id: string; to_owner_id: string }>(
      'SELECT from_owner_id, to_owner_id FROM owner_merges ORDER BY from_owner_id',
    )
  ).rows.map((row) => [row.from_owner_id, row.to_owner_id]);
}

/** Everything moves, the claimed courses keep rendering their media, and nothing stays behind. */
export async function fullClaimScenario(h: ClaimHarness): Promise<void> {
  const seeded = await seedAnonymousWork(h);
  // An upgraded installation still carrying the retired column, filled in as
  // an older version wrote it.
  await addLegacyOwnerColumn(h.pool);
  await h.pool.query(
    `UPDATE document_stages AS d SET owner_id = m.owner_id FROM stage_meta AS m
      WHERE m.stage_id = d.id`,
  );
  // A runtime session written by a newer version: it no longer validates here,
  // and must not stop the claim.
  await h.provider.runtimeStore.createSession({
    id: `rt-future-${ANON}`,
    kind: 'chat',
    stageId: 'anon-course',
    learnerKey: ANON,
    status: 'active',
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
  });
  await h.pool.query(
    `UPDATE runtime_sessions SET data = jsonb_set(data, '{runtimeDslVersion}', '"99.0.0"')
      WHERE id = $1`,
    [`rt-future-${ANON}`],
  );
  const before = await rowsUnder(h.pool, ANON);
  expect(before).toMatchObject({
    courses: 2,
    folders: 2,
    materials: 1,
    sessions: 1,
    sessionEventCounters: 1,
    skills: 2,
    legacyDocumentOwners: 2,
  });

  // Kinds come from the stored ids: `anon:<uuid v4>` is the anonymous
  // built-in's, `proxy:alice` is not anonymous.
  const result = await claimOwner(ANON, ACCOUNT, { provider: h.provider });
  expect(result).toEqual({
    status: 'claimed',
    moved: {
      'document-folders': 2,
      courses: 2,
      'owner-materials': 1,
      'agent-sessions': 1,
      'user-skills': 2,
      runtime: 2,
      assets: 1,
    },
  });
  expect(await rowsUnder(h.pool, ANON)).toEqual(NOTHING);
  expect(await merges(h.pool)).toEqual([[ANON, ACCOUNT]]);

  // Courses, listed under the account, filed per the folder rules.
  const account = h.documents(accountPrincipal());
  const listed = Object.fromEntries(
    (await account.listDocuments()).map((summary) => [summary.id, summary.folderId ?? null]),
  );
  const folders = await account.listFolders();
  const ideas = folders.find((folder) => folder.name === 'Ideas')!;
  expect(folders.map((folder) => folder.name)).toEqual(['Reading', 'drafts', 'Ideas']);
  expect(ideas.id).not.toBe('f-shared');
  expect(listed).toEqual({
    'account-course': null,
    // "Drafts" merged into the account's "drafts".
    'anon-course': 'f-account-drafts',
    // "Ideas" moved under a fresh id: the account's "f-shared" is "Reading".
    'anon-idea': ideas.id,
  });
  await expect(h.documents(anonymousPrincipal()).listDocuments()).resolves.toEqual([]);

  // Materials, agent sessions and skills.
  const materials = await h.pool.query<{ owner_id: string }>(
    'SELECT owner_id FROM owner_material WHERE id = $1',
    [`mat-${ANON}`],
  );
  expect(materials.rows.map((row) => row.owner_id)).toEqual([ACCOUNT]);
  expect((await h.sessions.listSessionsByOwner(ACCOUNT)).map((s) => s.id)).toEqual([
    seeded.sessionId,
  ]);
  expect(await h.sessions.readMaxId(ACCOUNT)).toBeGreaterThan(BigInt(0));
  const skills = await h.skills.list(ACCOUNT);
  // The claimed my-notes yields its handle to the account's, and skips
  // my-notes-2, which the claimed library already holds.
  expect(
    skills
      .map((skill) => [skill.id === seeded.skillId, skill.name] as const)
      .sort((a, b) => (a[1] < b[1] ? -1 : 1)),
  ).toEqual([
    [false, 'my-notes'],
    [false, 'my-notes-2'],
    [true, 'my-notes-3'],
  ]);

  // Runtime sessions, readable under the account's learner key.
  await expect(h.provider.runtimeStore.getSession(`rt-${ANON}`)).resolves.toMatchObject({
    learnerKey: ACCOUNT,
  });
  const futureRow = await h.pool.query<{ learner_key: string }>(
    'SELECT learner_key FROM runtime_sessions WHERE id = $1',
    [`rt-future-${ANON}`],
  );
  expect(futureRow.rows[0]?.learner_key).toBe(ACCOUNT);

  // Assets: the account's own now, and still rendering in the claimed course
  // for another owner through the foreign-read rule.
  const accountAsset = await h
    .assets(ACCOUNT)
    .resolve(assetPrincipalForOwner(ACCOUNT), seeded.assetId);
  expect(accountAsset).not.toBeNull();
  await expect(
    h.assets(VIEWER).resolve(assetPrincipalForOwner(VIEWER), seeded.assetId),
  ).resolves.not.toBeNull();
  await expect(
    h.assets(ANON).resolve(assetPrincipalForOwner(ANON), seeded.assetId),
  ).resolves.not.toBeNull(); // still a viewer of a live course, by id
  await h.assets(ACCOUNT).remove(assetPrincipalForOwner(ACCOUNT), seeded.assetId);
  await expect(
    h.assets(ACCOUNT).resolve(assetPrincipalForOwner(ACCOUNT), seeded.assetId),
  ).resolves.toBeNull();

  await expect(canonicalizeOwner(h.pool as never, ANON)).resolves.toBe(ACCOUNT);
  await expect(canonicalizeOwner(h.pool as never, ACCOUNT)).resolves.toBe(ACCOUNT);
}

/** A participant that throws mid-claim leaves every row where it was, and no merge record. */
export async function atomicityScenario(h: ClaimHarness): Promise<void> {
  await seedAnonymousWork(h);
  const before = await rowsUnder(h.pool, ANON);
  const accountBefore = await rowsUnder(h.pool, ACCOUNT);
  resetClaimParticipantsForTests();
  // After courses, folders, materials and agent sessions have been re-keyed.
  registerClaimParticipant({
    name: 'host-ledger',
    order: 450,
    rekey: async (tx) => {
      await tx.query('SELECT 1');
      throw new Error('host ledger unavailable');
    },
  });
  await expect(claimOwner(ANON, ACCOUNT, { provider: h.provider })).rejects.toThrow(
    'host ledger unavailable',
  );
  expect(await rowsUnder(h.pool, ANON)).toEqual(before);
  expect(await rowsUnder(h.pool, ACCOUNT)).toEqual(accountBefore);
  expect(await merges(h.pool)).toEqual([]);
  await expect(canonicalizeOwner(h.pool as never, ANON)).resolves.toBe(ANON);
  // And the registry is sealed by that claim.
  expect(() =>
    registerClaimParticipant({ name: 'late', order: 1000, rekey: async () => 0 }),
  ).toThrow(/after the first claim/);
  resetClaimParticipantsForTests();
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OwnerClaimError) return error.code;
    throw error;
  }
  throw new Error('expected the claim to be refused');
}

/** Idempotency, and every refusal rule; a refused claim changes nothing. */
export async function claimRulesScenario(h: ClaimHarness): Promise<void> {
  await seedAnonymousWork(h);
  const claim = (from: string, to: string) => claimOwner(from, to, { provider: h.provider });

  await expect(refusal(claim(ANON, ANON))).resolves.toBe('SAME_OWNER');
  await expect(refusal(claim(ACCOUNT, VIEWER))).resolves.toBe('SOURCE_NOT_ANONYMOUS');
  await expect(refusal(claim(ANON, ANON_2))).resolves.toBe('TARGET_ANONYMOUS');
  await expect(refusal(claim('', ACCOUNT))).resolves.toBe('INVALID_OWNER');
  // An id the authenticator does not recognize is never anonymous.
  await expect(refusal(claim('device:1', ACCOUNT))).resolves.toBe('SOURCE_NOT_ANONYMOUS');

  expect((await claim(ANON, ACCOUNT)).status).toBe('claimed');
  // Re-claiming the same pair succeeds and does nothing.
  await expect(claim(ANON, ACCOUNT)).resolves.toEqual({ status: 'already-claimed' });
  // The same anonymous owner into another account is refused.
  await expect(refusal(claim(ANON, OTHER_ACCOUNT))).resolves.toBe('ALREADY_CLAIMED_ELSEWHERE');
  expect(await rowsUnder(h.pool, OTHER_ACCOUNT)).toEqual(NOTHING);

  // No chains: a retired target, or a source that absorbed others.
  await h.pool.query(
    `INSERT INTO owner_merges (from_owner_id, to_owner_id) VALUES ('proxy:old', 'proxy:new')`,
  );
  await expect(refusal(claim(ANON_2, 'proxy:old'))).resolves.toBe('TARGET_RETIRED');
  await h.pool.query(`INSERT INTO owner_merges (from_owner_id, to_owner_id) VALUES ($1, $2)`, [
    'proxy:someone',
    ANON_2,
  ]);
  await expect(refusal(claim(ANON_2, ACCOUNT))).resolves.toBe('SOURCE_HAS_CLAIMS');

  // owner_merges holds claims of anonymous owners only: a row retiring any
  // other owner would be followed but not fenced, so reading it fails loudly.
  await expect(canonicalizeOwner(h.pool as never, 'proxy:old')).rejects.toThrow(
    /does not describe as anonymous/,
  );
}

/**
 * After a claim: a request that still presents the anonymous identity writes
 * nothing, and background work that recorded it forwards to the account.
 */
export async function forwardingScenario(h: ClaimHarness): Promise<void> {
  const seeded = await seedAnonymousWork(h);
  await claimOwner(ANON, ACCOUNT, { provider: h.provider });
  const stale = h.documents(anonymousPrincipal());

  // Requests: refused, never forwarded.
  await expect(stale.saveDocument(courseNaming('stale-course') as never)).rejects.toSatisfy(
    isOwnerRetiredError,
  );
  await expect(stale.createFolder('f-stale', 'Stale')).rejects.toSatisfy(isOwnerRetiredError);
  await expect(
    h.assets(ANON).put(assetPrincipalForOwner(ANON), new Blob(['x']), { contentType: 'image/png' }),
  ).rejects.toSatisfy(isOwnerRetiredError);
  await expect(
    registerOwnerMaterial(
      h.pool as unknown as ConnectableQueryable,
      { id: 'mat-stale', ownerId: ANON, kind: 'source', bytes: 1, ossKey: 'k-stale' },
      { maxCount: 10, maxTotalBytes: 1_000 },
    ),
  ).rejects.toSatisfy(isOwnerRetiredError);
  expect(await rowsUnder(h.pool, ANON)).toEqual(NOTHING);
  // An existing (now the account's) course is not the stale identity's to write.
  await expect(
    stale.saveDocument(courseNaming('anon-course', seeded.assetId) as never),
  ).rejects.toSatisfy(isOwnerRetiredError);

  const { createUserSkill } = await import('@/lib/server/agent-runtime/user-skills');
  const uploaded = createUserSkill(
    ANON,
    { name: 'my-upload', title: 'Upload', description: 'Uploaded late', content: 'Late.' },
    { source: 'request' },
  );
  await expect(uploaded).rejects.toSatisfy(isOwnerRetiredError);

  // Background work forwards: its writes land under the account.
  // The agent run's create_skill path: the process store forwards.
  const skill = await createUserSkill(ANON, {
    name: 'my-later',
    title: 'Later',
    description: 'Created by a run that started before the claim',
    content: 'Later.',
  });
  expect(skill.ownerId).toBe(ACCOUNT);
  const forwardedSessions = new PgAgentSessionStore(h.pool as never, {
    withTransaction: h.provider.withTransaction,
    resolveFinalOwner: forwardOwnerWrite,
  });
  await expect(forwardedSessions.readRetirement(ANON)).resolves.toBe(ACCOUNT);
  await expect(forwardedSessions.readRetirement(ACCOUNT)).resolves.toBeNull();
  await expect(canonicalizeStoredOwner(ANON)).resolves.toBe(ACCOUNT);

  const { getBackgroundDocumentStore } =
    await import('@/lib/server/agent-runtime/owner-scoped-documents');
  const background = await getBackgroundDocumentStore(ANON);
  await background.saveDocument(courseNaming('run-course') as never);
  const owner = await h.pool.query<{ owner_id: string }>(
    'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
    ['run-course'],
  );
  expect(owner.rows.map((row) => row.owner_id)).toEqual([ACCOUNT]);
  // ... and it can keep editing the courses that moved.
  await background.saveDocument(courseNaming('anon-course', seeded.assetId) as never);

  const { storeGeneratedAsset } = await import('@/lib/server/store-generated-asset');
  const generated = await storeGeneratedAsset({
    ownerId: ANON,
    stageId: 'run-course',
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    kind: 'image',
  });
  expect(generated.status).toBe('stored');
  const principal = await h.pool.query<{ principal: string }>(
    'SELECT principal FROM asset_entries WHERE id = $1',
    [(generated as { assetId: string }).assetId],
  );
  expect(principal.rows[0]?.principal).toBe(assetPrincipalForOwner(ACCOUNT).key);
  expect(await rowsUnder(h.pool, ANON)).toEqual(NOTHING);
}
