/**
 * Claiming anonymous work on a real PostgreSQL, where transactions run on
 * separate connections: the shared scenarios, and the races the identity lock
 * exists for -- a claim against a document save, an asset allocation, and a
 * second claim of the same anonymous owner. Every race must end without a
 * deadlock, within a bounded time, with exactly one outcome and nothing left
 * under the retired owner.
 *
 * Each test works in a schema of its own (see
 * `document-asset-references.pg.test.ts` for why), dropped afterwards.
 */
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  claimOwner,
  OwnerClaimError,
  registerClaimParticipant,
  resetClaimParticipantsForTests,
} from '@/lib/persistence/owner-claims';
import { claimRefusalResponse, runPendingClaim } from '@/lib/persistence/owner-claim-http';
import { isOwnerRetiredError, ownerIdentityLockKey } from '@/lib/persistence/owner-merges';

import {
  ACCOUNT,
  ANON,
  OTHER_ACCOUNT,
  accountPrincipal,
  anonymousPrincipal,
  atomicityScenario,
  bootClaimHarness,
  claimRulesScenario,
  courseNaming,
  forwardingScenario,
  fullClaimScenario,
  rowsUnder,
  seedAnonymousWork,
  type ClaimHarness,
} from './_owner-claim-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;
/** Longer than any lock wait these races should see; a deadlock or a hang fails it. */
const RACE_BUDGET_MS = 15_000;
/** How long a blocked side is observed to stay blocked before the gate opens. */
const BLOCKED_FOR_MS = 400;

let serial = 0;

function pendingFrom(fromOwnerId: string) {
  return { fromOwnerId, assurance: 'unverified-legacy' as const };
}

interface Gate {
  reached: Promise<void>;
  release(): void;
  wait(): Promise<void>;
}

/** Every gate a test opened, released after it so a failed test cannot leave a claim parked. */
const openGates: Gate[] = [];

function gate(): Gate {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  const created: Gate = {
    reached,
    release: () => open(),
    wait: async () => {
      reach();
      await opened;
    },
  };
  openGates.push(created);
  return created;
}

/** Park every claim at `order` until the gate opens. */
function parkClaimsAt(order: number): Gate {
  const parked = gate();
  resetClaimParticipantsForTests();
  registerClaimParticipant({ name: 'test-gate', order, rekey: () => parked.wait() });
  return parked;
}

/** Whether `promise` is still pending after `ms`. */
async function stillPending(promise: Promise<unknown>, ms = BLOCKED_FOR_MS): Promise<boolean> {
  const pending = Symbol('pending');
  const winner = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  return winner === pending;
}

/** Settle all within the race budget, or fail: a deadlock or a hang must not pass. */
async function settleWithinBudget<T extends readonly Promise<unknown>[]>(
  promises: T,
): Promise<{ results: PromiseSettledResult<unknown>[]; elapsedMs: number }> {
  const started = Date.now();
  const results = await Promise.race([
    Promise.allSettled(promises),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('race did not settle in time')), RACE_BUDGET_MS),
    ),
  ]);
  return { results, elapsedMs: Date.now() - started };
}

/**
 * A deadlock victim or a lock-wait timeout: the driver's SQLSTATE, or the
 * storage package's wrapping of it (`StorageLockUnavailableError`).
 */
function isDeadlock(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== 'rejected') return false;
  const reason = result.reason as { code?: string; name?: string; cause?: unknown } | null;
  if (!reason || typeof reason !== 'object') return false;
  if (reason.name === 'StorageLockUnavailableError') return true;
  return ['40P01', '55P03'].includes(reason.code ?? '');
}

describe.skipIf(!contractUrl)('claiming anonymous work on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let harness: ClaimHarness;

  beforeEach(async () => {
    serial += 1;
    schema = `openmaic_owner_claims_test_${serial}`;
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=owner-claims-${serial}`;
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('DATABASE_URL', databaseUrl);
    harness = await bootClaimHarness(pool as never, databaseUrl);
  });

  afterEach(async () => {
    for (const open of openGates.splice(0)) open.release();
    resetClaimParticipantsForTests();
    vi.unstubAllEnvs();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('re-keys every participant and leaves nothing under the anonymous owner', async () => {
    await fullClaimScenario(harness);
  });

  it('keeps nothing when a participant throws mid-claim', async () => {
    await atomicityScenario(harness);
  });

  it('is idempotent and refuses sources, targets and chains the rules exclude', async () => {
    await claimRulesScenario(harness);
  });

  it('refuses a stale request and forwards background work', async () => {
    await forwardingScenario(harness);
  });

  it('a stale request to the persistence route is refused once its owner is claimed', async () => {
    await seedAnonymousWork(harness);
    await claimOwner(ANON, ACCOUNT, { provider: harness.provider });
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/sessions', {
        method: 'POST',
        headers: {
          cookie: `anonymous_id=${ANON.slice('anon:'.length)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      { poolFactory: () => pool },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'OWNER_RETIRED' } });
    expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ runtime: 0 });
  });

  describe('races', () => {
    it('a save that arrives while a claim runs waits for it, then is refused', async () => {
      await seedAnonymousWork(harness);
      const parked = parkClaimsAt(1000);
      const claim = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      await parked.reached;
      const save = harness
        .documents(anonymousPrincipal())
        .saveDocument(courseNaming('race-course') as never);
      expect(await stillPending(save)).toBe(true);
      parked.release();

      const { results } = await settleWithinBudget([claim, save]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      expect(results[1]!.status).toBe('rejected');
      expect(isOwnerRetiredError((results[1] as PromiseRejectedResult).reason)).toBe(true);
      const orphan = await pool.query('SELECT 1 FROM stage_meta WHERE stage_id = $1', [
        'race-course',
      ]);
      expect(orphan.rows).toHaveLength(0);
      expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ courses: 0 });
    });

    it('a save that holds the owner when a claim starts commits first, and is claimed', async () => {
      await seedAnonymousWork(harness);
      const saving = gate();
      const save = createOwnerBoundDocumentStore({
        pool,
        ownerId: ANON,
        principal: anonymousPrincipal(),
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        createHooks: { name: 'test-gate', onCreate: () => saving.wait() },
      }).saveDocument(courseNaming('race-course') as never);
      await saving.reached;
      const claim = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      expect(await stillPending(claim)).toBe(true);
      saving.release();

      const { results } = await settleWithinBudget([save, claim]);
      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'claimed', moved: { courses: 3 } },
      });
      const owner = await pool.query<{ owner_id: string }>(
        'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
        ['race-course'],
      );
      expect(owner.rows.map((row) => row.owner_id)).toEqual([ACCOUNT]);
      expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ courses: 0 });
    });

    it('a save of a course and its media never deadlocks with a claim moving both', async () => {
      // The claim is parked after it re-keyed folders and before courses and
      // assets. A save of the anonymous owner's existing course locks the
      // course, then commits the asset entries it names. Without the identity
      // lock ordering the two, a claim that took the entries before the course
      // would deadlock with it.
      const seeded = await seedAnonymousWork(harness);
      const parked = parkClaimsAt(175);
      const claim = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      await parked.reached;
      const save = harness
        .documents(anonymousPrincipal())
        .saveDocument(courseNaming('anon-course', seeded.assetId) as never);
      expect(await stillPending(save)).toBe(true);
      parked.release();

      const { results, elapsedMs } = await settleWithinBudget([claim, save]);
      expect(results.some(isDeadlock)).toBe(false);
      expect(elapsedMs).toBeLessThan(RACE_BUDGET_MS);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      expect(isOwnerRetiredError((results[1] as PromiseRejectedResult).reason)).toBe(true);
      await expect(
        harness.assets(ACCOUNT).resolve(assetPrincipalForOwner(ACCOUNT), seeded.assetId),
      ).resolves.not.toBeNull();
    });

    it('an asset allocation that arrives while a claim runs waits, then is refused', async () => {
      await seedAnonymousWork(harness);
      const parked = parkClaimsAt(1000);
      const claim = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      await parked.reached;
      const put = harness
        .assets(ANON)
        .put(assetPrincipalForOwner(ANON), new Blob(['late-bytes']), { contentType: 'image/png' });
      expect(await stillPending(put)).toBe(true);
      parked.release();

      const { results } = await settleWithinBudget([claim, put]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      expect(isOwnerRetiredError((results[1] as PromiseRejectedResult).reason)).toBe(true);
      expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ assets: 0 });
    });

    it('a runtime session create racing a claim is refused, never left under the retired id', async () => {
      // Parked after the runtime participant (600): the claim has already
      // re-keyed the owner's runtime sessions when the create arrives.
      await seedAnonymousWork(harness);
      const parked = parkClaimsAt(650);
      const claim = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      await parked.reached;
      const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
      const create = handlePersistenceRequest(
        new Request('http://localhost/api/persistence/runtime/sessions', {
          method: 'POST',
          headers: {
            cookie: `anonymous_id=${ANON.slice('anon:'.length)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: 'race-runtime-session',
            kind: 'chat',
            stageId: 'anon-course',
            learnerKey: ANON,
            status: 'active',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          }),
        }),
        { poolFactory: () => pool },
      );
      expect(await stillPending(create)).toBe(true);
      parked.release();

      const { results } = await settleWithinBudget([claim, create]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      const response = (results[1] as PromiseFulfilledResult<Response>).value;
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'OWNER_RETIRED' } });
      // The retired cookie is dropped so the browser recovers with a fresh owner.
      expect(response.headers.getSetCookie().some((c) => c.startsWith('anonymous_id=;'))).toBe(
        true,
      );
      const orphan = await pool.query('SELECT 1 FROM runtime_sessions WHERE id = $1', [
        'race-runtime-session',
      ]);
      expect(orphan.rows).toHaveLength(0);
      expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ runtime: 0 });
    });

    it('a claim that cannot get the identity lock in time answers OWNER_BUSY and changes nothing', async () => {
      await seedAnonymousWork(harness);
      vi.stubEnv('OWNER_CLAIM_LOCK_WAIT_MS', '200');
      // An in-flight write of the anonymous owner (an upload, say) holds its
      // identity lock in shared mode.
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [
          ownerIdentityLockKey(ANON).toString(),
        ]);
        const principal = { ...accountPrincipal(), pendingClaim: pendingFrom(ANON) };
        const started = Date.now();
        const outcome = await runPendingClaim(principal, { provider: harness.provider });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(outcome).toMatchObject({ ok: false, refusal: 'OWNER_BUSY', setCookies: [] });
        const response = claimRefusalResponse(
          outcome as Extract<typeof outcome, { ok: false }>,
          new Headers(),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('2');
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
      expect(await rowsUnder(harness.pool, ACCOUNT)).toMatchObject({ courses: 1 });
      // Once the writer is done, the same claim succeeds.
      await expect(
        claimOwner(ANON, ACCOUNT, { provider: harness.provider }),
      ).resolves.toMatchObject({ status: 'claimed' });
    });

    it('a write that cannot get the identity lock in time answers 503 OWNER_BUSY', async () => {
      vi.stubEnv('OWNER_WRITE_LOCK_WAIT_MS', '200');
      // A claim of the owner holds its identity lock exclusively.
      const claimant = await pool.connect();
      try {
        await claimant.query('BEGIN');
        await claimant.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          ownerIdentityLockKey(ANON).toString(),
        ]);
        const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
        const headers = {
          cookie: `anonymous_id=${ANON.slice('anon:'.length)}`,
          'content-type': 'application/json',
        };
        const save = await handlePersistenceRequest(
          new Request('http://localhost/api/persistence/documents/busy-course', {
            method: 'PUT',
            headers,
            body: JSON.stringify(courseNaming('busy-course')),
          }),
          { poolFactory: () => pool },
        );
        expect(save.status).toBe(503);
        expect(save.headers.get('retry-after')).toBe('2');
        await expect(save.json()).resolves.toMatchObject({ error: { code: 'OWNER_BUSY' } });
        const runtime = await handlePersistenceRequest(
          new Request('http://localhost/api/persistence/runtime/sessions', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              id: 'busy-runtime',
              kind: 'chat',
              stageId: 'busy-course',
              learnerKey: ANON,
              status: 'active',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            }),
          }),
          { poolFactory: () => pool },
        );
        expect(runtime.status).toBe(503);
        await expect(runtime.json()).resolves.toMatchObject({ error: { code: 'OWNER_BUSY' } });
      } finally {
        await claimant.query('ROLLBACK');
        claimant.release();
      }
      expect(await rowsUnder(harness.pool, ANON)).toMatchObject({ courses: 0, runtime: 0 });
    });

    it('a second claim of the same owner into another account waits, then is refused', async () => {
      await seedAnonymousWork(harness);
      const parked = parkClaimsAt(1000);
      const first = claimOwner(ANON, ACCOUNT, { provider: harness.provider });
      await parked.reached;
      const second = claimOwner(ANON, OTHER_ACCOUNT, { provider: harness.provider });
      expect(await stillPending(second)).toBe(true);
      parked.release();

      const { results } = await settleWithinBudget([first, second]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(OwnerClaimError);
      expect((results[1] as PromiseRejectedResult).reason.code).toBe('ALREADY_CLAIMED_ELSEWHERE');
      expect(await rowsUnder(harness.pool, OTHER_ACCOUNT)).toMatchObject({ courses: 0 });
    });

    it('concurrent claims of one owner into two accounts: exactly one wins, every time', async () => {
      for (let round = 0; round < 5; round += 1) {
        const owner = `anon:0000000${round}-9d2e-4f3a-8b4c-2d3e4f5a6b7c`;
        await harness
          .documents(anonymousPrincipal(owner))
          .saveDocument(courseNaming(`course-${round}`) as never);
        const { results } = await settleWithinBudget([
          claimOwner(owner, ACCOUNT, { provider: harness.provider }),
          claimOwner(owner, OTHER_ACCOUNT, { provider: harness.provider }),
        ]);
        const winners = results.filter((result) => result.status === 'fulfilled');
        const losers = results.filter((result) => result.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect((losers[0] as PromiseRejectedResult).reason.code).toBe('ALREADY_CLAIMED_ELSEWHERE');
        const merged = await pool.query<{ to_owner_id: string }>(
          'SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1',
          [owner],
        );
        expect(merged.rows).toHaveLength(1);
        const holder = await pool.query<{ owner_id: string }>(
          'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
          [`course-${round}`],
        );
        expect(holder.rows[0]?.owner_id).toBe(merged.rows[0]!.to_owner_id);
      }
    });
  });
});
