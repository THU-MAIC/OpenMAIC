/**
 * The headless classroom API on PostgreSQL: `POST /api/generate-classroom`
 * starts a generation run with the outline confirmed automatically, and its
 * poll reads that run. The run's step services are fakes; the material
 * upload, the run store, its leases, the owner-bound document store and the
 * routes are real.
 */
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { stopAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import { executeGenerationRun } from '@/lib/server/generation/run/engine';
import { defaultRunStepServices, type RunStepServices } from '@/lib/server/generation/run/services';
import {
  claimNextGenerationRun,
  readGenerationRun,
  resetGenerationRunSchemaForTests,
} from '@/lib/server/generation/run/store';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_generate_classroom_api_test';
const OWNER_COOKIE = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const OTHER_COOKIE = '8c7b6a5d-4e3f-4b2a-8d9c-8f7e6d5c4b3a';
const OWNER = `anon:${OWNER_COOKIE}`;

const OUTLINES: SceneOutline[] = [
  { id: 'o1', type: 'slide', title: 'Intro', description: 'Why', keyPoints: ['a'], order: 1 },
  { id: 'o2', type: 'slide', title: 'Body', description: 'How', keyPoints: ['b'], order: 2 },
];

function slideScene(stageId: string, outline: SceneOutline): Scene {
  return {
    id: `scene-${outline.id}`,
    stageId,
    type: 'slide',
    title: outline.title,
    order: outline.order,
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${outline.id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [{ id: `speech-${outline.id}`, type: 'speech', text: `Say ${outline.title}` }],
  } as Scene;
}

/** Step fakes; `analyzed` records the materials the run analyzed. */
function fakeServices(overrides: Partial<RunStepServices> = {}) {
  const analyzed: string[][] = [];
  const outlineRequirements: unknown[] = [];
  const services: RunStepServices = {
    analyzeMaterials: async (_owner, materialIds) => {
      analyzed.push([...materialIds]);
      return { text: 'material text', images: [] };
    },
    research: async () => null,
    outline: async (_owner, input) => {
      outlineRequirements.push(input.requirements);
      return {
        outlines: OUTLINES,
        languageDirective: 'Use English.',
        courseTitle: 'Plants',
        taskEngineMode: false,
      };
    },
    agentProfiles: async () => [
      {
        id: 'gen-teacher',
        name: 'Ada',
        role: 'teacher',
        persona: 'Patient.',
        avatar: '/avatars/teacher.png',
        color: '#3b82f6',
        priority: 10,
      },
      {
        id: 'gen-student',
        name: 'Bo',
        role: 'student',
        persona: 'Curious.',
        avatar: '/avatars/curious.png',
        color: '#10b981',
        priority: 5,
      },
    ],
    presetAgents: defaultRunStepServices.presetAgents,
    sceneContent: async (_owner, input) => ({
      content: { elements: [], remark: input.outline.title } as never,
      effectiveOutline: input.outline,
    }),
    sceneActions: async (_owner, input) => ({
      scene: slideScene(input.stageId, input.outline) as never,
      previousSpeeches: [`Say ${input.outline.title}`],
    }),
    narrationTarget: async () => null,
    narrateClip: async () => null,
    releaseAssets: defaultRunStepServices.releaseAssets,
    mediaConnections: async () => ({ image: { status: 'off' }, video: { status: 'off' } }),
    generateImage: async () => {
      throw new Error('no image slot in this test');
    },
    generateVideo: async () => {
      throw new Error('no video slot in this test');
    },
    parallelSceneConcurrency: () => 0,
    sleep: async () => undefined,
    ...overrides,
  };
  return { services, analyzed, outlineRequirements };
}

async function drive(runId: string, services: RunStepServices) {
  const claimed = await claimNextGenerationRun('worker-a', {
    leaseTtlMs: 60_000,
    maxTakeovers: 3,
    runId,
  });
  if (!claimed) return null;
  return executeGenerationRun(claimed, { services, signal: new AbortController().signal });
}

function cookie(value: string) {
  return { cookie: `anonymous_id=${value}` };
}

const MODEL_CONFIG = {
  layer: {
    source: 'deployment' as const,
    config: {
      providers: { main: { preset: 'openai', apiKey: 'test-key' } },
      slots: { llm: 'main:gpt-4o-mini' },
    },
  },
  defaults: null,
  notices: [],
};

describe.skipIf(!contractUrl)('the headless classroom API on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  const bytes = new Map<string, Buffer>();
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
    OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER: process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=generate-classroom-api`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    resetGenerationRunSchemaForTests();
    await getServerPersistenceProvider(databaseUrl, () => pool);
    setMaterialByteStoreForTests({
      put: async (key, body) => {
        bytes.set(key, Buffer.from(await new Response(body as BodyInit).arrayBuffer()));
      },
      get: async (key) => bytes.get(key)!,
      delete: async (key) => void bytes.delete(key),
    });
  });

  beforeEach(() => {
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '50';
    setDeploymentConfigForTests(MODEL_CONFIG);
  });

  afterAll(async () => {
    await stopAgentEventNotifyBus();
    setDeploymentConfigForTests();
    setMaterialByteStoreForTests(null);
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetGenerationRunSchemaForTests();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function upload(ownerCookie: string, text: string): Promise<string> {
    const { POST } = await import('@/app/api/materials/route');
    const response = await POST(
      new NextRequest('http://localhost/api/materials', {
        method: 'POST',
        headers: {
          ...cookie(ownerCookie),
          'content-type': 'text/markdown',
          'x-material-filename': 'notes.md',
        },
        body: text,
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { materialId: string }).materialId;
  }

  async function submit(ownerCookie: string, body: unknown) {
    const { POST } = await import('@/app/api/generate-classroom/route');
    return POST(
      new NextRequest('http://localhost/api/generate-classroom', {
        method: 'POST',
        headers: { ...cookie(ownerCookie), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function poll(ownerCookie: string, jobId: string) {
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    const response = await GET(
      new NextRequest(`http://localhost/api/generate-classroom/${jobId}`, {
        headers: cookie(ownerCookie),
      }),
      { params: Promise.resolve({ jobId }) },
    );
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  }

  it('generates a course from an uploaded material through a run with outlineReview auto', async () => {
    const materialId = await upload(OWNER_COOKIE, '# Photosynthesis\n\nLight to sugar.');

    const submitted = await submit(OWNER_COOKIE, {
      requirement: 'Teach photosynthesis from my notes',
      materialIds: [materialId],
    });
    expect(submitted.status).toBe(202);
    const job = await submitted.json();
    expect(job).toMatchObject({ status: 'queued', done: false });
    expect(job.jobId).toBe(job.runId);

    const run = (await readGenerationRun(job.runId, OWNER))!;
    expect(run.input).toEqual({
      requirement: 'Teach photosynthesis from my notes',
      materialIds: [materialId],
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'auto',
    });

    // The outline confirms itself: one execution runs the run to the end.
    const { services, analyzed, outlineRequirements } = fakeServices();
    expect(await drive(job.runId, services)).toBe('completed');
    expect(analyzed).toEqual([[materialId]]);
    expect(outlineRequirements).toEqual([{ requirement: 'Teach photosynthesis from my notes' }]);

    const done = await poll(OWNER_COOKIE, job.jobId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      scenesGenerated: 2,
      totalScenes: 2,
      done: true,
      result: { scenesCount: 2 },
    });
    const { classroomId, url } = done.body.result;
    expect(url).toBe(`http://localhost/classroom/${classroomId}`);

    // The course is complete in the owner's library, taught by the generated agents.
    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId: OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    expect((await store.listDocuments()).map((doc) => doc.id)).toContain(classroomId);
    const document = (await store.loadDocument(classroomId))!;
    expect(document.stage.name).toBe('Plants');
    expect(document.stage.generatedAgentConfigs?.map((agent) => agent.id)).toEqual([
      'gen-teacher',
      'gen-student',
    ]);
    expect(document.scenes.map((scene) => scene.title)).toEqual(['Intro', 'Body']);
    expect(document.outline).toMatchObject({ generationComplete: true });

    // Another owner polls the same 404 as an unknown job.
    expect((await poll(OTHER_COOKIE, job.jobId)).status).toBe(404);
    expect((await poll(OWNER_COOKIE, 'run-BBBBBBBBBBBBBBBB')).status).toBe(404);
  });

  it('reports a paused run as failed with its run id, and running again after a Retry', async () => {
    let failScene = true;
    const base = fakeServices();
    const { services } = fakeServices({
      sceneActions: async (owner, input, ctx) => {
        if (failScene && input.outline.id === 'o2') {
          throw Object.assign(new Error('bad request'), { statusCode: 400 });
        }
        return base.services.sceneActions(owner, input, ctx);
      },
    });
    const job = await (await submit(OWNER_COOKIE, { requirement: 'Teach' })).json();
    expect(await drive(job.runId, services)).toBe('paused');

    const paused = await poll(OWNER_COOKIE, job.jobId);
    expect(paused.body).toMatchObject({
      runId: job.runId,
      status: 'failed',
      step: 'failed',
      scenesGenerated: 1,
      totalScenes: 2,
      done: true,
    });
    expect(paused.body.error).toMatch(/^scene:1:actions: /);

    const retry = await import('@/app/api/generation-runs/[id]/retry/route');
    const retried = await retry.POST(
      new NextRequest(`http://localhost/api/generation-runs/${job.runId}/retry`, {
        method: 'POST',
        headers: { ...cookie(OWNER_COOKIE), 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: 'retry-1' }),
      }),
      { params: Promise.resolve({ id: job.runId }) },
    );
    expect(retried.status).toBe(200);
    expect((await poll(OWNER_COOKIE, job.jobId)).body).toMatchObject({
      status: 'running',
      step: 'generating_scenes',
      done: false,
    });

    failScene = false;
    expect(await drive(job.runId, services)).toBe('completed');
    expect((await poll(OWNER_COOKIE, job.jobId)).body).toMatchObject({
      status: 'succeeded',
      result: { scenesCount: 2 },
    });
  });

  it('answers 429 ACTIVE_RUN_LIMIT beyond the per-owner limit on active runs', async () => {
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '1';
    const limited = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';

    expect((await submit(limited, { requirement: 'One' })).status).toBe(202);
    const refused = await submit(limited, { requirement: 'Two' });

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ success: false, errorCode: 'ACTIVE_RUN_LIMIT' });
  });

  it('refuses a submission without a configured model, creating no run', async () => {
    setDeploymentConfigForTests({ layer: null, defaults: null, notices: [] });
    const lonely = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b';

    const refused = await submit(lonely, { requirement: 'Teach' });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ errorCode: 'MISSING_MODEL' });
    const runs = await pool.query('SELECT 1 FROM generation_runs WHERE owner_id = $1', [
      `anon:${lonely}`,
    ]);
    expect(runs.rows).toEqual([]);
  });
});
