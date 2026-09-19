/**
 * Admission-control arithmetic for {@link RenderCoordinator}. These guard the
 * reserve → submit/release lifecycle that bounds a caller *before* the archive
 * is extracted:
 *  - the global queue-depth cap (`RENDER_MAX_QUEUE`) counts reserved slots;
 *  - the per-identity cap (`RENDER_MAX_JOBS_PER_USER`) can't be bypassed;
 *  - `release()` fully undoes a reservation (the leak the route fix depends on:
 *    if a post-reserve step like makeProjectDir throws, the slot must come back).
 *  - rejections carry machine-readable `reason` codes (`queue_full` /
 *    `per_identity_limit`) and the aggregate `accepting` flag flips with
 *    occupancy, so 429s and `/health` stay observable without prose parsing.
 *
 * We drive the coordinator directly with in-memory stores so nothing invokes the
 * real Chromium/FFmpeg producer — this is pure counter arithmetic.
 */
import { describe, it, expect } from 'vitest';
import { RenderCoordinator, RenderRejectedError } from '../src/render-coordinator.js';
import { waitUntil } from './support/async.js';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  parkingExecutor,
  succeedingExecutor,
} from './support/fakes.js';

function newCoordinator(): RenderCoordinator {
  return new RenderCoordinator(
    succeedingExecutor,
    createMemoryJobStore(),
    createMemoryArtifactStore().store,
  );
}

/** Run fn, return the thrown error (fails the test if fn doesn't throw). */
async function captureRejection(fn: () => unknown): Promise<RenderRejectedError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RenderRejectedError);
    return error as RenderRejectedError;
  }
  throw new Error('expected fn to throw RenderRejectedError');
}

describe('RenderCoordinator admission control', () => {
  it('reserve then release fully restores the per-identity slot', () => {
    const m = newCoordinator();
    // Default RENDER_MAX_JOBS_PER_USER is 1.
    const r = m.reserve('alice');
    // A second reserve for the same identity is now rejected...
    expect(() => m.reserve('alice')).toThrow(RenderRejectedError);
    // ...until the first is released (the makeProjectDir-failure path).
    m.release(r);
    expect(() => m.reserve('alice')).not.toThrow();
  });

  it('release is idempotent and does not double-decrement', () => {
    const m = newCoordinator();
    const r = m.reserve('bob');
    m.release(r);
    m.release(r); // no-op, must not free a slot that isn't held
    // bob now has one free slot; a fresh reserve + a stale release must not
    // let a second concurrent reserve through.
    const r2 = m.reserve('bob');
    expect(() => m.reserve('bob')).toThrow(RenderRejectedError);
    m.release(r2);
  });

  it('enforces the per-identity cap across distinct identities independently', () => {
    const m = newCoordinator();
    const a = m.reserve('alice');
    const b = m.reserve('bob'); // different identity: allowed
    expect(a.identity).toBe('alice');
    expect(b.identity).toBe('bob');
    expect(() => m.reserve('alice')).toThrow(RenderRejectedError);
    m.release(a);
    m.release(b);
  });

  it('rejects reservations once the global queue is full', () => {
    const m = newCoordinator();
    // Reserve up to RENDER_MAX_QUEUE (default 20) with unique identities so the
    // per-user guard never fires first, then the next reserve trips the queue cap.
    const held = [];
    for (let i = 0; i < 20; i++) held.push(m.reserve(`user-${i}`));
    expect(() => m.reserve('user-overflow')).toThrow(/queue is full/i);
    held.forEach((r) => m.release(r));
    // Once released, capacity is back.
    expect(() => m.reserve('user-again')).not.toThrow();
  });

  it('does not leak the identity slot when jobs.create fails', async () => {
    // submit() consumes the reservation and persists the job; if create() throws
    // (a fallible JobStore, e.g. a future Redis backend), run() never runs to
    // decrement the identity — so submit() must decrement it itself.
    const store = createMemoryJobStore();
    store.create = async () => {
      throw new Error('store down');
    };
    const m = new RenderCoordinator(succeedingExecutor, store, createMemoryArtifactStore().store);
    const r = m.reserve('carol');
    await expect(
      m.submit(r, '/tmp/whatever', { fps: 30, quality: 'draft', format: 'mp4' }),
    ).rejects.toThrow('store down');
    // The slot must be free again: a fresh reserve for the same identity succeeds.
    expect(() => m.reserve('carol')).not.toThrow();
  });

  it('labels a queue-cap rejection with reason queue_full', async () => {
    const m = new RenderCoordinator(
      succeedingExecutor,
      createMemoryJobStore(),
      createMemoryArtifactStore().store,
      { maxQueue: 1, maxJobsPerUser: 0 },
    );
    m.reserve('alice'); // fills the whole global cap
    const rejection = await captureRejection(() => m.reserve('bob'));
    expect(rejection.reason).toBe('queue_full');
    // Distinct identity, so this is genuinely the global cap — not the per-user
    // guard firing first.
    expect(rejection.message).toMatch(/queue is full/i);
  });

  it('labels a per-identity rejection with reason per_identity_limit', async () => {
    const m = new RenderCoordinator(
      succeedingExecutor,
      createMemoryJobStore(),
      createMemoryArtifactStore().store,
      { maxQueue: 10, maxJobsPerUser: 1 },
    );
    m.reserve('alice');
    // The queue has plenty of room; only alice's own slot is exhausted.
    const rejection = await captureRejection(() => m.reserve('alice'));
    expect(rejection.reason).toBe('per_identity_limit');
    // A different identity is still admitted.
    expect(() => m.reserve('bob')).not.toThrow();
  });

  it('leaves the internal reservation invariant reason-less', async () => {
    const m = newCoordinator();
    const r = m.reserve('dave');
    await m.submit(r, '/tmp/whatever', { fps: 30, quality: 'draft', format: 'mp4' });
    // Re-submitting a consumed reservation is an internal invariant, not an
    // admission-cap rejection: no reason code, so the HTTP layer omits `reason`
    // rather than serialize `undefined`.
    const rejection = await captureRejection(() =>
      m.submit(r, '/tmp/whatever', { fps: 30, quality: 'draft', format: 'mp4' }),
    );
    expect(rejection.reason).toBeUndefined();
  });

  it('accepting flips false once inSystem reaches maxQueue and back true when jobs finish', async () => {
    // An executor that parks until released, so submitted jobs hold their
    // system slots open across the reserve → queued → running lifecycle.
    const { executor, releaseRenders } = parkingExecutor();
    const jobs = createMemoryJobStore();
    const m = new RenderCoordinator(executor, jobs, createMemoryArtifactStore().store, {
      maxQueue: 2,
      maxConcurrency: 1,
      maxJobsPerUser: 0,
    });
    expect(m.accepting).toBe(true);

    const a = m.reserve('alice');
    await m.submit(a, '/tmp/whatever', { fps: 30, quality: 'draft', format: 'mp4' });
    // One running job below a cap of two: still accepting — the queued second
    // job is what crosses the threshold, so running and queued both count.
    expect(m.accepting).toBe(true);

    const b = m.reserve('bob');
    await m.submit(b, '/tmp/wherever', { fps: 30, quality: 'draft', format: 'mp4' });
    expect(m.accepting).toBe(false);
    await expect(captureRejection(() => m.reserve('carol'))).resolves.toMatchObject({
      reason: 'queue_full',
    });

    releaseRenders();
    // Both jobs drain through the (already-resolved) parked executor; once the
    // system is empty the coordinator accepts again.
    await waitUntil(
      async () => ((await jobs.list()).every((job) => job.status === 'succeeded') ? true : null),
      'all jobs to drain to succeeded',
    );
    expect(m.accepting).toBe(true);
  });
});
