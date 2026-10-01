/**
 * Server-side generation runs on PostgreSQL: the engine with its step
 * services replaced by fakes (so every step's input can be checked against
 * what the browser sends its route), and everything else real: the run store,
 * its leases and event log, the owner-bound document store, the asset pool
 * and the run API routes.
 */
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { stopAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import { appendRunScene } from '@/lib/server/generation/run/document';
import { executeGenerationRun } from '@/lib/server/generation/run/engine';
import type { RunStepServices } from '@/lib/server/generation/run/services';
import {
  claimNextGenerationRun,
  commitGenerationRun,
  confirmGenerationRunOutline,
  createGenerationRun,
  GenerationRunLeaseLostError,
  readGenerationRun,
  readGenerationRunEvents,
  readGenerationRunSteps,
  resetGenerationRunSchemaForTests,
  retryGenerationRun,
  RunCommandConflictError,
  type ClaimedRun,
} from '@/lib/server/generation/run/store';
import type { GenerationRunInput } from '@/lib/server/generation/run/types';
import type { MediaConnection } from '@/lib/server/model-config/media';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_generation_runs_test';
const OWNER_COOKIE = '4a1f2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_COOKIE = '7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const OWNER = `anon:${OWNER_COOKIE}`;
const OTHER = `anon:${OTHER_COOKIE}`;
const CLIP = new Uint8Array([1, 2, 3, 4]);

const OUTLINES: SceneOutline[] = [
  { id: 'o1', type: 'slide', title: 'Intro', description: 'Why', keyPoints: ['a'], order: 1 },
  { id: 'o2', type: 'slide', title: 'Body', description: 'How', keyPoints: ['b'], order: 2 },
  { id: 'o3', type: 'slide', title: 'End', description: 'Recap', keyPoints: ['c'], order: 3 },
];

const GENERATED_AGENTS = [
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

type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** Step fakes that record what each step received. */
function fakeServices(overrides: Partial<RunStepServices> = {}) {
  const calls = {
    research: [] as unknown[],
    outline: [] as unknown[],
    agentProfiles: [] as unknown[],
    sceneContent: [] as Array<{ outline: SceneOutline } & Record<string, unknown>>,
    sceneActions: [] as Array<Record<string, unknown>>,
    narrateClip: [] as Array<Record<string, unknown>>,
  };
  const services: RunStepServices = {
    analyzeMaterials: async () => 'material text',
    research: async (_owner, input) => {
      calls.research.push(input);
      return {
        answer: '',
        sources: [{ title: 'Source', url: 'https://example.com/a', content: '', score: 1 }],
        context: 'research context',
        query: input.query,
        responseTime: 1,
      };
    },
    outline: async (_owner, input, ctx) => {
      calls.outline.push(input);
      ctx.emit?.({ type: 'languageDirective', data: 'Use English.' });
      ctx.emit?.({ type: 'courseTitle', data: 'Plants' });
      ctx.emit?.({ type: 'outline', data: OUTLINES[0]!, index: 0 });
      ctx.emit?.({ type: 'retry', attempt: 1, maxAttempts: 3 });
      OUTLINES.forEach((outline, index) => ctx.emit?.({ type: 'outline', data: outline, index }));
      return {
        outlines: OUTLINES,
        languageDirective: 'Use English.',
        courseTitle: 'Plants',
        taskEngineMode: false,
      };
    },
    agentProfiles: async (_owner, input) => {
      calls.agentProfiles.push(input);
      return GENERATED_AGENTS;
    },
    presetAgents: async (_owner, ids) =>
      ids.map((id) => ({ id, name: `Agent ${id}`, role: 'teacher', persona: 'Built in.' })),
    sceneContent: async (_owner, input) => {
      calls.sceneContent.push(input as never);
      return {
        content: { elements: [], remark: input.outline.title } as never,
        effectiveOutline: { ...input.outline, description: `${input.outline.description}!` },
      };
    },
    sceneActions: async (_owner, input) => {
      calls.sceneActions.push(input as never);
      const scene = slideScene(input.stageId, input.outline);
      return { scene: scene as never, previousSpeeches: [`Say ${input.outline.title}`] };
    },
    narrationTarget: async () => ({
      connection: {
        providerId: 'openai-tts',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      } as MediaConnection,
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
    }),
    narrateClip: async (ownerId, input) => {
      calls.narrateClip.push(input as never);
      const stored = await storeGeneratedAsset({
        ownerId,
        stageId: input.stageId,
        bytes: CLIP,
        mimeType: 'audio/mp3',
        kind: 'audio',
      });
      return stored.status === 'stored' ? stored.assetId : null;
    },
    parallelSceneConcurrency: () => 0,
    sleep: async () => undefined,
    ...overrides,
  };
  return { services, calls };
}

function runInput(overrides: Partial<GenerationRunInput> = {}): GenerationRunInput {
  return {
    requirement: 'Teach photosynthesis',
    materialIds: [],
    interactive: false,
    taskEngine: false,
    agents: { mode: 'auto' },
    learnerProfile: { nickname: 'Sam', bio: 'Grade 8' },
    outlineReview: 'wait',
    ...overrides,
  };
}

async function claim(runId: string, workerId = 'worker-a', leaseTtlMs = 60_000) {
  return claimNextGenerationRun(workerId, { leaseTtlMs, maxTakeovers: 3, runId });
}

async function drive(runId: string, services: RunStepServices, workerId = 'worker-a') {
  const claimed = await claim(runId, workerId);
  if (!claimed) return null;
  return executeGenerationRun(claimed, { services, signal: new AbortController().signal });
}

function cookie(value: string) {
  return { cookie: `anonymous_id=${value}` };
}

describe.skipIf(!contractUrl)('generation runs on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
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
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=generation-runs`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    resetGenerationRunSchemaForTests();
    await getServerPersistenceProvider(databaseUrl, () => pool);
  });

  beforeEach(() => {
    // Every test starts within the default limit; one test lowers it.
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '50';
  });

  afterAll(async () => {
    await stopAgentEventNotifyBus();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetGenerationRunSchemaForTests();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  function documentStore(ownerId: string) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  async function start(input = runInput(), ownerId = OWNER) {
    return createGenerationRun(ownerId, input, { maxActiveRunsPerOwner: 50 });
  }

  async function eventTypes(runId: string) {
    return (await readGenerationRunEvents(runId, 0)).map((event) => event.type);
  }

  it('produces the course the browser flow would, step by step, with the same context', async () => {
    const { services, calls } = fakeServices();
    const run = await start();

    // Preparation: research, then the outline, which waits holding no worker.
    expect(await drive(run.id, services)).toBe('waiting');
    let stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored.state).toBe('awaiting_outline_confirmation');
    expect(stored.leaseWorkerId).toBeNull();
    expect(stored.outline).toMatchObject({
      revision: 1,
      outlines: OUTLINES,
      courseTitle: 'Plants',
    });
    expect(await claim(run.id)).toBeNull();

    // The outline step got the browser's requirements, with the research decision.
    expect(calls.research).toEqual([{ query: 'Teach photosynthesis' }]);
    expect(calls.outline).toEqual([
      {
        requirements: {
          requirement: 'Teach photosynthesis',
          userNickname: 'Sam',
          userBio: 'Grade 8',
          webSearch: true,
        },
        researchContext: 'research context',
      },
    ]);

    // Outline items streamed while the step ran, a retry reset them, and the
    // outline was ready only after them.
    const types = await eventTypes(run.id);
    expect(types).toEqual([
      'state',
      'step_started',
      'step_completed',
      'research_sources',
      'state',
      'step_started',
      'outline_language_directive',
      'outline_course_title',
      'outline_item',
      'outline_reset',
      'step_retry',
      'outline_item',
      'outline_item',
      'outline_item',
      'step_completed',
      'outline_ready',
      'state',
    ]);

    const confirmed = await confirmGenerationRunOutline(run.id, OWNER, {
      commandId: 'confirm-1',
      outlineRevision: 1,
    });
    expect(confirmed).toMatchObject({ state: 'generating', outlineRevision: 1 });

    expect(await drive(run.id, services)).toBe('completed');
    stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored).toMatchObject({
      state: 'completed',
      step: null,
      leaseWorkerId: null,
      progress: { scenesTotal: 3, scenesCompleted: 3 },
    });
    const stageId = stored.stageId!;
    expect(stageId).toMatch(/^stage-/);

    // Agents: generated from the course title and outlines, the slot's voices advertised.
    expect(calls.agentProfiles).toHaveLength(1);
    expect(calls.agentProfiles[0]).toMatchObject({
      stageInfo: { name: 'Plants', description: '' },
      sceneOutlines: OUTLINES.map((o) => ({ title: o.title, description: o.description })),
      languageDirective: 'Use English.',
    });
    const advertised = (calls.agentProfiles[0] as { availableVoices: unknown[] }).availableVoices;
    expect(advertised.length).toBeGreaterThan(0);
    expect(
      advertised.every((voice) => (voice as { providerId: string }).providerId === 'openai-tts'),
    ).toBe(true);

    // Content: in order; the first scene with the requirements, later ones without.
    const agents = GENERATED_AGENTS.map(({ id, name, role, persona }) => ({
      id,
      name,
      role,
      persona,
    }));
    expect(calls.sceneContent.map((call) => call.outline.id)).toEqual(['o1', 'o2', 'o3']);
    expect(calls.sceneContent[0]).toEqual({
      outline: OUTLINES[0],
      agents,
      languageDirective: 'Use English.',
      requirements: {
        requirement: 'Teach photosynthesis',
        userNickname: 'Sam',
        userBio: 'Grade 8',
        webSearch: true,
      },
    });
    expect(calls.sceneContent[1]).toEqual({
      outline: OUTLINES[1],
      agents,
      languageDirective: 'Use English.',
      requirements: undefined,
    });

    // Actions: the effective outline, every outline, the previous scene's speeches.
    expect(calls.sceneActions.map((call) => call.previousSpeeches)).toEqual([
      [],
      ['Say Intro'],
      ['Say Body'],
    ]);
    for (const [index, call] of calls.sceneActions.entries()) {
      expect(call).toMatchObject({
        outline: { ...OUTLINES[index], description: `${OUTLINES[index]!.description}!` },
        allOutlines: OUTLINES,
        content: { remark: OUTLINES[index]!.title },
        stageId,
        agents,
        userProfile: 'Student: Sam — Grade 8',
        languageDirective: 'Use English.',
      });
    }

    // Narration: one clip per speech, labelled as the browser labels it.
    expect(calls.narrateClip.map((call) => call.audioId)).toEqual([
      'tts_s1_speech-o1',
      'tts_s2_speech-o2',
      'tts_s3_speech-o3',
    ]);

    // The document: the stage the preview builds, scenes in order, owned by the run.
    const document = await documentStore(OWNER).loadDocument(stageId);
    expect(document!.stage).toMatchObject({
      id: stageId,
      name: 'Plants',
      description: '',
      style: 'professional',
      interactiveMode: false,
      taskEngineMode: false,
      languageDirective: 'Use English.',
      agentIds: ['gen-teacher', 'gen-student'],
      generatedAgentConfigs: GENERATED_AGENTS,
    });
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o2', 'scene-o3']);
    for (const scene of document!.scenes) {
      expect((scene.actions![0] as { audioId?: string }).audioId).toMatch(/^ast_/);
    }
    expect(document!.outline).toMatchObject({
      outlines: OUTLINES,
      generationComplete: true,
      producer: 'server-job',
      producerRef: run.id,
    });
    const meta = await pool.query(
      'SELECT owner_id, generation_complete FROM stage_meta WHERE stage_id = $1',
      [stageId],
    );
    expect(meta.rows).toEqual([{ owner_id: OWNER, generation_complete: true }]);

    // The course appeared with the first scene, and scenes followed in order.
    const tail = (await readGenerationRunEvents(run.id, confirmed!.seq)).filter((event) =>
      ['course_created', 'scene_ready', 'completed'].includes(event.type),
    );
    expect(tail.map((event) => [event.type, event.data.index ?? null])).toEqual([
      ['course_created', null],
      ['scene_ready', 0],
      ['scene_ready', 1],
      ['scene_ready', 2],
      ['completed', null],
    ]);
  });

  it('uses preset agents, confirms an edited outline, and confirms itself for headless callers', async () => {
    const { services, calls } = fakeServices({ research: async () => null });
    const run = await start(
      runInput({ agents: { mode: 'preset', agentIds: ['default-2'] }, outlineReview: 'auto' }),
    );
    expect(await drive(run.id, services)).toBe('requeued');
    expect((await readGenerationRun(run.id, OWNER))!.state).toBe('generating');
    expect(await drive(run.id, services)).toBe('completed');
    expect(calls.agentProfiles).toEqual([]);
    expect(calls.sceneContent[0]!.agents).toEqual([
      { id: 'default-2', name: 'Agent default-2', role: 'teacher', persona: 'Built in.' },
    ]);
    expect(
      (calls.outline[0] as { requirements: Record<string, unknown> }).requirements,
    ).not.toHaveProperty('webSearch');
    const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
    const document = await documentStore(OWNER).loadDocument(stageId);
    expect(document!.stage.agentIds).toEqual(['default-2']);
    expect(document!.stage).not.toHaveProperty('generatedAgentConfigs');

    // An edited outline is a new revision, and the run generates exactly it.
    const edited = await start();
    expect(await drive(edited.id, services)).toBe('waiting');
    await confirmGenerationRunOutline(edited.id, OWNER, {
      commandId: 'edit',
      outlineRevision: 1,
      outlines: [OUTLINES[2]!],
    });
    expect(await drive(edited.id, services)).toBe('completed');
    const after = (await readGenerationRun(edited.id, OWNER))!;
    expect(after.outline).toMatchObject({ revision: 2, outlines: [OUTLINES[2]] });
    expect(after.progress).toEqual({ scenesTotal: 1, scenesCompleted: 1 });
  });

  it('commands are idempotent by commandId and refused in the wrong state', async () => {
    const { services } = fakeServices();
    const run = await start();
    await expect(
      retryGenerationRun(run.id, OWNER, { commandId: 'early-retry' }),
    ).rejects.toBeInstanceOf(RunCommandConflictError);
    expect(await drive(run.id, services)).toBe('waiting');

    await expect(
      confirmGenerationRunOutline(run.id, OWNER, { commandId: 'stale', outlineRevision: 7 }),
    ).rejects.toMatchObject({ reason: 'outline-revision' });

    const first = await confirmGenerationRunOutline(run.id, OWNER, {
      commandId: 'same',
      outlineRevision: 1,
      outlines: OUTLINES.slice(0, 2),
    });
    const eventsAfterFirst = await readGenerationRunEvents(run.id, 0);
    const again = await confirmGenerationRunOutline(run.id, OWNER, {
      commandId: 'same',
      outlineRevision: 1,
      outlines: OUTLINES.slice(0, 2),
    });
    expect(again).toEqual(first);
    expect(await readGenerationRunEvents(run.id, 0)).toEqual(eventsAfterFirst);
    expect((await readGenerationRun(run.id, OWNER))!.outline!.revision).toBe(2);

    await expect(
      confirmGenerationRunOutline(run.id, OWNER, { commandId: 'other', outlineRevision: 2 }),
    ).rejects.toMatchObject({ reason: 'state' });
    await expect(retryGenerationRun(run.id, OWNER, { commandId: 'same' })).rejects.toMatchObject({
      reason: 'command-reused',
    });
    // Another owner cannot command the run at all.
    expect(
      await confirmGenerationRunOutline(run.id, OTHER, { commandId: 'x', outlineRevision: 2 }),
    ).toBeNull();
  });

  it('pauses at a step that fails after its retries, and Retry re-runs only that step', async () => {
    let failures = 0;
    const { services, calls } = fakeServices({ research: async () => null });
    const failing = fakeServices({
      research: async () => null,
      sceneActions: async (owner, input, ctx) => {
        if (input.outline.id === 'o2') {
          failures += 1;
          throw new Error('provider exploded');
        }
        return services.sceneActions(owner, input, ctx);
      },
      sceneContent: services.sceneContent,
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, failing.services)).toBe('requeued');
    expect(await drive(run.id, failing.services)).toBe('paused');
    // The browser's retries for a later scene: 5, so 6 attempts.
    expect(failures).toBe(6);
    let stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored).toMatchObject({
      state: 'paused',
      step: 'scene:1:actions',
      error: { step: 'scene:1:actions', message: 'provider exploded' },
      leaseWorkerId: null,
      progress: { scenesCompleted: 1 },
    });
    const events = await readGenerationRunEvents(run.id, 0);
    expect(
      events.filter(
        (event) => event.type === 'step_retry' && event.data.step === 'scene:1:actions',
      ),
    ).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      data: { state: 'paused', step: 'scene:1:actions' },
    });
    expect(await claim(run.id)).toBeNull();

    const contentBefore = calls.sceneContent.length;
    const actionsBefore = calls.sceneActions.length;
    await retryGenerationRun(run.id, OWNER, { commandId: 'retry-1' });
    expect(await drive(run.id, services)).toBe('completed');
    // Scene 2's content was checkpointed: only its actions ran again.
    expect(calls.sceneContent.slice(contentBefore).map((call) => call.outline.id)).toEqual(['o3']);
    expect(
      calls.sceneActions.slice(actionsBefore).map((call) => (call.outline as SceneOutline).id),
    ).toEqual(['o2', 'o3']);
    stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored).toMatchObject({ state: 'completed', error: null });
  });

  it('a worker that died is taken over from its last checkpoint, and the stale worker is fenced', async () => {
    const blocked = gate();
    const reachedScene2 = gate();
    const first = fakeServices({ research: async () => null });
    const dying = fakeServices({
      research: async () => null,
      sceneContent: async (owner, input, ctx) => {
        if (input.outline.id === 'o2') {
          reachedScene2.release();
          await blocked.promise;
        }
        return first.services.sceneContent(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, dying.services, 'worker-a')).toBe('requeued');
    const claimA = (await claim(run.id, 'worker-a')) as ClaimedRun;
    const executionA = executeGenerationRun(claimA, {
      services: dying.services,
      signal: new AbortController().signal,
    });
    await reachedScene2.promise;
    expect((await readGenerationRunSteps(run.id)).has('scene:0:append')).toBe(true);

    // Worker A stops heartbeating; once its lease is stale, B takes over.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const takeover = await claim(run.id, 'worker-b', 1);
    expect(takeover).toMatchObject({ takeover: true });
    expect(takeover!.lease.generation).toBe(claimA.lease.generation + 1);
    expect(takeover!.run.takeovers).toBe(1);

    const resumed = fakeServices({ research: async () => null });
    expect(
      await executeGenerationRun(takeover!, {
        services: resumed.services,
        signal: new AbortController().signal,
      }),
    ).toBe('completed');
    // B resumed after scene 1's append: it never regenerated scene 1.
    expect(resumed.calls.sceneContent.map((call) => call.outline.id)).toEqual(['o2', 'o3']);
    expect(resumed.calls.agentProfiles).toEqual([]);

    // A wakes up: its commit is refused, and so is any document write it tries.
    blocked.release();
    expect(await executionA).toBe('interrupted');
    await expect(commitGenerationRun(claimA.lease, { events: [] })).rejects.toBeInstanceOf(
      GenerationRunLeaseLostError,
    );
    const stored = (await readGenerationRun(run.id, OWNER))!;
    await expect(
      appendRunScene({
        ownerId: OWNER,
        lease: claimA.lease,
        stageId: stored.stageId!,
        scene: slideScene(stored.stageId!, OUTLINES[0]!),
      }),
    ).rejects.toBeInstanceOf(GenerationRunLeaseLostError);

    const document = await documentStore(OWNER).loadDocument(stored.stageId!);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o2', 'scene-o3']);
    expect(stored).toMatchObject({ state: 'completed', takeovers: 0 });
  });

  it('pauses a step whose workers keep dying instead of taking it over forever', async () => {
    const run = await start();
    expect(await claim(run.id, 'worker-a')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      await claimNextGenerationRun('worker-b', { leaseTtlMs: 1, maxTakeovers: 0, runId: run.id }),
    ).toBeNull();
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
      state: 'paused',
      error: { message: 'The step was interrupted too many times' },
      leaseWorkerId: null,
    });
  });

  it('ends at the next step boundary once its course is deleted', async () => {
    const blocked = gate();
    const reached = gate();
    const base = fakeServices({ research: async () => null });
    const { services, calls } = fakeServices({
      research: async () => null,
      sceneContent: async (owner, input, ctx) => {
        if (input.outline.id === 'o2') {
          reached.release();
          await blocked.promise;
        }
        return base.services.sceneContent(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('requeued');
    const execution = drive(run.id, services);
    await reached.promise;
    const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
    await documentStore(OWNER).deleteDocument(stageId);
    blocked.release();
    expect(await execution).toBe('ended');
    expect(calls.sceneActions).toHaveLength(1);
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
      state: 'ended',
      leaseWorkerId: null,
      progress: { scenesCompleted: 1 },
    });
    expect((await eventTypes(run.id)).slice(-2)).toEqual(['ended', 'state']);
  });

  it('generates later scenes ahead with a parallel concurrency, and consumes them in order', async () => {
    const order: string[] = [];
    const base = fakeServices({ research: async () => null });
    const { services } = fakeServices({
      research: async () => null,
      parallelSceneConcurrency: () => 3,
      sceneContent: async (owner, input, ctx) => {
        order.push(`content:${input.outline.id}`);
        return base.services.sceneContent(owner, input, ctx);
      },
      sceneActions: async (owner, input, ctx) => {
        order.push(`actions:${input.outline.id}`);
        return base.services.sceneActions(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    await drive(run.id, services);
    expect(await drive(run.id, services)).toBe('completed');
    // The first scene is serial (the preview); then the rest of the content
    // starts before the second scene's actions.
    expect(order.slice(0, 2)).toEqual(['content:o1', 'actions:o1']);
    expect(order.indexOf('content:o3')).toBeLessThan(order.indexOf('actions:o2'));
    expect(order.filter((entry) => entry.startsWith('actions:'))).toEqual([
      'actions:o1',
      'actions:o2',
      'actions:o3',
    ]);
    const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
    const document = await documentStore(OWNER).loadDocument(stageId);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o2', 'scene-o3']);
  });

  it("streams the owner's run changes for course lists", async () => {
    const streamCookie = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
    const streamOwner = `anon:${streamCookie}`;
    const waiting = await start(runInput(), streamOwner);
    const { GET } = await import('@/app/api/generation-runs/events/route');
    const response = await GET(
      new NextRequest('http://localhost/api/generation-runs/events', {
        headers: cookie(streamCookie),
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: RegExp) => {
      while (!needle.test(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(/event: runs\n/);
    expect(text).toContain(`"id":"${waiting.id}"`);

    // A state change wakes the stream (NOTIFY) and arrives as a `run` frame.
    const { services } = fakeServices({ research: async () => null });
    expect(await drive(waiting.id, services)).toBe('waiting');
    await readUntil(/"state":"awaiting_outline_confirmation"/);
    await reader.cancel();
    const frame = text
      .split('\n\n')
      .find((chunk) => chunk.includes('"state":"awaiting_outline_confirmation"'))!;
    expect(frame.startsWith('event: run\ndata: ')).toBe(true);
    expect(JSON.parse(frame.slice('event: run\ndata: '.length))).toMatchObject({
      type: 'run',
      run: { id: waiting.id, outline: { revision: 1 } },
    });
  });

  it('replays the event log after a seq, and streams it over SSE', async () => {
    const { services } = fakeServices();
    const run = await start();
    await drive(run.id, services);
    const all = await readGenerationRunEvents(run.id, 0);
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index + 1));
    expect((await readGenerationRunEvents(run.id, 5)).map((event) => event.seq)).toEqual(
      all.slice(5).map((event) => event.seq),
    );

    const { GET } = await import('@/app/api/generation-runs/[id]/events/route');
    const response = await GET(
      new NextRequest(`http://localhost/api/generation-runs/${run.id}/events?after=5`, {
        headers: cookie(OWNER_COOKIE),
      }),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: caught_up')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    const frames = text.split('\n\n').filter(Boolean);
    const dataFrames = frames.filter((frame) => frame.startsWith('id: '));
    expect(dataFrames.map((frame) => Number(/^id: (\d+)/.exec(frame)![1]))).toEqual(
      all.slice(5).map((event) => event.seq),
    );
    expect(dataFrames[0]).toBe(
      `id: ${all[5]!.seq}\nevent: ${all[5]!.type}\ndata: ${JSON.stringify({ ...all[5], phase: 'backlog' })}`,
    );
    expect(frames.at(-1)).toBe(
      `event: caught_up\ndata: ${JSON.stringify({ type: 'caught_up', from: 5, seq: all.at(-1)!.seq })}`,
    );
  });

  it('answers another owner the same 404 as an unknown run', async () => {
    const run = await start();
    const snapshot = await import('@/app/api/generation-runs/[id]/route');
    const events = await import('@/app/api/generation-runs/[id]/events/route');
    const confirm = await import('@/app/api/generation-runs/[id]/confirm-outline/route');
    const retry = await import('@/app/api/generation-runs/[id]/retry/route');
    const unknown = 'run-AAAAAAAAAAAAAAAA';
    const read = (id: string, who: string) =>
      snapshot.GET(
        new NextRequest(`http://localhost/api/generation-runs/${id}`, { headers: cookie(who) }),
        { params: Promise.resolve({ id }) },
      );

    const own = await read(run.id, OWNER_COOKIE);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ success: true, run: { id: run.id, seq: run.seq } });

    for (const id of [run.id, unknown]) {
      const response = await read(id, OTHER_COOKIE);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      const stream = await events.GET(
        new NextRequest(`http://localhost/api/generation-runs/${id}/events`, {
          headers: cookie(OTHER_COOKIE),
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(stream.status).toBe(404);
      const command = (route: typeof confirm | typeof retry, body: unknown) =>
        route.POST(
          new NextRequest(`http://localhost/api/generation-runs/${id}/x`, {
            method: 'POST',
            headers: { ...cookie(OTHER_COOKIE), 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ id }) },
        );
      expect((await command(confirm, { commandId: 'c', outlineRevision: 1 })).status).toBe(404);
      expect((await command(retry, { commandId: 'c' })).status).toBe(404);
    }

    const list = await import('@/app/api/generation-runs/route');
    const listed = await list.GET(
      new NextRequest('http://localhost/api/generation-runs?active=1', {
        headers: cookie(OTHER_COOKIE),
      }),
    );
    expect(await listed.json()).toEqual({ success: true, runs: [] });
  });

  it('refuses a start beyond the per-owner limit on active runs', async () => {
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '2';
    const limitedCookie = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const { POST, GET } = await import('@/app/api/generation-runs/route');
    const post = (body: unknown) =>
      POST(
        new NextRequest('http://localhost/api/generation-runs', {
          method: 'POST',
          headers: { ...cookie(limitedCookie), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const one = await post({ requirement: 'One' });
    const two = await post({ requirement: 'Two' });
    expect([one.status, two.status]).toEqual([202, 202]);
    const runOne = ((await one.json()) as { run: { id: string; state: string } }).run;
    expect(runOne.state).toBe('preparing');

    const three = await post({ requirement: 'Three' });
    expect(three.status).toBe(429);
    expect(await three.json()).toMatchObject({ errorCode: 'ACTIVE_RUN_LIMIT' });

    // A completed (or ended) run no longer counts.
    const { services } = fakeServices({ research: async () => null });
    await pool.query(
      `UPDATE generation_runs SET input = input || '{"outlineReview":"auto"}' WHERE id = $1`,
      [runOne.id],
    );
    await drive(runOne.id, services);
    expect(await drive(runOne.id, services)).toBe('completed');
    expect((await post({ requirement: 'Three' })).status).toBe(202);

    const listed = await GET(
      new NextRequest('http://localhost/api/generation-runs?active=1', {
        headers: cookie(limitedCookie),
      }),
    );
    const body = (await listed.json()) as { runs: Array<{ input: { requirement: string } }> };
    expect(body.runs.map((run) => run.input.requirement)).toEqual(['Two', 'Three']);

    expect(
      (await post({ requirement: 'x', agents: { mode: 'preset', agentIds: ['nope'] } })).status,
    ).toBe(400);
  });
});
