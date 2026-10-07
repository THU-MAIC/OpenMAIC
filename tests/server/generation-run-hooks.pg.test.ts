/**
 * The generation run hooks on PostgreSQL: a host's admission of a start (on
 * both start routes), its execution context around every claimed execution
 * (takeover included) and around a material's background extraction, its
 * classification of its own failures, and its run notifications. The step
 * services are fakes; the routes, the run store, its leases, the owner-bound
 * document store and the material extraction are real.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { stopAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import {
  configureGenerationRunHooks,
  type GenerationExecutionContext,
  type GenerationRunHookEvent,
  type GenerationRunHooks,
  type GenerationStartContext,
} from '@/lib/server/generation-run-hooks';
import { resetGenerationRunHooksForTests } from '@/lib/server/generation-run-hooks/registry';
import { executeGenerationRun } from '@/lib/server/generation/run/engine';
import { defaultRunStepServices, type RunStepServices } from '@/lib/server/generation/run/services';
import {
  claimNextGenerationRun,
  confirmGenerationRunOutline,
  createGenerationRun,
  readGenerationRun,
  readGenerationRunEvents,
  resetGenerationRunSchemaForTests,
  retryGenerationRun,
} from '@/lib/server/generation/run/store';
import type { GenerationRunInput } from '@/lib/server/generation/run/types';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { runNextOwnerMaterialExtraction } from '@/lib/server/materials/extraction';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import type { SceneOutline } from '@/lib/types/generation';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { Scene } from '@/lib/types/stage';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_generation_run_hooks_test';
const OWNER_COOKIE = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';
const OWNER = `anon:${OWNER_COOKIE}`;

const OUTLINES: SceneOutline[] = [
  { id: 'o1', type: 'slide', title: 'Intro', description: 'Why', keyPoints: ['a'], order: 1 },
  { id: 'o2', type: 'slide', title: 'Body', description: 'How', keyPoints: ['b'], order: 2 },
  { id: 'o3', type: 'slide', title: 'End', description: 'Recap', keyPoints: ['c'], order: 3 },
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

/** A host's own error, thrown inside the work it wraps (a used-up quota, say). */
class QuotaError extends Error {
  constructor() {
    super('The quota is used up');
    this.name = 'QuotaError';
  }
}

/** The host's execution context, as a host would keep it. */
const scope = new AsyncLocalStorage<GenerationExecutionContext>();

function fakeServices(overrides: Partial<RunStepServices> = {}) {
  /** The run each step call saw in the host's context, by step. */
  const seen: Array<{ step: string; context: GenerationExecutionContext | undefined }> = [];
  const services: RunStepServices = {
    materialKinds: async (_owner, materialIds) => materialIds.map(() => 'document' as const),
    materialsReady: async () => true,
    analyzeMaterials: async () => ({ text: 'material text', images: [] }),
    research: async () => {
      seen.push({ step: 'research', context: scope.getStore() });
      return null;
    },
    outline: async () => {
      seen.push({ step: 'outline', context: scope.getStore() });
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
    sceneContent: async (_owner, input) => {
      seen.push({ step: `content:${input.outline.id}`, context: scope.getStore() });
      return {
        content: { elements: [], remark: input.outline.title } as never,
        effectiveOutline: input.outline,
      };
    },
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
  return { services, seen };
}

function runInput(overrides: Partial<GenerationRunInput> = {}): GenerationRunInput {
  return {
    requirement: 'Teach photosynthesis',
    materialIds: [],
    interactive: false,
    taskEngine: false,
    agents: { mode: 'auto' },
    outlineReview: 'auto',
    ...overrides,
  };
}

async function drive(runId: string, services: RunStepServices, workerId = 'worker-a') {
  const claimed = await claimNextGenerationRun(workerId, {
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
  legacy: false,
  notices: [],
};

describe.skipIf(!contractUrl)('generation run hooks on PostgreSQL', () => {
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
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=generation-run-hooks`;
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
      deletePrefix: async (prefix: string) => {
        for (const key of [...bytes.keys()]) if (key.startsWith(prefix)) bytes.delete(key);
      },
      list: async () => [],
    });
  });

  beforeEach(() => {
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '50';
    setDeploymentConfigForTests(MODEL_CONFIG);
    resetGenerationRunHooksForTests();
  });

  afterEach(() => {
    resetGenerationRunHooksForTests();
    vi.restoreAllMocks();
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

  /** Register `hooks` with an execution scope a host would establish. */
  function host(hooks: Omit<GenerationRunHooks, 'name'>) {
    const executions: GenerationExecutionContext[] = [];
    configureGenerationRunHooks({
      name: 'test-host',
      wrapExecution: (context, execute) => {
        executions.push(context);
        return scope.run(context, execute);
      },
      ...hooks,
    });
    return { executions };
  }

  async function post(path: '/api/generation-runs' | '/api/generate-classroom', body: unknown) {
    const route =
      path === '/api/generation-runs'
        ? await import('@/app/api/generation-runs/route')
        : await import('@/app/api/generate-classroom/route');
    return route.POST(
      new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { ...cookie(OWNER_COOKIE), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function runCount(): Promise<number> {
    const result = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM generation_runs WHERE owner_id = $1',
      [OWNER],
    );
    return Number(result.rows[0]!.n);
  }

  function documentStore(ownerId: string) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  it('changes nothing without hooks: no attributes, the same context-free execution', async () => {
    const response = await post('/api/generation-runs', { requirement: 'Plain' });
    expect(response.status).toBe(202);
    const { run } = (await response.json()) as { run: { id: string } };
    expect((await readGenerationRun(run.id, OWNER))!.hostAttributes).toBeNull();
    const { services, seen } = fakeServices();
    await pool.query(
      `UPDATE generation_runs SET input = input || '{"outlineReview":"auto"}' WHERE id = $1`,
      [run.id],
    );
    expect(await drive(run.id, services)).toBe('completed');
    expect(seen.every(({ context }) => context === undefined)).toBe(true);
  });

  it('admits a start once, after the built-in checks, on both start routes', async () => {
    const calls: GenerationStartContext[] = [];
    host({
      authorizeStart: async (context) => {
        calls.push(context);
        // The create transaction: what the host writes here commits with the run.
        await context.tx.query('SELECT 1');
        return { allow: true, attributes: { plan: 'gold-plan', origin: context.origin } };
      },
    });

    // A body the route refuses never reaches the host.
    expect((await post('/api/generation-runs', { requirement: '' })).status).toBe(400);
    expect((await post('/api/generate-classroom', {})).status).toBe(400);
    expect(calls).toHaveLength(0);

    const started = await post('/api/generation-runs', { requirement: 'Admitted' });
    expect(started.status).toBe(202);
    const { run } = (await started.json()) as { run: Record<string, unknown> & { id: string } };
    // The attributes are the host's, not part of the owner's snapshot.
    expect(JSON.stringify(run)).not.toContain('gold-plan');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: run.id,
      ownerId: OWNER,
      principal: { ownerId: OWNER },
      origin: 'generation-runs',
      input: { requirement: 'Admitted' },
    });
    expect(calls[0]!.request.headers.get('cookie')).toContain(OWNER_COOKIE);
    expect((await readGenerationRun(run.id, OWNER))!.hostAttributes).toEqual({
      plan: 'gold-plan',
      origin: 'generation-runs',
    });

    const job = await post('/api/generate-classroom', { requirement: 'Headless' });
    expect(job.status).toBe(202);
    const { jobId } = (await job.json()) as { jobId: string };
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ runId: jobId, origin: 'generate-classroom' });
    expect((await readGenerationRun(jobId, OWNER))!.hostAttributes).toEqual({
      plan: 'gold-plan',
      origin: 'generate-classroom',
    });

    // The owner's run limit refuses first: the host is not asked about it.
    const active = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM generation_runs
        WHERE owner_id = $1 AND state IN ('preparing', 'outlining', 'generating')`,
      [OWNER],
    );
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = active.rows[0]!.n;
    const limited = await post('/api/generation-runs', { requirement: 'Over the limit' });
    expect(limited.status).toBe(429);
    expect(calls).toHaveLength(2);
  });

  it("answers a refused start with the host's status, code and headers, and creates no run", async () => {
    const authorizeStart = vi.fn(async () => ({
      allow: false as const,
      status: 402,
      code: 'QUOTA_EXHAUSTED',
      message: 'No quota left',
      headers: { 'retry-after': '3600' },
    }));
    host({ authorizeStart });
    const before = await runCount();
    for (const path of ['/api/generation-runs', '/api/generate-classroom'] as const) {
      const refused = await post(path, { requirement: 'Refused' });
      expect(refused.status).toBe(402);
      expect(refused.headers.get('retry-after')).toBe('3600');
      expect(await refused.json()).toMatchObject({
        success: false,
        errorCode: 'QUOTA_EXHAUSTED',
        error: 'No quota left',
      });
    }
    expect(authorizeStart).toHaveBeenCalledTimes(2);
    expect(await runCount()).toBe(before);
  });

  it('hands the attributes to every execution, in its context, a takeover included', async () => {
    const { executions } = host({
      authorizeStart: async () => ({ allow: true, attributes: { tenant: 't-1' } }),
    });
    const started = await post('/api/generation-runs', {
      requirement: 'Taken over',
      outlineReview: 'auto',
    });
    const { run } = (await started.json()) as { run: { id: string } };

    // Worker A claims the run and dies before executing it.
    const first = await claimNextGenerationRun('worker-a', {
      leaseTtlMs: 60_000,
      maxTakeovers: 3,
      runId: run.id,
    });
    expect(first?.takeover).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Worker B takes the stale lease over and executes it, in the host's context.
    const second = await claimNextGenerationRun('worker-b', {
      leaseTtlMs: 1,
      maxTakeovers: 3,
      runId: run.id,
    });
    expect(second?.takeover).toBe(true);
    const { services, seen } = fakeServices();
    expect(
      await executeGenerationRun(second!, { services, signal: new AbortController().signal }),
    ).toBe('completed');

    expect(executions).toEqual([
      {
        kind: 'generation-run',
        runId: run.id,
        ownerId: OWNER,
        currentOwnerId: OWNER,
        attributes: { tenant: 't-1' },
        takeover: true,
      },
    ]);
    // Every step ran inside that context.
    expect(seen.map(({ step }) => step)).toEqual([
      'research',
      'outline',
      'content:o1',
      'content:o2',
      'content:o3',
    ]);
    expect(seen.every(({ context }) => context === executions[0])).toBe(true);
  });

  it('pauses at the step a host failure no retry helps, and Retry resumes it', async () => {
    const events: GenerationRunHookEvent[] = [];
    host({
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false, statusCode: 402 }
          : undefined,
      onRunEvent: (event) => void events.push(event),
    });
    let exhausted = true;
    const actionCalls: string[] = [];
    const { services } = fakeServices({
      sceneActions: async (_owner, input) => {
        actionCalls.push(input.outline.id);
        if (exhausted && input.outline.id === 'o2') throw new QuotaError();
        return {
          scene: slideScene(input.stageId, input.outline) as never,
          previousSpeeches: [],
        };
      },
    });
    const run = await createGenerationRun(OWNER, runInput(), {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });

    expect(await drive(run.id, services)).toBe('paused');
    // Not retried: the step's five automatic retries were skipped.
    expect(actionCalls).toEqual(['o1', 'o2']);
    const paused = (await readGenerationRun(run.id, OWNER))!;
    expect(paused).toMatchObject({
      state: 'paused',
      step: 'scene:1:actions',
      error: {
        step: 'scene:1:actions',
        message: 'The quota is used up',
        errorCode: 'QUOTA_EXHAUSTED',
        statusCode: 402,
      },
    });
    const log = await readGenerationRunEvents(run.id, 0);
    expect(log.some((event) => event.type === 'step_retry')).toBe(false);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: 'paused',
        runId: run.id,
        currentOwnerId: OWNER,
        step: 'scene:1:actions',
        errorCode: 'QUOTA_EXHAUSTED',
      }),
    );

    // The host's quota is back: the owner's Retry resumes the run at the step.
    exhausted = false;
    await retryGenerationRun(run.id, OWNER, { commandId: 'retry-quota' });
    expect(await drive(run.id, services)).toBe('completed');
    expect(actionCalls).toEqual(['o1', 'o2', 'o2', 'o3']);
  });

  it('pauses a run whose execution the host refuses, and Retry resumes it', async () => {
    let refuse = true;
    const events: GenerationRunHookEvent[] = [];
    configureGenerationRunHooks({
      name: 'refusing-host',
      wrapExecution: async (context, execute) => {
        if (refuse) throw new QuotaError();
        return scope.run(context, execute);
      },
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
          : undefined,
      onRunEvent: (event) => void events.push(event),
    });
    const { services, seen } = fakeServices();
    const run = await createGenerationRun(OWNER, runInput(), {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });

    expect(await drive(run.id, services)).toBe('paused');
    expect(seen).toEqual([]);
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
      state: 'paused',
      leaseWorkerId: null,
      error: { step: null, errorCode: 'QUOTA_EXHAUSTED', resumeState: 'preparing' },
    });
    await vi.waitFor(() =>
      expect(events.map((event) => event.type)).toEqual(['started', 'paused']),
    );

    refuse = false;
    await retryGenerationRun(run.id, OWNER, { commandId: 'retry-refused' });
    expect(await drive(run.id, services)).toBe('completed');
  });

  it('reports a run as it progresses, and a throwing listener changes nothing', async () => {
    const events: GenerationRunHookEvent[] = [];
    host({
      authorizeStart: async () => ({ allow: true, attributes: { tenant: 't-2' } }),
      onRunEvent: (event) => {
        events.push(event);
        throw new Error('a listener bug');
      },
    });
    const started = await post('/api/generation-runs', { requirement: 'Reported' });
    const { run } = (await started.json()) as { run: { id: string } };
    const { services } = fakeServices();

    expect(await drive(run.id, services)).toBe('waiting');
    await confirmGenerationRunOutline(
      run.id,
      OWNER,
      { commandId: 'confirm', outlineRevision: 1 },
      { maxActiveRunsPerOwner: 50 },
    );
    expect(await drive(run.id, services)).toBe('completed');

    const stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored).toMatchObject({ state: 'completed', progress: { scenesCompleted: 3 } });
    const base = {
      runId: run.id,
      ownerId: OWNER,
      currentOwnerId: OWNER,
      attributes: { tenant: 't-2' },
    };
    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events).toEqual([
      { ...base, type: 'started' },
      { ...base, type: 'outline-ready', scenesTotal: 3 },
      ...[0, 1, 2].map((index) => ({
        ...base,
        type: 'scene-appended',
        stageId: stored.stageId,
        sceneIndex: index,
        sceneId: `scene-${OUTLINES[index]!.id}`,
        scenesCompleted: index + 1,
        scenesTotal: 3,
      })),
      { ...base, type: 'completed', stageId: stored.stageId },
    ]);
  });

  it('reports a run its course deletion ended', async () => {
    const events: GenerationRunHookEvent[] = [];
    host({
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
          : undefined,
      onRunEvent: async (event) => {
        events.push(event);
      },
    });
    const { services } = fakeServices({
      sceneContent: async (_owner, input) => {
        if (input.outline.id === 'o2') throw new QuotaError();
        return { content: { elements: [] } as never, effectiveOutline: input.outline };
      },
    });
    const run = await createGenerationRun(OWNER, runInput(), {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });
    expect(await drive(run.id, services)).toBe('paused');
    const { stageId } = (await readGenerationRun(run.id, OWNER))!;
    await documentStore(OWNER).deleteDocument(stageId!);
    await vi.waitFor(() =>
      expect(events.at(-1)).toEqual({
        type: 'ended',
        runId: run.id,
        ownerId: OWNER,
        currentOwnerId: OWNER,
        attributes: {},
        stageId,
      }),
    );
  });

  it('attributes a run claimed into an account to that account', async () => {
    const anonymous = 'anon:9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
    const account = 'account:claimed-owner';
    const events: GenerationRunHookEvent[] = [];
    const { executions } = host({ onRunEvent: (event) => void events.push(event) });
    const run = await createGenerationRun(anonymous, runInput(), {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // The anonymous owner signs in: its work is claimed into the account.
    await pool.query('INSERT INTO owner_merges (from_owner_id, to_owner_id) VALUES ($1, $2)', [
      anonymous,
      account,
    ]);
    const { services } = fakeServices();
    expect(await drive(run.id, services)).toBe('completed');

    expect(executions).toEqual([
      expect.objectContaining({ runId: run.id, ownerId: anonymous, currentOwnerId: account }),
    ]);
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('completed'));
    expect(
      events.map(({ type, ownerId, currentOwnerId }) => [type, ownerId, currentOwnerId]),
    ).toEqual([
      ['started', anonymous, anonymous],
      ['outline-ready', anonymous, account],
      ['scene-appended', anonymous, account],
      ['scene-appended', anonymous, account],
      ['scene-appended', anonymous, account],
      ['completed', anonymous, account],
    ]);
  });

  it("runs a material's background extraction in the host's context, or fails it", async () => {
    const { executions } = host({
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
          : undefined,
    });
    const { POST } = await import('@/app/api/materials/route');
    const upload = async (text: string) => {
      const response = await POST(
        new NextRequest('http://localhost/api/materials', {
          method: 'POST',
          headers: {
            ...cookie(OWNER_COOKIE),
            'content-type': 'text/markdown',
            'x-material-filename': `${text}.md`,
          },
          body: text,
        }),
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { materialId: string }).materialId;
    };
    const inScope: Array<GenerationExecutionContext | undefined> = [];
    let analyze = async (): Promise<ParsedPdfContent> => {
      inScope.push(scope.getStore());
      return { text: 'extracted', images: [], metadata: { pageCount: 1 } } as ParsedPdfContent;
    };
    const extractNext = () =>
      runNextOwnerMaterialExtraction('extractor', {
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 1000,
        perOwnerLimit: 10,
        services: async () => ({ document: null, documentStatus: 'unassigned' }),
        analyze: () => analyze(),
      });
    const extraction = async (materialId: string) => {
      const row = await pool.query<{ extraction: Record<string, unknown> }>(
        'SELECT extraction FROM owner_material WHERE id = $1',
        [materialId],
      );
      return row.rows[0]!.extraction;
    };

    const ready = await upload('ready');
    expect(await extractNext()).toBe(true);
    expect(await extraction(ready)).toMatchObject({ status: 'ready' });
    expect(executions).toEqual([
      {
        kind: 'material-extraction',
        materialId: ready,
        ownerId: OWNER,
        currentOwnerId: OWNER,
      },
    ]);
    expect(inScope).toEqual([executions[0]]);

    // A host failure inside the extraction fails it with the host's code.
    analyze = async () => {
      throw new QuotaError();
    };
    const failed = await upload('failed');
    expect(await extractNext()).toBe(true);
    expect(await extraction(failed)).toMatchObject({
      status: 'failed',
      errorCode: 'QUOTA_EXHAUSTED',
      retryable: false,
    });
  });
});
