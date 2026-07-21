/**
 * Admission-control arithmetic for {@link RenderManager}. These guard the
 * reserve → submit/release lifecycle that bounds a caller *before* the archive
 * is extracted:
 *  - the global queue-depth cap (`RENDER_MAX_QUEUE`) counts reserved slots;
 *  - the per-identity cap (`RENDER_MAX_JOBS_PER_USER`) can't be bypassed;
 *  - `release()` fully undoes a reservation (the leak the route fix depends on:
 *    if a post-reserve step like makeProjectDir throws, the slot must come back).
 *
 * We drive the manager directly with in-memory stores so nothing invokes the
 * real Chromium/FFmpeg producer — this is pure counter arithmetic.
 */
import { describe, it, expect } from 'vitest';
import { RenderManager, RenderRejectedError } from '../src/render-manager.js';
import type { JobStore } from '../src/job-store.js';
import type { ArtifactStore, ArtifactLocation } from '../src/artifact-store.js';
import type { RenderJobRecord } from '../src/types.js';

function fakeJobStore(): JobStore {
  const jobs = new Map<string, RenderJobRecord>();
  return {
    async create(record) {
      jobs.set(record.id, record);
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async update(id, patch) {
      const existing = jobs.get(id);
      if (existing) jobs.set(id, { ...existing, ...patch });
    },
    async remove(id) {
      jobs.delete(id);
    },
    async list() {
      return [...jobs.values()];
    },
    async countActiveForUser() {
      return 0;
    },
  };
}

const fakeArtifacts: ArtifactStore = {
  async put() {},
  async locate(): Promise<ArtifactLocation | null> {
    return null;
  },
  async remove() {},
};

function newManager(): RenderManager {
  return new RenderManager(fakeJobStore(), fakeArtifacts);
}

describe('RenderManager admission control', () => {
  it('reserve then release fully restores the per-identity slot', () => {
    const m = newManager();
    // Default RENDER_MAX_JOBS_PER_USER is 1.
    const r = m.reserve('alice');
    // A second reserve for the same identity is now rejected...
    expect(() => m.reserve('alice')).toThrow(RenderRejectedError);
    // ...until the first is released (the makeProjectDir-failure path).
    m.release(r);
    expect(() => m.reserve('alice')).not.toThrow();
  });

  it('release is idempotent and does not double-decrement', () => {
    const m = newManager();
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
    const m = newManager();
    const a = m.reserve('alice');
    const b = m.reserve('bob'); // different identity: allowed
    expect(a.identity).toBe('alice');
    expect(b.identity).toBe('bob');
    expect(() => m.reserve('alice')).toThrow(RenderRejectedError);
    m.release(a);
    m.release(b);
  });

  it('rejects reservations once the global queue is full', () => {
    const m = newManager();
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
    const store = fakeJobStore();
    store.create = async () => {
      throw new Error('store down');
    };
    const m = new RenderManager(store, fakeArtifacts);
    const r = m.reserve('carol');
    await expect(
      m.submit(r, '/tmp/whatever', { fps: 30, quality: 'draft', format: 'mp4' }),
    ).rejects.toThrow('store down');
    // The slot must be free again: a fresh reserve for the same identity succeeds.
    expect(() => m.reserve('carol')).not.toThrow();
  });
});
