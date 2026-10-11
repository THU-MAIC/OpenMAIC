import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobStore } from '../../render-service/src/job-store';
import type { ArtifactStore } from '../../render-service/src/artifact-store';

const wire = vi.hoisted(() => ({
  fetch: vi.fn<(request: Request) => Promise<Response>>(),
  calls: [] as string[],
}));
vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: (url: string, init?: RequestInit) => {
    wire.calls.push(url);
    return wire.fetch(new Request(url, init));
  },
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    (_req: NextRequest, headers: Headers) => {
      headers.append('Set-Cookie', 'anonymous_id=foreign; Path=/; HttpOnly');
      return 'owner-b';
    },
  ),
);

import { getRenderServiceCapability } from '@/lib/server/render-service';
import { POST } from '@/app/api/export-video/render/route';
import { DELETE as CANCEL, GET as POLL } from '@/app/api/export-video/render/[jobId]/route';
import { GET as DOWNLOAD } from '@/app/api/export-video/render/[jobId]/download/route';

const root = resolve(__dirname, '../..');
const parent = '6a84dbeb453fde53defa49a50f63470cabd4ea88';
let hasParent = false;
try {
  execFileSync('git', ['cat-file', '-e', `${parent}:render-service/src/main.ts`], {
    cwd: root,
    stdio: 'ignore',
  });
  hasParent = true;
} catch {
  // The root CI check uses fetch-depth: 0. Source archives and shallow clones
  // can still run the other owner-binding tests without this historical test.
}

// Load both real Hono apps, coordinators, and production stores, as in the
// mixed-pool reproduction. Only rendering/extraction are stubbed. The dynamic
// module boundary keeps the standalone service out of the app's TS build.
interface ServiceModules {
  createApp: (deps: Record<string, unknown>) => { fetch: (req: Request) => Promise<Response> };
  RenderCoordinator: new (...args: unknown[]) => unknown;
  InMemoryJobStore: new (ttl: number) => JobStore;
  LocalDiskArtifactStore: new () => ArtifactStore;
  Semaphore: new (capacity: number) => unknown;
}

async function loadService(source: string): Promise<ServiceModules> {
  const modules = await Promise.all(
    ['main', 'render-coordinator', 'job-store', 'artifact-store', 'semaphore'].map(
      (name) => import(/* @vite-ignore */ join(source, `${name}.ts`)),
    ),
  );
  return Object.assign({}, ...modules) as ServiceModules;
}

const scratch: string[] = [];
let current: ServiceModules;
let legacy: ServiceModules;

function submission(url: string): Request {
  const form = new FormData();
  form.set('project', new Blob(['fixture ZIP']), 'project.zip');
  return new Request(url, {
    method: 'POST',
    body: form,
    headers: { 'x-openmaic-client': 'client-a', 'x-openmaic-render-owner': 'owner-a' },
  });
}

async function fixture(service: ServiceModules) {
  const jobs = new service.InMemoryJobStore(60_000);
  const artifacts = new service.LocalDiskArtifactStore();
  const coordinator = new service.RenderCoordinator({ execute: vi.fn() }, jobs, artifacts, {
    maxConcurrency: 0,
    onEvent: () => {},
  });
  const app = service.createApp({
    jobs,
    artifacts,
    coordinator,
    extractionGate: new service.Semaphore(1),
    unzipProject: async () => {},
    hardenProject: async () => {},
    makeProjectDir: async () => {
      const path = await mkdtemp(join(tmpdir(), 'render-mixed-project-'));
      scratch.push(path);
      return path;
    },
    onEvent: () => {},
  });
  return { app, jobs, artifacts };
}

function request(jobId: string, method = 'GET') {
  return new NextRequest(`http://app.test/api/export-video/render/${jobId}`, { method });
}
const context = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

// Do not skip import/setup failures when history exists: those are regressions.
describe.skipIf(!hasParent)('render jobs in a real mixed-version pool', () => {
  beforeAll(async () => {
    vi.stubEnv('RENDER_SERVICE_NO_LISTEN', 'true');
    // Keep the extracted files next to the service's dependencies, never in the
    // source tree, so its normal module resolution works on every platform.
    const extracted = await mkdtemp(join(root, 'render-service/.owner-bound-parent-'));
    scratch.push(extracted);
    const paths = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', parent, 'render-service/src'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n');
    await writeFile(join(extracted, 'package.json'), '{"type":"module"}');
    for (const path of paths) {
      const target = join(extracted, path.replace('render-service/', ''));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, execFileSync('git', ['show', `${parent}:${path}`], { cwd: root }));
    }
    current = await loadService(join(root, 'render-service/src'));
    legacy = await loadService(join(extracted, 'src'));
  });

  beforeEach(() => {
    wire.calls = [];
    vi.stubEnv('RENDER_SERVICE_URL', 'http://pool.test');
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('refuses old-instance job requests without cancelling, submitting, or exposing a job', async () => {
    const patched = await fixture(current);
    const old = await fixture(legacy);
    // Seed through the actual legacy wire contract, proving it can still create
    // a queued job. No owner header is needed by that service.
    const seeded = await old.app.fetch(submission('http://pool.test/render'));
    expect(seeded.status).toBe(202);
    const { jobId } = await seeded.json();
    const snapshot = await old.jobs.list();
    const create = vi.spyOn(old.jobs, 'create');
    const get = vi.spyOn(old.jobs, 'get');
    const locate = vi.spyOn(old.artifacts, 'locate');
    wire.fetch.mockImplementation((req) => {
      const path = new URL(req.url).pathname;
      return path === '/health' || path.endsWith('/patched-job')
        ? patched.app.fetch(req)
        : old.app.fetch(req);
    });

    expect(await getRenderServiceCapability()).toEqual({ enabled: true, accepting: true });
    // Some job requests also reach an upgraded instance in this pool.
    expect((await POLL(request('patched-job'), context('patched-job'))).status).toBe(404);
    wire.calls = [];
    const responses = [
      await CANCEL(request(jobId, 'DELETE'), context(jobId)),
      await POST(new NextRequest(submission('http://app.test/api/export-video/render'))),
      await POLL(request(jobId), context(jobId)),
    ];
    expect((await old.jobs.list())[0].status).toBe('queued');
    expect(await old.jobs.list()).toEqual(snapshot);
    // A ready job would cause the parent's legacy download handler to look up
    // an artifact; the new namespace must prevent even that lookup.
    await old.jobs.update(jobId, { status: 'succeeded' });
    responses.push(await DOWNLOAD(request(jobId), context(jobId)));
    await old.jobs.update(jobId, { status: 'queued' });
    for (const response of responses) {
      expect(response.status).toBe(502);
      expect(response.headers.getSetCookie()).toEqual(['anonymous_id=foreign; Path=/; HttpOnly']);
      expect(response.headers.get('location')).toBeNull();
      const body = await response.text();
      expect(body).not.toContain(jobId);
      expect(body).not.toContain('succeeded');
      expect(body).not.toContain('cancelled');
    }
    expect(wire.calls).toHaveLength(4);
    for (const url of wire.calls) expect(new URL(url).pathname).toMatch(/^\/owner-bound\/render/);
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    // No cancellation or extra job survived the pool requests.
    expect((await old.jobs.list()).map(({ updatedAtMs: _updated, ...job }) => job)).toEqual(
      snapshot.map(({ updatedAtMs: _updated, ...job }) => job),
    );
  });
});
