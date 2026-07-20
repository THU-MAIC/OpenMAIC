/**
 * Integration test for the admission/buffering boundary of `POST /render`.
 *
 * The security property under test (round-3 review P1#1): only
 * `maxConcurrentExtractions` requests may be inside the RAM-heavy section
 * (multipart buffering → file read → extraction) at once. Everything else waits
 * with its body unconsumed, so a burst of near-cap uploads can't stack in memory.
 *
 * We drive the real Hono app (`createApp`) with a fake manager/stores and a
 * `unzipProject` stub that parks — recording how many calls are simultaneously
 * "inside" — so we can assert the peak never exceeds the gate's permit count.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Semaphore } from '../src/semaphore.js';
import type { JobStore } from '../src/job-store.js';
import type { ArtifactStore, ArtifactLocation } from '../src/artifact-store.js';
import type { RenderJobRecord } from '../src/types.js';

// Prevent main.ts from binding a port when we import it.
process.env.RENDER_SERVICE_NO_LISTEN = 'true';

// Loaded in beforeAll after the env guard above is set.
let createApp: typeof import('../src/main.js').createApp;
let RenderManager: typeof import('../src/render-manager.js').RenderManager;

beforeAll(async () => {
  ({ createApp } = await import('../src/main.js'));
  ({ RenderManager } = await import('../src/render-manager.js'));
});

function fakeJobStore(): JobStore {
  const jobs = new Map<string, RenderJobRecord>();
  return {
    async create(r) {
      jobs.set(r.id, r);
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async update(id, patch) {
      const e = jobs.get(id);
      if (e) jobs.set(id, { ...e, ...patch });
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

/** Build a valid-looking multipart body for `POST /render`. */
function renderRequest(sizeBytes = 4096, identity = 'anon'): Request {
  const form = new FormData();
  form.append('project', new Blob([new Uint8Array(sizeBytes)]), 'project.zip');
  form.append('fps', '24');
  form.append('quality', 'draft');
  form.append('format', 'mp4');
  return new Request('http://test/render', {
    method: 'POST',
    body: form,
    headers: { 'x-openmaic-client': identity },
  });
}

describe('POST /render buffering/extraction bound', () => {
  it('never lets more than the permit count into the buffering+extraction section', async () => {
    const PERMITS = 2;
    const REQUESTS = 8;

    let inside = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    // Each extraction parks until we release it, so all admitted requests pile
    // up at the gate simultaneously — exposing any over-admission.
    const unzipProject = () =>
      new Promise<void>((resolve) => {
        inside++;
        peak = Math.max(peak, inside);
        release.push(() => {
          inside--;
          resolve();
        });
      });

    let n = 0;
    const makeProjectDir = async () => `/tmp/fake-${n++}`;

    const jobs = fakeJobStore();
    // A big per-user cap so all REQUESTS are admitted (we're testing the gate,
    // not the per-identity guard); unique identities would also work.
    const manager = new RenderManager(jobs, fakeArtifacts);
    const app = createApp({
      jobs,
      artifacts: fakeArtifacts,
      manager,
      extractionGate: new Semaphore(PERMITS),
      unzipProject,
      makeProjectDir,
    });

    // Fire all requests with distinct identities so admission never rejects them.
    const inFlight = Array.from({ length: REQUESTS }, (_, i) =>
      app.fetch(renderRequest(4096, `user-${i}`)),
    );

    // Let the event loop settle so every request that CAN enter the gate has.
    await new Promise((r) => setTimeout(r, 50));

    // The invariant: at most PERMITS extractions are parked inside right now.
    expect(inside).toBeLessThanOrEqual(PERMITS);
    expect(peak).toBeLessThanOrEqual(PERMITS);

    // Drain: release parked calls; each release frees a permit for a waiter.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }

    const responses = await Promise.all(inFlight);
    // Every request ultimately succeeds (202) once it passes through the gate.
    for (const res of responses) expect(res.status).toBe(202);
    // Peak concurrency never exceeded the permit count across the whole run.
    expect(peak).toBe(PERMITS);
  });
});
