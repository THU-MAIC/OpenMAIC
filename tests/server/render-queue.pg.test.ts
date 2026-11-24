/**
 * The durable video export queue on PostgreSQL: the four export routes with
 * RENDER_DURABLE_QUEUE=true, the runner that sends queued jobs to the render
 * service and follows them, and the sweep that deletes what they stored. The
 * render service is a fake behind `proxyFetch`; everything else is real, the
 * byte store included (no bucket, so parts land in `asset_prefixed_bytes`).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
}));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);

import { GET as CAPABILITY } from '@/app/api/export-video/capability/route';
import { POST } from '@/app/api/export-video/render/route';
import { DELETE as CANCEL, GET as POLL } from '@/app/api/export-video/render/[jobId]/route';
import { GET as DOWNLOAD } from '@/app/api/export-video/render/[jobId]/download/route';
import { ensureOwnerMergeSchema } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { RenderQueueConfig } from '@/lib/server/render-queue/config';
import { submitQueuedRender } from '@/lib/server/render-queue/routes';
import {
  startRenderQueueRunner,
  sweepRenderJobs,
  type RenderQueueRunnerHandle,
} from '@/lib/server/render-queue/runner';
import {
  claimRenderJob,
  markRenderJobDispatched,
  resetRenderJobSchemaForTests,
} from '@/lib/server/render-queue/store';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_render_queue_test';
const OWNER = 'anon:4a1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = 'anon:7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const RENDER_URL = 'http://render-service:9000';
const UNTIL = { timeout: 15_000, interval: 20 };

/** Fast timings, so a test drives the runner through its states in seconds. */
const FAST: Partial<RenderQueueConfig> = {
  scanIntervalMs: 30,
  pollIntervalMs: 30,
  heartbeatIntervalMs: 30,
  // Well above the heartbeat: a slow database must not look like a dead worker.
  leaseTtlMs: 2000,
  lostAfterMs: 200,
  sweepIntervalMs: 60_000,
};

interface FakeJob {
  owner: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
}

/** The render service: owner-bound job routes and `/health`, in memory. */
const render = {
  accepting: true,
  down: false,
  /** Answers the next submission with a 500 (it could not read the archive). */
  failNextSubmit: false,
  /** Answers submissions 429 while its health still says accepting. */
  refuseSubmits: false,
  /** Holds each submission this long before answering. */
  submitDelayMs: 0,
  posts: 0,
  jobs: new Map<string, FakeJob>(),
  received: [] as Array<{ bytes: Uint8Array; contentType: string; client: string }>,
  deletes: [] as string[],
  mp4: new Uint8Array(),
  reset() {
    this.accepting = true;
    this.down = false;
    this.failNextSubmit = false;
    this.refuseSubmits = false;
    this.submitDelayMs = 0;
    this.posts = 0;
    this.jobs.clear();
    this.received = [];
    this.deletes = [];
    this.mp4 = new Uint8Array(randomBytes(9 * 1024 * 1024));
  },
  /** Every job it holds finishes now. */
  finish(status: FakeJob['status'] = 'succeeded') {
    for (const job of this.jobs.values()) if (job.status !== 'cancelled') job.status = status;
  },
  /** A restart: every job it held is gone. */
  restart() {
    this.jobs.clear();
  },
};

function ownerBound(response: Response): Response {
  response.headers.set('x-openmaic-render-owner-bound', '1');
  return response;
}

async function fakeRenderFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (render.down) throw new TypeError('fetch failed');
  const { pathname } = new URL(url);
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (pathname === '/health') {
    return ownerBound(Response.json({ ok: true, accepting: render.accepting }));
  }
  if (pathname === '/owner-bound/render' && method === 'POST') {
    render.posts += 1;
    if (!render.accepting || render.refuseSubmits) {
      return ownerBound(Response.json({ error: 'full', reason: 'queue_full' }, { status: 429 }));
    }
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    if (render.submitDelayMs) await new Promise((r) => setTimeout(r, render.submitDelayMs));
    if (render.failNextSubmit) {
      render.failNextSubmit = false;
      return ownerBound(Response.json({ error: 'Internal Server Error' }, { status: 500 }));
    }
    const id = randomUUID();
    render.jobs.set(id, {
      owner: headers.get('x-openmaic-render-owner') ?? '',
      status: 'running',
      progress: 0.5,
    });
    render.received.push({
      bytes,
      contentType: headers.get('content-type') ?? '',
      client: headers.get('x-openmaic-client') ?? '',
    });
    return ownerBound(Response.json({ jobId: id }, { status: 202 }));
  }
  const match = pathname.match(/^\/owner-bound\/render\/([^/]+)(\/download)?$/);
  const job = match && render.jobs.get(match[1]!);
  if (!match || !job || job.owner !== headers.get('x-openmaic-render-owner')) {
    return ownerBound(Response.json({ error: 'Job not found' }, { status: 404 }));
  }
  if (method === 'DELETE') {
    job.status = 'cancelled';
    render.deletes.push(match[1]!);
    return ownerBound(Response.json({ cancelled: true }));
  }
  if (match[2]) {
    return ownerBound(
      new Response(render.mp4, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(render.mp4.byteLength) },
      }),
    );
  }
  return ownerBound(
    Response.json({
      jobId: match[1],
      status: job.status,
      progress: job.status === 'succeeded' ? 1 : job.progress,
      currentStage: 'capture',
      done: ['succeeded', 'failed', 'cancelled'].includes(job.status),
    }),
  );
}

/** A multipart export upload, with the exact bytes it sends. */
async function upload(projectBytes = 64 * 1024) {
  const form = new FormData();
  form.set('fps', '30');
  form.set('quality', 'draft');
  form.set('project', new Blob([randomBytes(projectBytes)]), 'project.zip');
  const encoded = new Request('http://localhost/x', { method: 'POST', body: form });
  const contentType = encoded.headers.get('content-type')!;
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const request = () =>
    new NextRequest('http://localhost/api/export-video/render', {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    });
  return { bytes, contentType, request };
}

const context = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const jobRequest = (jobId: string, method = 'GET') =>
  new NextRequest(`http://localhost/api/export-video/render/${jobId}`, { method });

async function submit(
  projectBytes?: number,
): Promise<{ jobId: string; bytes: Uint8Array; contentType: string }> {
  const payload = await upload(projectBytes);
  const response = await POST(payload.request());
  expect(response.status).toBe(202);
  const body = (await response.json()) as { jobId: string };
  return { jobId: body.jobId, bytes: payload.bytes, contentType: payload.contentType };
}

async function poll(jobId: string) {
  const response = await POLL(jobRequest(jobId), context(jobId));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!contractUrl)('durable video export queue on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let runner: RenderQueueRunnerHandle | undefined;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  const row = async (jobId: string) =>
    (await pool.query('SELECT * FROM render_jobs WHERE id = $1', [jobId])).rows[0] as
      | Record<string, unknown>
      | undefined;
  const storedParts = async (jobId: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM asset_prefixed_bytes WHERE prefix LIKE $1',
          [`render-jobs/${jobId}/%`],
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=render-queue`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    resetRenderJobSchemaForTests();
    await getServerPersistenceProvider(databaseUrl, () => pool);
    await ensureOwnerMergeSchema(pool);
  });

  beforeEach(async () => {
    render.reset();
    mocks.proxyFetch.mockReset();
    mocks.proxyFetch.mockImplementation(fakeRenderFetch);
    mocks.resolveRequestOwnerId.mockReset();
    mocks.resolveRequestOwnerId.mockReturnValue(OWNER);
    vi.stubEnv('RENDER_SERVICE_URL', RENDER_URL);
    vi.stubEnv('RENDER_DURABLE_QUEUE', 'true');
    vi.stubEnv('RENDER_QUEUE_MAX_JOBS', '20');
    vi.stubEnv('RENDER_QUEUE_MAX_JOBS_PER_OWNER', '0');
    await pool.query('DELETE FROM render_jobs').catch(() => undefined);
    await pool.query('DELETE FROM asset_prefixed_bytes');
  });

  afterEach(async () => {
    await runner?.stop({ timeoutMs: 5000 });
    runner = undefined;
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetRenderJobSchemaForTests();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('queues, renders, downloads and then deletes everything the job stored', async () => {
    const { jobId, bytes, contentType } = await submit(9 * 1024 * 1024);
    // Stored in 8 MiB parts in the job's own namespace, never as a course asset.
    expect(await storedParts(jobId)).toBe(2);
    expect((await pool.query('SELECT 1 FROM asset_blobs')).rowCount).toBe(0);
    expect((await poll(jobId)).body).toMatchObject({ status: 'queued', queuePosition: 0 });

    runner = startRenderQueueRunner({ config: FAST });
    await vi.waitFor(() => expect(render.received).toHaveLength(1), UNTIL);
    // The render service gets exactly the browser's multipart body.
    expect(Buffer.from(render.received[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(render.received[0]!.contentType).toBe(contentType);
    // One admission identity per job: owners are limited when they queue.
    expect(render.received[0]!.client).toBe(`render-queue:${jobId}`);
    await vi.waitFor(async () => expect((await poll(jobId)).body.status).toBe('running'), UNTIL);

    render.finish();
    await vi.waitFor(async () => expect((await poll(jobId)).body.status).toBe('succeeded'), UNTIL);
    const download = await DOWNLOAD(jobRequest(`${jobId}/download`), context(jobId));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-length')).toBe(String(render.mp4.byteLength));
    expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(render.mp4))).toBe(true);
    expect(await storedParts(jobId)).toBe(4);

    // The input goes once the job has finished (after its one-minute grace)...
    await pool.query(`UPDATE render_jobs SET updated_at = now() - interval '2 minutes'`);
    await sweepRenderJobs({
      ...(FAST as RenderQueueConfig),
      retentionMs: 3_600_000,
      staleUploadMs: 3_600_000,
    });
    expect(await storedParts(jobId)).toBe(2);
    expect((await DOWNLOAD(jobRequest(`${jobId}/download`), context(jobId))).status).toBe(200);
    // ...and the MP4 and the row once the job expires.
    await sweepRenderJobs({
      ...(FAST as RenderQueueConfig),
      retentionMs: 0,
      staleUploadMs: 3_600_000,
    });
    expect(await storedParts(jobId)).toBe(0);
    expect(await row(jobId)).toBeUndefined();
  });

  it('keeps jobs in PostgreSQL while the only render service is not accepting', async () => {
    render.accepting = false;
    const first = await submit();
    const second = await submit();
    runner = startRenderQueueRunner({ config: FAST });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(render.received).toHaveLength(0);
    expect((await poll(second.jobId)).body).toMatchObject({ status: 'queued', queuePosition: 1 });
    // The queue has room, so the export menu stays usable.
    const capability = await (await CAPABILITY()).json();
    expect(capability).toMatchObject({ enabled: true, accepting: true });

    render.accepting = true;
    await vi.waitFor(() => expect(render.received.length).toBeGreaterThanOrEqual(1), UNTIL);
    expect((await row(first.jobId))?.status).not.toBe('queued');
  });

  it('sends a job lost by the render service again, then fails it at the limit', async () => {
    const { jobId } = await submit();
    runner = startRenderQueueRunner({ config: FAST });
    await vi.waitFor(() => expect(render.received).toHaveLength(1), UNTIL);
    await vi.waitFor(async () => expect((await row(jobId))?.status).toBe('running'), UNTIL);

    render.restart(); // answers 404 for the job from now on
    await vi.waitFor(() => expect(render.received).toHaveLength(2), UNTIL);
    await vi.waitFor(async () => expect((await row(jobId))?.attempt).toBe(2), UNTIL);
    await vi.waitFor(async () => expect((await poll(jobId)).body.status).toBe('running'), UNTIL);

    render.down = true; // unreachable past lostAfterMs, at the attempt limit
    await vi.waitFor(async () => expect((await row(jobId))?.status).toBe('failed'), UNTIL);
    expect(await row(jobId)).toMatchObject({ error_code: 'render_lost', attempt: 2 });
    render.down = false;
    expect((await poll(jobId)).body).toMatchObject({ status: 'failed', done: true });
  });

  it('fails a job the render service cannot take, without holding up the next one', async () => {
    render.failNextSubmit = true;
    const refused = await submit();
    const next = await submit();
    runner = startRenderQueueRunner({ config: FAST });
    await vi.waitFor(async () => expect((await row(next.jobId))?.status).toBe('running'), UNTIL);
    expect(await row(refused.jobId)).toMatchObject({
      status: 'failed',
      error_code: 'render_rejected',
    });
    expect((await poll(refused.jobId)).body).toMatchObject({ status: 'failed', done: true });
    expect(render.received).toHaveLength(1);
  });

  it('waits for the next scan when the render service refuses a job its health admitted', async () => {
    render.refuseSubmits = true;
    const { jobId } = await submit();
    runner = startRenderQueueRunner({ config: { ...FAST, scanIntervalMs: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // About one attempt per scan, not a loop on the same row.
    expect(render.posts).toBeGreaterThanOrEqual(1);
    expect(render.posts).toBeLessThanOrEqual(8);
    expect((await row(jobId))?.status).toBe('queued');
  });

  it('cancels at the render service a job cancelled while its archive was on its way', async () => {
    render.submitDelayMs = 500;
    const { jobId } = await submit();
    runner = startRenderQueueRunner({ config: FAST });
    await vi.waitFor(() => expect(render.posts).toBe(1), UNTIL);
    await CANCEL(jobRequest(jobId, 'DELETE'), context(jobId));
    await vi.waitFor(() => expect(render.deletes).toHaveLength(1), UNTIL);
    expect([...render.jobs.values()].map((job) => job.status)).toEqual(['cancelled']);
    expect((await row(jobId))?.status).toBe('cancelled');
  });

  it('takes over a job whose worker died and follows it to the end', async () => {
    const { jobId } = await submit();
    // A worker that dispatched the job and then died without a word.
    const claim = (await claimRenderJob('dead-worker', { leaseTtlMs: 2000, dispatch: true }))!;
    const accepted = await fakeRenderFetch(`${RENDER_URL}/owner-bound/render`, {
      method: 'POST',
      body: 'x',
      headers: { 'x-openmaic-render-owner': OWNER },
    });
    const { jobId: renderJobId } = (await accepted.json()) as { jobId: string };
    expect(await markRenderJobDispatched(claim.lease, RENDER_URL, renderJobId)).toBe(true);

    runner = startRenderQueueRunner({ config: FAST });
    render.finish();
    await vi.waitFor(async () => expect((await poll(jobId)).body.status).toBe('succeeded'), UNTIL);
    // Followed where it was, not sent again.
    expect(render.received).toHaveLength(1);
    expect((await row(jobId))?.lease_generation).toBe(2);
  });

  it('cancels a queued job, and a sent one at the render service too', async () => {
    render.accepting = false;
    const queued = await submit();
    expect(
      await (await CANCEL(jobRequest(queued.jobId, 'DELETE'), context(queued.jobId))).json(),
    ).toMatchObject({ cancelled: true });
    expect((await poll(queued.jobId)).body).toMatchObject({ status: 'cancelled', done: true });

    render.accepting = true;
    const sent = await submit();
    runner = startRenderQueueRunner({ config: FAST });
    await vi.waitFor(async () => expect((await row(sent.jobId))?.status).toBe('running'), UNTIL);
    await CANCEL(jobRequest(sent.jobId, 'DELETE'), context(sent.jobId));
    await vi.waitFor(() => expect(render.deletes).toHaveLength(1), UNTIL);
    await vi.waitFor(async () => expect((await row(sent.jobId))?.render_job_id).toBeNull(), UNTIL);
    expect(render.received).toHaveLength(1);
  });

  it('answers another owner as if the job did not exist', async () => {
    const { jobId } = await submit();
    mocks.resolveRequestOwnerId.mockReturnValue(OTHER);
    expect((await poll(jobId)).status).toBe(404);
    expect((await DOWNLOAD(jobRequest(`${jobId}/download`), context(jobId))).status).toBe(404);
    expect((await CANCEL(jobRequest(jobId, 'DELETE'), context(jobId))).status).toBe(404);
    expect((await row(jobId))?.status).toBe('queued');
    expect((await poll('not-a-job-id')).status).toBe(404);
  });

  it('refuses beyond the per-owner and deployment limits with their reasons', async () => {
    vi.stubEnv('RENDER_QUEUE_MAX_JOBS_PER_OWNER', '1');
    await submit();
    const owner = await POST((await upload(10)).request());
    expect(owner.status).toBe(429);
    expect(await owner.json()).toMatchObject({ reason: 'per_identity_limit' });

    vi.stubEnv('RENDER_QUEUE_MAX_JOBS', '1');
    mocks.resolveRequestOwnerId.mockReturnValue(OTHER);
    const full = await POST((await upload(10)).request());
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ reason: 'queue_full' });
    expect(await (await CAPABILITY()).json()).toMatchObject({ enabled: true, accepting: false });
  });

  it('fails an oversized upload and deletes the parts it stored', async () => {
    // The route's cap is 300 MiB; the same code path under a 16 MiB cap.
    const payload = await upload(20 * 1024 * 1024);
    const request = new NextRequest('http://localhost/api/export-video/render', {
      method: 'POST',
      body: payload.bytes,
      headers: { 'content-type': payload.contentType },
    });
    // Arriving in 1 MiB chunks, so parts are stored before the cap trips.
    let offset = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.bytes.byteLength) return controller.close();
        controller.enqueue(payload.bytes.subarray(offset, offset + 1024 * 1024));
        offset += 1024 * 1024;
      },
    });
    const response = await submitQueuedRender(request, chunked, OWNER, 16 * 1024 * 1024);
    expect(response.status).toBe(413);
    const failed = (
      await pool.query("SELECT id, error_code FROM render_jobs WHERE status = 'failed'")
    ).rows;
    expect(failed).toEqual([expect.objectContaining({ error_code: 'upload_too_large' })]);
    const jobId = failed[0]!.id as string;
    expect(await storedParts(jobId)).toBeGreaterThan(0);
    await pool.query(`UPDATE render_jobs SET updated_at = now() - interval '2 minutes'`);
    await sweepRenderJobs({
      ...(FAST as RenderQueueConfig),
      retentionMs: 3_600_000,
      staleUploadMs: 3_600_000,
    });
    expect(await storedParts(jobId)).toBe(0);
  });
});
