/**
 * What a render service that received SIGTERM waits for before it exits,
 * through the real HTTP adapter: the coordinator, the routes and the shutdown
 * gate together, driven the way the app's durable export queue drives them
 * (poll the job until it succeeded, then download its output).
 */
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ShutdownGate } from '../src/shutdown-gate.js';
import { Semaphore } from '../src/semaphore.js';
import type { RenderExecutor } from '../src/render-executor.js';
import { waitUntil } from './support/async.js';
import { createMemoryArtifactStore, createMemoryJobStore } from './support/fakes.js';

// Prevent main.ts from binding a port when we import it.
process.env.RENDER_SERVICE_NO_LISTEN = 'true';

let createApp: typeof import('../src/main.js').createApp;
let RenderCoordinator: typeof import('../src/render-coordinator.js').RenderCoordinator;
const cleanups: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  ({ createApp } = await import('../src/main.js'));
  ({ RenderCoordinator } = await import('../src/render-coordinator.js'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OWNER = { 'x-openmaic-render-owner': 'owner-a' };
const MP4 = Buffer.from('finished-mp4-bytes');

/** A render service on a real port whose renders wait until released. */
async function service() {
  const dir = await mkdtemp(join(tmpdir(), 'render-shutdown-gate-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const executor: RenderExecutor = {
    async execute(request) {
      await released;
      await writeFile(request.outputPath, MP4);
      return { status: 'succeeded' };
    },
  };
  const jobs = createMemoryJobStore();
  const artifacts = createMemoryArtifactStore().store;
  const coordinator = new RenderCoordinator(executor, jobs, artifacts, { maxJobsPerUser: 0 });
  const app = createApp({
    jobs,
    artifacts,
    coordinator,
    extractionGate: new Semaphore(1),
    unzipProject: async () => {},
    makeProjectDir: async () => dir,
  });
  let exits = 0;
  const gate = new ShutdownGate(jobs, () => {
    exits += 1;
  });
  const server = serve({ fetch: gate.wrap(app.fetch), port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    coordinator,
    gate,
    jobs,
    release,
    exits: () => exits,
    /** What main.ts does on SIGTERM. */
    sigterm: () => coordinator.closeAdmission(() => gate.idle()),
    submit: async () => {
      const form = new FormData();
      form.append('project', new Blob([new Uint8Array(1024)]), 'project.zip');
      const response = await fetch(`${base}/owner-bound/render`, {
        method: 'POST',
        body: form,
        headers: { ...OWNER, 'x-openmaic-client': 'render-queue:job-1' },
      });
      expect(response.status).toBe(202);
      return ((await response.json()) as { jobId: string }).jobId;
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('exit after SIGTERM', () => {
  it('keeps a render that finished after SIGTERM downloadable, then exits', async () => {
    const render = await service();
    const jobId = await render.submit();
    render.sigterm();
    expect(await (await fetch(`${render.base}/health`)).json()).toMatchObject({
      accepting: false,
    });

    render.release();
    // The queue polls until the job succeeded...
    await waitUntil(async () => {
      const status = (await (
        await fetch(`${render.base}/owner-bound/render/${jobId}`, { headers: OWNER })
      ).json()) as { status: string };
      return status.status === 'succeeded' ? true : null;
    }, 'the render to succeed');
    // ...and the process is still there to answer the download.
    await settled();
    expect(render.exits()).toBe(0);

    const download = await fetch(`${render.base}/owner-bound/render/${jobId}/download`, {
      headers: OWNER,
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(MP4)).toBe(true);
    await waitUntil(async () => (render.exits() > 0 ? true : null), 'the exit after the download');
    await settled();
    expect(render.exits()).toBe(1);
  });

  it('waits for an output finished before SIGTERM too, and for nothing a failed download fetched', async () => {
    const render = await service();
    const jobId = await render.submit();
    render.release();
    await waitUntil(
      async () => ((await render.jobs.get(jobId))?.status === 'succeeded' ? true : null),
      'the render to succeed',
    );
    render.sigterm();
    await settled();
    expect(render.exits()).toBe(0);

    // Another owner's request is answered 404: it fetched nothing.
    const refused = await fetch(`${render.base}/owner-bound/render/${jobId}/download`, {
      headers: { 'x-openmaic-render-owner': 'owner-b' },
    });
    expect(refused.status).toBe(404);
    await settled();
    expect(render.exits()).toBe(0);

    await (
      await fetch(`${render.base}/owner-bound/render/${jobId}/download`, { headers: OWNER })
    ).arrayBuffer();
    await waitUntil(async () => (render.exits() > 0 ? true : null), 'the exit after the download');
  });

  it('preserves the download route’s 404 for a malformed job id', async () => {
    const render = await service();
    const response = await fetch(`${render.base}/owner-bound/render/%/download`, {
      headers: OWNER,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job not found' });
  });

  it('exits without a download once the unfetched job is reaped', async () => {
    const render = await service();
    const jobId = await render.submit();
    render.release();
    await waitUntil(
      async () => ((await render.jobs.get(jobId))?.status === 'succeeded' ? true : null),
      'the render to succeed',
    );
    render.sigterm();
    await settled();
    expect(render.exits()).toBe(0);

    await render.jobs.remove(jobId);
    render.gate.forget(jobId);
    await waitUntil(async () => (render.exits() > 0 ? true : null), 'the exit after the reap');
  });

  it('exits at once when SIGTERM finds nothing to wait for', async () => {
    const render = await service();
    render.sigterm();
    await waitUntil(async () => (render.exits() > 0 ? true : null), 'the exit');
  });
});
