/**
 * Server-side generation runs on PostgreSQL: the engine with its step
 * services replaced by fakes (so every step's input can be checked against
 * what the browser sends its route), and everything else real: the run store,
 * its leases and event log, the owner-bound document store, the asset pool
 * and the run API routes.
 */
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** A hook into the run's completion, for a command that lands in its window. */
const completionHooks = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  /** Before each targeted scene write of a placement into a completed course. */
  beforeMutate: undefined as ((sceneId: string) => Promise<void>) | undefined,
}));
vi.mock('@/lib/server/generation/run/document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/generation/run/document')>();
  return {
    ...actual,
    completeRunCourse: async (input: Parameters<typeof actual.completeRunCourse>[0]) => {
      await completionHooks.before?.();
      return actual.completeRunCourse(input);
    },
    mutateRunScene: async (input: Parameters<typeof actual.mutateRunScene>[0]) => {
      await completionHooks.beforeMutate?.(input.sceneId);
      return actual.mutateRunScene(input);
    },
  };
});

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { stopAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import { appendRunScene } from '@/lib/server/generation/run/document';
import { executeGenerationRun } from '@/lib/server/generation/run/engine';
import { runClaimedGenerationRun, startGenerationRunner } from '@/lib/server/generation/run/runner';
import { defaultRunStepServices, type RunStepServices } from '@/lib/server/generation/run/services';
import {
  claimNextGenerationRun,
  compactFinishedGenerationRuns,
  commitGenerationRun,
  confirmGenerationRunOutline,
  createGenerationRun,
  discardGenerationRun,
  GenerationRunLeaseLostError,
  keepGenerationRunAssetsAlive,
  listActiveGenerationRuns,
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
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createOwnerAgent } from '@/lib/server/agents/store';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
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
    releasedClips: [] as string[],
  };
  const services: RunStepServices = {
    analyzeMaterials: async () => ({ text: 'material text', images: [] }),
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
      ids.map((id) => ({
        id,
        name: `Agent ${id}`,
        role: 'teacher',
        persona: 'Built in.',
        avatar: '/avatars/teacher.png',
        color: '#000',
        allowedActions: [],
        priority: 10,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        isDefault: true,
      })),
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
        fence: input.fence,
      });
      return stored.status === 'stored' ? stored.assetId : null;
    },
    releaseAssets: async (owner, ids, ctx) => {
      calls.releasedClips.push(...ids);
      return defaultRunStepServices.releaseAssets(owner, ids, ctx);
    },
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

/** Confirm with a limit no test reaches unless it means to. */
function confirm(
  runId: string,
  ownerId: string,
  command: Parameters<typeof confirmGenerationRunOutline>[2],
  maxActiveRunsPerOwner = 50,
) {
  return confirmGenerationRunOutline(runId, ownerId, command, { maxActiveRunsPerOwner });
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
    return createGenerationRun(ownerId, input, {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });
  }

  async function eventTypes(runId: string) {
    return (await readGenerationRunEvents(runId, 0)).map((event) => event.type);
  }

  it('produces the course the browser flow would, step by step, with the same context', async () => {
    // The log as it stood while the last scene generated (a finished run's
    // log is compacted to its final commit).
    let midway: Awaited<ReturnType<typeof readGenerationRunEvents>> = [];
    const base = fakeServices();
    const { services, calls } = fakeServices({
      sceneActions: async (owner, input, ctx) => {
        if (input.outline.id === 'o3') midway = await readGenerationRunEvents(run.id, 0);
        return base.services.sceneActions(owner, input, ctx);
      },
    });
    calls.sceneActions = base.calls.sceneActions;
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

    const confirmed = await confirm(run.id, OWNER, {
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
    const tail = midway.filter(
      (event) =>
        event.seq > confirmed!.seq && ['course_created', 'scene_ready'].includes(event.type),
    );
    expect(tail.map((event) => [event.type, event.data.index ?? null])).toEqual([
      ['course_created', null],
      ['scene_ready', 0],
      ['scene_ready', 1],
    ]);
    // Finished, and still whole until the grace period is over.
    expect((await eventTypes(run.id)).slice(-2)).toEqual(['completed', 'state']);
    expect((await readGenerationRunSteps(run.id)).size).toBeGreaterThan(0);
    await compactFinishedGenerationRuns(24 * 60 * 60 * 1000);
    expect((await readGenerationRunSteps(run.id)).size).toBeGreaterThan(0);
  });

  it('uses preset agents, confirms an edited outline, and confirms itself for headless callers', async () => {
    const { services, calls } = fakeServices({ research: async () => null });
    const run = await start(
      runInput({ agents: { mode: 'preset', agentIds: ['default-2'] }, outlineReview: 'auto' }),
    );
    // Confirmed in the outline's own commit: one execution, no waiting.
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
    await confirm(edited.id, OWNER, {
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
      confirm(run.id, OWNER, { commandId: 'stale', outlineRevision: 7 }),
    ).rejects.toMatchObject({ reason: 'outline-revision' });

    const first = await confirm(run.id, OWNER, {
      commandId: 'same',
      outlineRevision: 1,
      outlines: OUTLINES.slice(0, 2),
    });
    const eventsAfterFirst = await readGenerationRunEvents(run.id, 0);
    const again = await confirm(run.id, OWNER, {
      commandId: 'same',
      outlineRevision: 1,
      outlines: OUTLINES.slice(0, 2),
    });
    expect(again).toEqual(first);
    expect(await readGenerationRunEvents(run.id, 0)).toEqual(eventsAfterFirst);
    expect((await readGenerationRun(run.id, OWNER))!.outline!.revision).toBe(2);

    await expect(
      confirm(run.id, OWNER, { commandId: 'other', outlineRevision: 2 }),
    ).rejects.toMatchObject({ reason: 'state' });
    await expect(retryGenerationRun(run.id, OWNER, { commandId: 'same' })).rejects.toMatchObject({
      reason: 'command-reused',
    });
    // Another owner cannot command the run at all.
    expect(await confirm(run.id, OTHER, { commandId: 'x', outlineRevision: 2 })).toBeNull();
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
    const claimA = (await claim(run.id, 'worker-a')) as ClaimedRun;
    const executionA = executeGenerationRun(claimA, {
      services: dying.services,
      signal: new AbortController().signal,
    });
    await reachedScene2.promise;
    expect((await readGenerationRunSteps(run.id)).has('scene:0:narration')).toBe(true);

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

  it('ends in the deletion of its course, fencing the worker executing it', async () => {
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
    const execution = drive(run.id, services);
    await reached.promise;
    const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
    await documentStore(OWNER).deleteDocument(stageId);
    // Ended by the deletion itself, while the worker is still mid-step.
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
      state: 'ended',
      leaseWorkerId: null,
    });
    blocked.release();
    expect(await execution).toBe('interrupted');
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
    expect(await drive(runOne.id, services)).toBe('completed');
    expect((await post({ requirement: 'Three' })).status).toBe(202);

    const listed = await GET(
      new NextRequest('http://localhost/api/generation-runs?active=1', {
        headers: cookie(limitedCookie),
      }),
    );
    const body = (await listed.json()) as { runs: Array<{ input: { requirement: string } }> };
    // Listed by creation time, which a test cannot rely on to the microsecond.
    expect(body.runs.map((run) => run.input.requirement).sort()).toEqual(['Three', 'Two']);

    expect(
      (await post({ requirement: 'x', agents: { mode: 'preset', agentIds: ['nope'] } })).status,
    ).toBe(400);
  });

  it('ends a paused run when its course is deleted, and Retry is then refused', async () => {
    const { services } = fakeServices({
      research: async () => null,
      sceneActions: async (owner, input, ctx) => {
        if (input.outline.id === 'o2') throw Object.assign(new Error('no'), { statusCode: 400 });
        return fakeServices().services.sceneActions(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('paused');
    const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
    await documentStore(OWNER).deleteDocument(stageId);
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ state: 'ended', step: null });
    expect((await eventTypes(run.id)).slice(-2)).toEqual(['ended', 'state']);
    await expect(retryGenerationRun(run.id, OWNER, { commandId: 'late' })).rejects.toMatchObject({
      reason: 'state',
    });
  });

  it('discards a run that has no course yet (waiting for its outline), and only such a run', async () => {
    const { services } = fakeServices({ research: async () => null });
    const { DELETE } = await import('@/app/api/generation-runs/[id]/route');
    const discard = (id: string, who = OWNER_COOKIE) =>
      DELETE(
        new NextRequest(`http://localhost/api/generation-runs/${id}`, {
          method: 'DELETE',
          headers: cookie(who),
        }),
        { params: Promise.resolve({ id }) },
      );
    const waiting = await start();
    expect(await drive(waiting.id, services)).toBe('waiting');
    expect((await discard(waiting.id, OTHER_COOKIE)).status).toBe(404);
    const first = await discard(waiting.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, state: 'ended' });
    expect((await discard(waiting.id)).status).toBe(200);
    expect(await readGenerationRun(waiting.id, OWNER)).toMatchObject({ state: 'ended' });
    await expect(
      confirm(waiting.id, OWNER, { commandId: 'c', outlineRevision: 1 }),
    ).rejects.toMatchObject({ reason: 'state' });

    const withCourse = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(withCourse.id, services)).toBe('completed');
    const refused = await discard(withCourse.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ errorCode: 'RUN_STATE_CONFLICT' });
  });

  it('does not count runs waiting for outline confirmation toward the limit', async () => {
    const owner = 'anon:6f5e4d3c-2b1a-4f9e-8d7c-6b5a4f3e2d1c';
    const { services } = fakeServices({ research: async () => null });
    const waiting = await createGenerationRun(owner, runInput(), {
      maxActiveRunsPerOwner: 1,
      maxWaitingRunsPerOwner: 50,
    });
    await expect(
      createGenerationRun(owner, runInput(), {
        maxActiveRunsPerOwner: 1,
        maxWaitingRunsPerOwner: 50,
      }),
    ).rejects.toThrow(/does not count/);
    expect(await drive(waiting.id, services)).toBe('waiting');
    const next = await createGenerationRun(owner, runInput(), {
      maxActiveRunsPerOwner: 1,
      maxWaitingRunsPerOwner: 50,
    });
    expect(next.state).toBe('preparing');
  });

  it("threads the first scene's split speeches into the second scene, as the classroom does", async () => {
    const long = `${'A sentence about light. '.repeat(30)}${'A sentence about water. '.repeat(30)}`;
    const base = fakeServices({ research: async () => null });
    const { services, calls } = fakeServices({
      research: async () => null,
      narrationTarget: async () => ({
        connection: {
          providerId: 'glm-tts',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        } as MediaConnection,
        providerId: 'glm-tts',
        modelId: 'glm-tts',
      }),
      sceneActions: async (owner, input, ctx) => {
        const result = await base.services.sceneActions(owner, input, ctx);
        if (input.outline.id === 'o1') {
          (result.scene.actions![0] as { text: string }).text = long;
          return { ...result, previousSpeeches: [long] };
        }
        return result;
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('completed');
    const [first, second, third] = base.calls.sceneActions.map(
      (call) => call.previousSpeeches as string[],
    );
    expect(first).toEqual([]);
    // Narration split the long line for the provider; the stored scene holds the chunks.
    expect(second!.length).toBeGreaterThan(1);
    expect(second!.join(' ')).toBe(long.trim());
    expect(third).toEqual(['Say Body']);
    expect(calls.narrateClip.length).toBe(second!.length + 2);
  });

  it('in parallel mode marks a failed scene, goes on with the others and pauses at it', async () => {
    let failing = true;
    const base = fakeServices({ research: async () => null });
    const { services, calls } = fakeServices({
      research: async () => null,
      parallelSceneConcurrency: () => 3,
      sceneContent: async (owner, input, ctx) => {
        if (input.outline.id === 'o2' && failing) {
          throw Object.assign(new Error('content refused'), { statusCode: 400 });
        }
        return base.services.sceneContent(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('paused');
    let stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored).toMatchObject({
      state: 'paused',
      step: 'scene:1:content',
      error: { step: 'scene:1:content', message: 'content refused' },
      progress: { scenesCompleted: 2 },
    });
    let document = await documentStore(OWNER).loadDocument(stored.stageId!);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o3']);
    // The scene after the failed one followed the last scene generated before it.
    expect(calls.sceneActions.map((call) => call.previousSpeeches)).toEqual([[], ['Say Intro']]);

    failing = false;
    await retryGenerationRun(run.id, OWNER, { commandId: 'retry-parallel' });
    expect(await drive(run.id, services)).toBe('completed');
    stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored.progress).toEqual({ scenesTotal: 3, scenesCompleted: 3 });
    document = await documentStore(OWNER).loadDocument(stored.stageId!);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o2', 'scene-o3']);
  });

  it("narrates with the teacher's voice options, and retries a missing clone with another voice", async () => {
    const clone = 'qwen-tts-vc-clone-1';
    const base = fakeServices({ research: async () => null });
    const voxcpm = fakeServices({
      research: async () => null,
      narrationTarget: async () => ({
        connection: {
          providerId: 'voxcpm-tts',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        } as MediaConnection,
        providerId: 'voxcpm-tts',
      }),
    });
    const auto = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(auto.id, voxcpm.services)).toBe('completed');
    // The narrator is the registry's first teacher with nothing bound (the
    // built-in teacher, as in the browser), voiced from its persona.
    expect(voxcpm.calls.narrateClip[0]).toMatchObject({
      voice: 'voxcpm:auto',
      providerOptions: { voiceMode: 'auto', voicePrompt: expect.stringContaining('lead teacher') },
    });

    const voices: string[] = [];
    const qwen = fakeServices({
      research: async () => null,
      agentProfiles: async () => [
        {
          ...GENERATED_AGENTS[0]!,
          voiceConfig: { providerId: 'qwen-tts', modelId: 'qwen3-tts-vc-realtime', voiceId: clone },
        },
        GENERATED_AGENTS[1]!,
      ],
      narrationTarget: async () => ({
        connection: {
          providerId: 'qwen-tts',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        } as MediaConnection,
        providerId: 'qwen-tts',
        modelId: 'qwen3-tts-flash',
      }),
      narrateClip: async (owner, input, ctx) => {
        voices.push(input.voice);
        if (input.voice === clone) {
          throw Object.assign(new Error('missing clone'), {
            code: 'QWEN_VC_VOICE_NOT_FOUND',
            httpStatus: 404,
          });
        }
        return base.services.narrateClip(owner, input, ctx);
      },
    });
    const bound = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(bound.id, qwen.services)).toBe('completed');
    // The clone failed once; that clip and every later one used the slot voice.
    expect(voices).toEqual([clone, 'Cherry', 'Cherry', 'Cherry']);
  });

  it('releases the clips of a narration attempt that failed', async () => {
    const base = fakeServices({ research: async () => null });
    let clips = 0;
    const { services, calls } = fakeServices({
      research: async () => null,
      sceneActions: async (owner, input, ctx) => {
        const result = await base.services.sceneActions(owner, input, ctx);
        result.scene.actions = [
          ...result.scene.actions!,
          { id: `second-${input.outline.id}`, type: 'speech', text: 'Second line.' },
        ] as never;
        return result;
      },
      narrateClip: async (owner, input, ctx) => {
        clips += 1;
        if (clips === 2) throw Object.assign(new Error('voice refused'), { httpStatus: 400 });
        return base.services.narrateClip(owner, input, ctx);
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('paused');
    expect(calls.releasedClips).toHaveLength(1);
    const entries = await pool.query('SELECT 1 FROM asset_entries WHERE id = ANY($1)', [
      calls.releasedClips,
    ]);
    expect(entries.rows).toEqual([]);
  });

  it('caps the run streams one owner holds', async () => {
    process.env.OPENMAIC_GENERATION_RUN_STREAMS_PER_OWNER = '1';
    try {
      const run = await start();
      const events = await import('@/app/api/generation-runs/[id]/events/route');
      const owner = await import('@/app/api/generation-runs/events/route');
      const open = () =>
        events.GET(
          new NextRequest(`http://localhost/api/generation-runs/${run.id}/events`, {
            headers: cookie(OWNER_COOKIE),
          }),
          { params: Promise.resolve({ id: run.id }) },
        );
      const first = await open();
      expect(first.status).toBe(200);
      expect((await open()).status).toBe(429);
      expect(
        (
          await owner.GET(
            new NextRequest('http://localhost/api/generation-runs/events', {
              headers: cookie(OWNER_COOKIE),
            }),
          )
        ).status,
      ).toBe(429);
      await first.body!.cancel();
      const again = await open();
      expect(again.status).toBe(200);
      await again.body!.cancel();
    } finally {
      delete process.env.OPENMAIC_GENERATION_RUN_STREAMS_PER_OWNER;
    }
  });

  it('confirming an outline respects the limit on runs in progress', async () => {
    const owner = 'anon:3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
    const ownerCookie = owner.slice('anon:'.length);
    const { services } = fakeServices({ research: async () => null });
    const limits = { maxActiveRunsPerOwner: 1, maxWaitingRunsPerOwner: 50 };
    const waiting = await createGenerationRun(owner, runInput(), limits);
    expect(await drive(waiting.id, services)).toBe('waiting');
    // The waiting run does not count, so another one may start...
    const busy = await createGenerationRun(owner, runInput(), limits);
    expect(busy.state).toBe('preparing');
    // ...but confirming the first would make two in progress.
    await expect(
      confirm(waiting.id, owner, { commandId: 'c1', outlineRevision: 1 }, 1),
    ).rejects.toThrow(/does not count/);
    const { POST } = await import('@/app/api/generation-runs/[id]/confirm-outline/route');
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '1';
    const refused = await POST(
      new NextRequest(`http://localhost/api/generation-runs/${waiting.id}/confirm-outline`, {
        method: 'POST',
        headers: { ...cookie(ownerCookie), 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: 'c1', outlineRevision: 1 }),
      }),
      { params: Promise.resolve({ id: waiting.id }) },
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ errorCode: 'ACTIVE_RUN_LIMIT' });
    expect((await readGenerationRun(waiting.id, owner))!.state).toBe(
      'awaiting_outline_confirmation',
    );
    // Once the other run is over, the same command confirms.
    await pool.query("UPDATE generation_runs SET state = 'ended' WHERE id = $1", [busy.id]);
    expect(
      await confirm(waiting.id, owner, { commandId: 'c1', outlineRevision: 1 }, 1),
    ).toMatchObject({ state: 'generating' });
  });

  it('caps the runs one owner keeps waiting for an outline confirmation', async () => {
    const owner = 'anon:4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a';
    const { services } = fakeServices({ research: async () => null });
    const limits = { maxActiveRunsPerOwner: 50, maxWaitingRunsPerOwner: 1 };
    const waiting = await createGenerationRun(owner, runInput(), limits);
    expect(await drive(waiting.id, services)).toBe('waiting');
    await expect(createGenerationRun(owner, runInput(), limits)).rejects.toThrow(
      /wait for an outline confirmation/,
    );
  });

  it('a generated outline with model-style nulls and extras confirms unchanged', async () => {
    const loose = [
      {
        id: 'l1',
        type: 'slide',
        title: 'One',
        description: null,
        keyPoints: ['a', ''],
        order: 1,
        quizConfig: null,
        notes: 'extra',
      },
      { id: 'l2', type: 'quiz', title: 'Two', order: 2, quizConfig: { questionTypes: ['essay'] } },
    ];
    const { services } = fakeServices({
      research: async () => null,
      outline: async () => ({
        outlines: loose as never,
        languageDirective: 'Use English.',
        courseTitle: 'Loose',
        taskEngineMode: false,
      }),
    });
    const run = await start();
    expect(await drive(run.id, services)).toBe('waiting');
    const stored = (await readGenerationRun(run.id, OWNER))!;
    expect(stored.outline!.outlines).toEqual([
      { id: 'l1', type: 'slide', title: 'One', description: '', keyPoints: ['a'], order: 1 },
      {
        id: 'l2',
        type: 'quiz',
        title: 'Two',
        description: '',
        keyPoints: [],
        order: 2,
      },
    ]);
    // The outline as the run holds it goes back through confirm as is.
    const { parseConfirmOutline } = await import('@/lib/server/generation/run/input');
    const parsed = parseConfirmOutline({
      commandId: 'same',
      outlineRevision: 1,
      outlines: stored.outline!.outlines,
    });
    expect(parsed.ok && parsed.value.outlines).toEqual(stored.outline!.outlines);
    expect(await confirm(run.id, OWNER, parsed.ok ? parsed.value : (null as never))).toMatchObject({
      state: 'generating',
      outlineRevision: 2,
    });
  });

  it('sends a resync frame to a reader behind what a finished run keeps', async () => {
    const { services } = fakeServices({ research: async () => null });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('completed');
    // Past its grace period (none, here), the sweep compacts it.
    expect(await compactFinishedGenerationRuns(0)).toBeGreaterThanOrEqual(1);
    expect((await readGenerationRunSteps(run.id)).size).toBe(0);
    const kept = await readGenerationRunEvents(run.id, 0);
    expect(kept.map((event) => event.type)).toEqual(['completed', 'state']);
    const { GET } = await import('@/app/api/generation-runs/[id]/events/route');
    const read = async (after: number) => {
      const response = await GET(
        new NextRequest(`http://localhost/api/generation-runs/${run.id}/events?after=${after}`, {
          headers: cookie(OWNER_COOKIE),
        }),
        { params: Promise.resolve({ id: run.id }) },
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: caught_up')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      return text
        .split('\n\n')
        .filter((frame) => frame.startsWith('event:') || frame.startsWith('id:'));
    };
    const behind = await read(0);
    expect(behind[0]).toBe(
      `event: resync\ndata: ${JSON.stringify({
        type: 'resync',
        reason: 'compacted',
        from: 0,
        snapshot: `/api/generation-runs/${run.id}`,
        oldestSeq: kept[0]!.seq,
      })}`,
    );
    expect(behind.slice(1, 3).map((frame) => /^id: (\d+)/.exec(frame)![1])).toEqual(
      kept.map((event) => String(event.seq)),
    );
    // A reader already at the kept events gets no resync.
    const current = await read(kept[0]!.seq - 1);
    expect(current[0]!.startsWith(`id: ${kept[0]!.seq}`)).toBe(true);
  });

  it('writes the course for the owner a run belongs to now, across two claims mid-run', async () => {
    const anonymous = 'anon:5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
    const middle = 'user:merge-middle';
    const account = 'user:merge-account';
    const blocked = gate();
    const reached = gate();
    const base = fakeServices({ research: async () => null });
    const { services } = fakeServices({
      research: async () => null,
      sceneContent: async (owner, input, ctx) => {
        if (input.outline.id === 'o2') {
          reached.release();
          await blocked.promise;
        }
        return base.services.sceneContent(owner, input, ctx);
      },
    });
    const run = await createGenerationRun(anonymous, runInput({ outlineReview: 'auto' }), {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });
    const execution = drive(run.id, services);
    await reached.promise;
    const stageId = (await readGenerationRun(run.id, anonymous))!.stageId!;
    // anonymous → middle → account, the course moving with each (as the
    // claim and a host's account merge move ownership rows).
    await pool.query(
      `INSERT INTO owner_merges (from_owner_id, to_owner_id) VALUES ($1, $2), ($2, $3)`,
      [anonymous, middle, account],
    );
    await pool.query('UPDATE stage_meta SET owner_id = $2 WHERE stage_id = $1', [stageId, account]);
    blocked.release();
    expect(await execution).toBe('completed');
    const document = await documentStore(account).loadDocument(stageId);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['scene-o1', 'scene-o2', 'scene-o3']);
    const meta = await pool.query(
      'SELECT owner_id, generation_complete FROM stage_meta WHERE stage_id = $1',
      [stageId],
    );
    expect(meta.rows).toEqual([{ owner_id: account, generation_complete: true }]);
    // The account reads the run, two claims after it started.
    expect(await readGenerationRun(run.id, account)).toMatchObject({ state: 'completed' });
  });

  it('completion sets only the flags, in a commit that fires the stage revision trigger', async () => {
    // Every UPDATE of a stage row, as the revision trigger sees them.
    await pool.query(`CREATE TABLE IF NOT EXISTS stage_row_updates (stage_id TEXT, rev BIGINT)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION record_stage_row_update() RETURNS trigger AS $$
      BEGIN
        INSERT INTO stage_row_updates
          SELECT NEW.id, (SELECT rev FROM document_stage_revision WHERE stage_id = NEW.id);
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS record_stage_row_update ON document_stages`);
    await pool.query(`CREATE TRIGGER record_stage_row_update AFTER UPDATE ON document_stages
      FOR EACH ROW EXECUTE FUNCTION record_stage_row_update()`);
    try {
      const { services } = fakeServices({ research: async () => null });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      const updates = await pool.query('SELECT rev FROM stage_row_updates WHERE stage_id = $1', [
        stageId,
      ]);
      // Only completion touches the stage row (appends write scenes), and
      // the revision trigger ran for it.
      expect(updates.rows).toHaveLength(1);
      const revision = await pool.query(
        'SELECT rev FROM document_stage_revision WHERE stage_id = $1',
        [stageId],
      );
      expect(Number(updates.rows[0]!.rev)).toBe(Number(revision.rows[0]!.rev));
      const scenes = (
        await pool.query('SELECT id FROM document_scenes WHERE stage_id = $1 ORDER BY id', [
          stageId,
        ])
      ).rows;
      expect(scenes).toHaveLength(3);
      const document = await documentStore(OWNER).loadDocument(stageId);
      expect(document!.outline).toMatchObject({ generationComplete: true });
      expect(document!.stage.updatedAt).toBeGreaterThanOrEqual(document!.stage.createdAt!);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS record_stage_row_update ON document_stages`);
    }
  });

  it('falls back to the default presets when agent generation fails and none were selected', async () => {
    const { services, calls } = fakeServices({
      research: async () => null,
      agentProfiles: async () => {
        throw new Error('profiles failed');
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('completed');
    expect(
      (calls.sceneContent[0]!.agents as Array<{ id: string }>).map((agent) => agent.id),
    ).toEqual(['default-1', 'default-2', 'default-3']);
  });

  it('a scene of a type no content path supports fails at its content step, as in the browser', async () => {
    const outlines: SceneOutline[] = [
      OUTLINES[0]!,
      { ...OUTLINES[1]!, type: 'video' as SceneOutline['type'] },
      OUTLINES[2]!,
    ];
    const base = fakeServices({ research: async () => null });
    const refuseUnknown = (parallel: number) =>
      fakeServices({
        research: async () => null,
        parallelSceneConcurrency: () => parallel,
        outline: async () => ({
          outlines,
          languageDirective: 'Use English.',
          courseTitle: 'Mixed',
          taskEngineMode: false,
        }),
        sceneContent: async (owner, input, ctx) => {
          if (!['slide', 'quiz', 'interactive', 'pbl'].includes(input.outline.type)) {
            throw new StepRefusal(
              'generation-failed',
              `Failed to generate content: ${input.outline.title}`,
            );
          }
          return base.services.sceneContent(owner, input, ctx);
        },
      });

    // Serial: the run pauses at that scene; the outline was accepted as is.
    const serial = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(serial.id, refuseUnknown(0).services)).toBe('paused');
    expect(await readGenerationRun(serial.id, OWNER)).toMatchObject({
      step: 'scene:1:content',
      outline: { outlines: [{ id: 'o1' }, { id: 'o2', type: 'video' }, { id: 'o3' }] },
      progress: { scenesCompleted: 1 },
    });

    // Parallel: it is marked, the others go on, and the run pauses at it after.
    const parallel = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(parallel.id, refuseUnknown(3).services)).toBe('paused');
    expect(await readGenerationRun(parallel.id, OWNER)).toMatchObject({
      step: 'scene:1:content',
      progress: { scenesCompleted: 2 },
    });
  });

  it("narrates a custom preset teacher with its own voice, from the owner's registry", async () => {
    const owner = 'anon:6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
    await createOwnerAgent(pool as unknown as ConnectableQueryable, owner, {
      id: 'custom-teacher',
      name: 'Mira',
      role: 'teacher',
      persona: 'Calm and exact.',
      avatar: '/avatars/teacher-2.png',
      color: '#123456',
      allowedActions: [],
      priority: 10,
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'Ethan' },
    });
    const base = fakeServices({ research: async () => null });
    const voices: string[] = [];
    const { services, calls } = fakeServices({
      research: async () => null,
      presetAgents: defaultRunStepServices.presetAgents,
      narrationTarget: async () => ({
        connection: {
          providerId: 'qwen-tts',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        } as MediaConnection,
        providerId: 'qwen-tts',
        modelId: 'qwen3-tts-flash',
      }),
      narrateClip: async (who, input, ctx) => {
        voices.push(input.voice);
        return base.services.narrateClip(who, input, ctx);
      },
    });
    const run = await createGenerationRun(
      owner,
      runInput({ agents: { mode: 'preset', agentIds: ['custom-teacher'] }, outlineReview: 'auto' }),
      { maxActiveRunsPerOwner: 50, maxWaitingRunsPerOwner: 50 },
    );
    expect(await drive(run.id, services)).toBe('completed');
    expect(calls.sceneContent[0]!.agents).toEqual([
      { id: 'custom-teacher', name: 'Mira', role: 'teacher', persona: 'Calm and exact.' },
    ]);
    // Its bound voice, not the slot's default (Cherry).
    expect(voices).toEqual(['Ethan', 'Ethan', 'Ethan']);
    expect((await readGenerationRun(run.id, owner))!.agents).toMatchObject({
      customAgents: [
        { id: 'custom-teacher', voiceConfig: { providerId: 'qwen-tts', voiceId: 'Ethan' } },
      ],
    });
  });

  it('validates the complete scene in the actions step: an action without a type is regenerated', async () => {
    const base = fakeServices({ research: async () => null });
    let invalidLeft = 2;
    const typeless = (scene: Scene) => ({
      ...scene,
      actions: [{ id: 'broken', type: undefined, text: 'no type' }],
    });
    const { services, calls } = fakeServices({
      research: async () => null,
      sceneActions: async (owner, input, ctx) => {
        const result = await base.services.sceneActions(owner, input, ctx);
        // What the action parser builds when the model names no action type.
        if (input.outline.id === 'o2' && invalidLeft > 0) {
          invalidLeft -= 1;
          return { ...result, scene: typeless(result.scene as Scene) as never };
        }
        return result;
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('completed');
    // Two invalid attempts, regenerated by the actions step's own retries.
    expect(base.calls.sceneActions.map((call) => (call.outline as SceneOutline).id)).toEqual([
      'o1',
      'o2',
      'o2',
      'o2',
      'o3',
    ]);
    const retries = (await readGenerationRunEvents(run.id, 0)).filter(
      (event) => event.type === 'step_retry' && event.data.step === 'scene:1:actions',
    );
    expect(retries).toHaveLength(2);
    expect(String(retries[0]!.data.cause)).toMatch(/cannot hold/);
    expect(calls.narrateClip).toHaveLength(3);
  });

  it('pauses at the actions step when every attempt is invalid, so Retry regenerates the actions', async () => {
    const base = fakeServices({ research: async () => null });
    let broken = true;
    const { services, calls } = fakeServices({
      research: async () => null,
      sceneActions: async (owner, input, ctx) => {
        const result = await base.services.sceneActions(owner, input, ctx);
        if (input.outline.id === 'o2' && broken) {
          return {
            ...result,
            scene: { ...(result.scene as Scene), actions: [{ id: 'x' }] } as never,
          };
        }
        return result;
      },
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    expect(await drive(run.id, services)).toBe('paused');
    expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
      step: 'scene:1:actions',
      progress: { scenesCompleted: 1 },
    });
    // Narration never saw the invalid scene, and nothing of it was checkpointed.
    expect(calls.narrateClip.map((call) => call.audioId)).toEqual(['tts_s1_speech-o1']);
    expect((await readGenerationRunSteps(run.id)).has('scene:1:actions')).toBe(false);
    broken = false;
    await retryGenerationRun(run.id, OWNER, { commandId: 'regenerate-actions' });
    expect(await drive(run.id, services)).toBe('completed');
  });

  it("hands the steps the run's signal, so a lost run cancels the call in flight", async () => {
    const abort = new AbortController();
    const reached = gate();
    let cancelled = false;
    const { services } = fakeServices({
      research: async () => null,
      sceneContent: (_owner, input, ctx) =>
        input.outline.id === 'o2'
          ? new Promise((_resolve, reject) => {
              reached.release();
              ctx.signal!.addEventListener('abort', () => {
                cancelled = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            })
          : fakeServices().services.sceneContent(_owner, input, ctx),
    });
    const run = await start(runInput({ outlineReview: 'auto' }));
    const claimed = (await claim(run.id))!;
    const execution = executeGenerationRun(claimed, { services, signal: abort.signal });
    await reached.promise;
    abort.abort();
    expect(await execution).toBe('interrupted');
    expect(cancelled).toBe(true);
  });

  describe('media, material images and the read-only course', () => {
    const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const VIDEO_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const POSTER_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 9]);
    const TASK = {
      taskId: 'task-1',
      providerId: 'seedance',
      model: 'seedance-1',
      endpoint: 'https://video.example.com',
    };
    const MEDIA_OUTLINES: SceneOutline[] = [
      {
        ...OUTLINES[0]!,
        mediaGenerations: [
          { type: 'image', prompt: 'A leaf', elementId: 'gen_img_1', aspectRatio: '16:9' },
        ],
      },
      {
        ...OUTLINES[1]!,
        mediaGenerations: [{ type: 'video', prompt: 'Sunlight', elementId: 'gen_vid_1' }],
      },
      OUTLINES[2]!,
    ];
    const connection = (providerId: string) =>
      ({
        providerId,
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      }) as MediaConnection;
    const ready = (providerId: string) => ({
      status: 'ready' as const,
      connection: connection(providerId),
    });
    const OFF = { status: 'off' as const };

    /** A slide holding the outline's media placeholders, as the content step leaves them. */
    function mediaScene(stageId: string, outline: SceneOutline, imageSrc?: string): Scene {
      const scene = slideScene(stageId, outline);
      const canvas = (scene.content as { canvas: { elements: unknown[] } }).canvas;
      const box = { left: 0, top: 0, width: 100, height: 60, rotate: 0 };
      for (const media of outline.mediaGenerations ?? []) {
        canvas.elements.push(
          media.type === 'image'
            ? {
                id: `el-${media.elementId}`,
                type: 'image',
                ...box,
                fixedRatio: true,
                src: media.elementId,
              }
            : {
                id: `el-${media.elementId}`,
                type: 'video',
                ...box,
                src: media.elementId,
                mediaRef: media.elementId,
                autoplay: false,
              },
        );
      }
      if (imageSrc) {
        canvas.elements.push({
          id: 'el-material',
          type: 'image',
          ...box,
          fixedRatio: true,
          src: imageSrc,
        });
      }
      return scene;
    }

    function mediaServices(overrides: Partial<RunStepServices> = {}) {
      const order: string[] = [];
      const media = { image: [] as string[], video: [] as Array<{ resume?: unknown }> };
      const base = fakeServices({ research: async () => null });
      const built = fakeServices({
        research: async () => null,
        outline: async () => ({
          outlines: MEDIA_OUTLINES,
          languageDirective: 'Use English.',
          courseTitle: 'Plants',
          taskEngineMode: false,
        }),
        sceneActions: async (owner, input, ctx) => {
          order.push(`actions:${input.outline.id}`);
          await base.services.sceneActions(owner, input, ctx);
          return {
            scene: mediaScene(input.stageId, input.outline) as never,
            previousSpeeches: [`Say ${input.outline.title}`],
          };
        },
        mediaConnections: async () => ({
          image: ready('seedream'),
          video: ready('seedance'),
        }),
        generateImage: async (_owner, input) => {
          order.push(`image:${input.request.elementId}`);
          media.image.push(input.request.elementId);
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
        generateVideo: async (_owner, input) => {
          order.push(`video:${input.request.elementId}`);
          media.video.push({ resume: input.resume });
          if (!input.resume) await input.onProviderTask(TASK);
          return {
            video: { bytes: VIDEO_BYTES, mimeType: 'video/mp4' },
            poster: { bytes: POSTER_BYTES, mimeType: 'image/jpeg' },
          };
        },
        ...overrides,
      });
      return { ...built, order, media };
    }

    function elementsOf(scene: Scene | undefined) {
      return ((scene?.content as { canvas?: { elements?: Array<Record<string, unknown>> } })?.canvas
        ?.elements ?? []) as Array<Record<string, unknown>>;
    }

    async function committedAt(assetId: string) {
      const result = await pool.query<{ committed_at: Date | null }>(
        'SELECT committed_at FROM asset_entries WHERE id = $1',
        [assetId],
      );
      return result.rows[0]?.committed_at ?? null;
    }

    async function mediaOf(runId: string) {
      const steps = await readGenerationRunSteps(runId);
      return Object.fromEntries(
        [...steps.entries()]
          .filter(([id]) => id.startsWith('media:'))
          .map(([id, output]) => [id.slice('media:'.length), output]),
      ) as Record<string, Record<string, unknown>>;
    }

    async function mediaEvents(runId: string) {
      return (await readGenerationRunEvents(runId, 0))
        .filter((event) => event.type === 'media')
        .map((event) => `${event.data.elementId}:${event.data.status}`);
    }

    it('generates the outline media alongside the scenes and names the assets in the course', async () => {
      const { services, order } = mediaServices();
      const run = await start(runInput({ outlineReview: 'auto' }));
      // The log as it stands before completion compacts nothing (retention is hours).
      expect(await drive(run.id, services)).toBe('completed');
      const stored = (await readGenerationRun(run.id, OWNER))!;
      const document = (await documentStore(OWNER).loadDocument(stored.stageId!))!;

      // As in the browser: the pass starts once the first scene is in.
      expect(order.indexOf('image:gen_img_1')).toBeGreaterThan(order.indexOf('actions:o1'));
      expect(
        order.filter((entry) => entry.startsWith('image:') || entry.startsWith('video:')),
      ).toEqual(['image:gen_img_1', 'video:gen_vid_1']);

      const media = await mediaOf(run.id);
      expect(media.gen_img_1).toMatchObject({ mediaType: 'image', status: 'done' });
      expect(media.gen_vid_1).toMatchObject({ mediaType: 'video', status: 'done' });
      const image = elementsOf(document.scenes[0]).find((element) => element.type === 'image')!;
      const video = elementsOf(document.scenes[1]).find((element) => element.type === 'video')!;
      expect(image.src).toBe(media.gen_img_1!.assetId);
      expect(video).toMatchObject({
        src: media.gen_vid_1!.assetId,
        mediaRef: media.gen_vid_1!.assetId,
        poster: media.gen_vid_1!.posterAssetId,
      });
      // The document write committed the allocations.
      for (const assetId of [image.src, video.src, video.poster] as string[]) {
        expect(assetId).toMatch(/^ast_/);
        expect(await committedAt(assetId)).not.toBeNull();
      }
      // The stage's video manifest stays keyed by the placeholder, as in the browser.
      expect(Object.keys(document.stage.videoManifest ?? {})).toEqual(['gen_vid_1']);
      expect(await mediaEvents(run.id)).toEqual([
        'gen_img_1:pending',
        'gen_vid_1:pending',
        'gen_img_1:generating',
        'gen_img_1:done',
        'gen_vid_1:generating',
        'gen_vid_1:done',
      ]);

      const route = await import('@/app/api/generation-runs/[id]/route');
      const snapshot = await route.GET(
        new NextRequest(`http://localhost/api/generation-runs/${run.id}`, {
          headers: cookie(OWNER_COOKIE),
        }),
        { params: Promise.resolve({ id: run.id }) },
      );
      expect((await snapshot.json()).run.media).toEqual({
        gen_img_1: { mediaType: 'image', status: 'done', assetId: image.src },
        gen_vid_1: {
          mediaType: 'video',
          status: 'done',
          assetId: video.src,
          posterAssetId: video.poster,
        },
      });
    });

    it('generates only the kinds whose slot resolves, and a skipped one on Retry once it does', async () => {
      let videoSlot: { status: 'off' } | ReturnType<typeof ready> = OFF;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: videoSlot }),
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      expect(media.video).toEqual([]);
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({ mediaType: 'video', status: 'skipped' });
      const stored = (await readGenerationRun(run.id, OWNER))!;
      let document = (await documentStore(OWNER).loadDocument(stored.stageId!))!;
      // The video keeps its placeholder, which renders as generation disabled.
      expect(
        elementsOf(document.scenes[1]).find((element) => element.type === 'video'),
      ).toMatchObject({
        src: 'gen_vid_1',
        mediaRef: 'gen_vid_1',
      });
      // A run whose skipped media a Retry may still generate is not compacted.
      await pool.query(
        "UPDATE generation_runs SET updated_at = now() - interval '2 days' WHERE id = $1",
        [run.id],
      );
      await compactFinishedGenerationRuns(1000);
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'skipped' });

      videoSlot = ready('seedance');
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'sk',
        media: { elementId: 'gen_vid_1' },
      });
      expect(await drive(run.id, services)).toBe('completed');
      expect(media.video).toHaveLength(1);
      document = (await documentStore(OWNER).loadDocument(stored.stageId!))!;
      expect(
        elementsOf(document.scenes[1]).find((element) => element.type === 'video')!.mediaRef,
      ).toBe((await mediaOf(run.id)).gen_vid_1!.assetId);
      // With every item answered for good, the run is compacted as usual.
      await pool.query(
        "UPDATE generation_runs SET updated_at = now() - interval '2 days' WHERE id = $1",
        [run.id],
      );
      await compactFinishedGenerationRuns(1000);
      expect(await mediaOf(run.id)).toEqual({});
    });

    it('a media failure leaves its placeholder without pausing, and Retry regenerates only it', async () => {
      let failImage = true;
      const hooks: { editDuringRetry?: () => Promise<void> } = {};
      const { services, media, calls } = mediaServices({
        generateImage: async (_owner, input) => {
          media.image.push(input.request.elementId);
          if (failImage) throw new Error('provider said 500: upstream detail');
          await hooks.editDuringRetry?.();
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      let stored = (await readGenerationRun(run.id, OWNER))!;
      const stageId = stored.stageId!;
      expect(stored).toMatchObject({ state: 'completed', mediaPending: false });
      // The provider's text is not what the element shows.
      expect((await mediaOf(run.id)).gen_img_1).toEqual({
        mediaType: 'image',
        status: 'failed',
        message: 'Image generation failed',
      });
      let document = (await documentStore(OWNER).loadDocument(stageId))!;
      expect(elementsOf(document.scenes[0]).find((element) => element.type === 'image')!.src).toBe(
        'gen_img_1',
      );
      // The video was generated anyway, and the course is complete and editable.
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'done' });
      await documentStore(OWNER).putScene(stageId, document.scenes[2]!);

      // Another owner's Retry is the same miss as an unknown run's.
      expect(
        await retryGenerationRun(run.id, OTHER, {
          commandId: 'm1',
          media: { elementId: 'gen_img_1' },
        }),
      ).toBeNull();
      // An element that did not fail, or is not the run's, is refused.
      for (const elementId of ['gen_vid_1', 'gen_img_9']) {
        await expect(
          retryGenerationRun(run.id, OWNER, { commandId: `x-${elementId}`, media: { elementId } }),
        ).rejects.toMatchObject({ reason: 'media' });
      }

      const retried = await retryGenerationRun(run.id, OWNER, {
        commandId: 'm1',
        media: { elementId: 'gen_img_1' },
      });
      expect(retried).toMatchObject({ state: 'completed' });
      // The same command again answers the same, and queues nothing more.
      expect(
        await retryGenerationRun(run.id, OWNER, {
          commandId: 'm1',
          media: { elementId: 'gen_img_1' },
        }),
      ).toEqual(retried);
      stored = (await readGenerationRun(run.id, OWNER))!;
      expect(stored).toMatchObject({ state: 'completed', mediaPending: true });
      // A Retry after completion does not lock the course: the author keeps
      // editing while the item regenerates.
      await documentStore(OWNER).putScene(stageId, document.scenes[2]!);

      failImage = false;
      // The author's markup, which the generation path's sanitizer would not keep.
      const authorText = {
        id: 'el-author',
        type: 'text',
        left: 0,
        top: 200,
        width: 300,
        height: 40,
        rotate: 0,
        content: '<p data-author-note="1">Author note</p>',
        defaultFontName: 'Inter',
        defaultColor: '#000',
      };
      hooks.editDuringRetry = async () => {
        const current = structuredClone(
          (await documentStore(OWNER).loadDocument(stageId))!.scenes[0]!,
        );
        (current.content as { canvas: { elements: unknown[] } }).canvas.elements.push(authorText);
        expect(JSON.stringify(sanitizeSceneContent(current))).not.toContain('data-author-note');
        await documentStore(OWNER).putScene(stageId, { ...current, title: 'Edited during retry' });
      };
      const contentCalls = calls.sceneContent.length;
      expect(await drive(run.id, services)).toBe('completed');
      expect(calls.sceneContent).toHaveLength(contentCalls);
      expect(media.image).toEqual(['gen_img_1', 'gen_img_1']);
      const after = await mediaOf(run.id);
      expect(after.gen_img_1).toMatchObject({ status: 'done' });
      document = (await documentStore(OWNER).loadDocument(stageId))!;
      // Placed into the scene as the author left it: the edit stays.
      expect(document.scenes[0]!.title).toBe('Edited during retry');
      expect(elementsOf(document.scenes[0]).find((element) => element.id === 'el-author')).toEqual(
        authorText,
      );
      expect(elementsOf(document.scenes[0]).find((element) => element.type === 'image')!.src).toBe(
        after.gen_img_1!.assetId,
      );
      expect(await committedAt(after.gen_img_1!.assetId as string)).not.toBeNull();
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'completed',
        mediaPending: false,
        leaseWorkerId: null,
      });
      await documentStore(OWNER).putScene(stageId, document.scenes[2]!);
      // Nothing is left to claim.
      expect(await claim(run.id)).toBeNull();
    });

    it('drops a retried result whose element the author removed, without resurrecting it', async () => {
      let failImage = true;
      let stageId = '';
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        generateImage: async () => {
          if (failImage) throw new Error('provider down');
          // The author deletes the image while it regenerates.
          const current = (await documentStore(OWNER).loadDocument(stageId))!.scenes[0]!;
          const canvas = (current.content as { canvas: { elements: Array<{ type: string }> } })
            .canvas;
          canvas.elements = canvas.elements.filter((element) => element.type !== 'image');
          await documentStore(OWNER).putScene(stageId, current);
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      failImage = false;
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'gone',
        media: { elementId: 'gen_img_1' },
      });
      const assetsBefore = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM asset_entries',
      );
      expect(await drive(run.id, services)).toBe('completed');

      const document = (await documentStore(OWNER).loadDocument(stageId))!;
      expect(elementsOf(document.scenes[0]).some((element) => element.type === 'image')).toBe(
        false,
      );
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({
        status: 'failed',
        errorCode: 'MEDIA_ELEMENT_REMOVED',
      });
      // Its bytes were released, and a Retry is refused.
      const assetsAfter = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM asset_entries',
      );
      expect(Number(assetsAfter.rows[0]!.n)).toBe(Number(assetsBefore.rows[0]!.n));
      await expect(
        retryGenerationRun(run.id, OWNER, {
          commandId: 'gone-2',
          media: { elementId: 'gen_img_1' },
        }),
      ).rejects.toMatchObject({ reason: 'media' });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ mediaPending: false });
    });

    it('a content refusal is final, and a paused run generates its media without retrying the scene', async () => {
      let sensitive = true;
      const { services, calls, media } = mediaServices({
        generateImage: async (_owner, input) => {
          media.image.push(input.request.elementId);
          if (sensitive) throw new Error('OutputImageSensitiveContentDetected');
          throw new Error('timeout talking to provider');
        },
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o3') throw new Error('content model down');
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('paused');
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({
        status: 'failed',
        errorCode: 'CONTENT_SENSITIVE',
      });
      await expect(
        retryGenerationRun(run.id, OWNER, { commandId: 'cs', media: { elementId: 'gen_img_1' } }),
      ).rejects.toMatchObject({ reason: 'media' });

      // A retryable failure on a paused run: only the media runs again.
      sensitive = false;
      await commitMediaFailure(run.id, 'gen_img_1', 'image');
      expect(
        await retryGenerationRun(run.id, OWNER, {
          commandId: 'p1',
          media: { elementId: 'gen_img_1' },
        }),
      ).toMatchObject({ state: 'paused' });
      const contentCalls = calls.sceneContent.length;
      expect(await drive(run.id, services)).toBe('paused');
      expect(calls.sceneContent).toHaveLength(contentCalls);
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'paused',
        step: 'scene:2:content',
        mediaPending: false,
      });
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({ status: 'failed' });
    });

    /** Record a retryable failure for an element (as a provider timeout leaves it). */
    async function commitMediaFailure(
      runId: string,
      elementId: string,
      mediaType: 'image' | 'video',
    ) {
      await pool.query(
        `UPDATE generation_run_steps SET output = $3::jsonb WHERE run_id = $1 AND step_id = $2`,
        [
          runId,
          `media:${elementId}`,
          JSON.stringify({
            mediaType,
            status: 'failed',
            message: `${mediaType} generation failed`,
          }),
        ],
      );
    }

    it('a takeover waits on the submitted video task instead of submitting it again', async () => {
      const submitted = gate();
      const never = gate();
      const dying = mediaServices({
        generateVideo: async (_owner, input) => {
          await input.onProviderTask(TASK);
          submitted.release();
          await never.promise;
          throw new Error('unreachable');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      const claimA = (await claim(run.id, 'worker-a')) as ClaimedRun;
      const abortA = new AbortController();
      const executionA = executeGenerationRun(claimA, {
        services: dying.services,
        signal: abortA.signal,
      });
      await submitted.promise;
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({
        mediaType: 'video',
        status: 'submitted',
        task: TASK,
      });
      // The process dies while the provider works on the video.
      abortA.abort();
      expect(await executionA).toBe('interrupted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const takeover = (await claim(run.id, 'worker-b', 1))!;
      expect(takeover).toMatchObject({ takeover: true });

      const resumed = mediaServices();
      expect(
        await executeGenerationRun(takeover, {
          services: resumed.services,
          signal: new AbortController().signal,
        }),
      ).toBe('completed');
      // One submission in all: B resumed the wait on A's task.
      expect(resumed.media.video).toEqual([{ resume: TASK }]);
      // The image A had stored was not generated again.
      expect(resumed.media.image).toEqual([]);
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'done' });
      never.release();
    });

    it('places bytes a dead worker stored without generating them again', async () => {
      const blocked = gate();
      const reached = gate();
      const first = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o2') {
            reached.release();
            await blocked.promise;
          }
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
        // The worker dies right after storing (before the image reaches the scene).
        generateImage: async () => {
          throw new Error('not in this execution');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      const claimA = (await claim(run.id, 'worker-a')) as ClaimedRun;
      const abortA = new AbortController();
      const executionA = executeGenerationRun(claimA, {
        services: first.services,
        signal: abortA.signal,
      });
      await reached.promise;
      // Simulate the crash window: the bytes and their checkpoint committed together.
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      const stored = await storeGeneratedAsset({
        ownerId: OWNER,
        stageId,
        bytes: IMAGE_BYTES,
        mimeType: 'image/png',
        kind: 'image',
        afterPut: async (tx, assetId) => {
          await tx.query(
            `UPDATE generation_run_steps SET output = $3::jsonb WHERE run_id = $1 AND step_id = $2`,
            [
              run.id,
              'media:gen_img_1',
              JSON.stringify({ mediaType: 'image', status: 'stored', assetId }),
            ],
          );
        },
      });
      abortA.abort();
      blocked.release();
      expect(await executionA).toBe('interrupted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const takeover = (await claim(run.id, 'worker-b', 1))!;
      const resumed = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
      });
      expect(
        await executeGenerationRun(takeover, {
          services: resumed.services,
          signal: new AbortController().signal,
        }),
      ).toBe('completed');
      expect(resumed.media.image).toEqual([]);
      const assetId = (stored as { assetId: string }).assetId;
      const document = (await documentStore(OWNER).loadDocument(stageId))!;
      expect(elementsOf(document.scenes[0]).find((element) => element.type === 'image')!.src).toBe(
        assetId,
      );
      expect(await committedAt(assetId)).not.toBeNull();
    });

    it('a video whose connection changed fails, and Retry submits a new task', async () => {
      const first = mediaServices({
        generateVideo: async (_owner, input) => {
          if (input.resume) {
            throw new StepRefusal('task-connection-changed', 'The video slot changed');
          }
          await input.onProviderTask(TASK);
          throw new Error('poll budget');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, first.services)).toBe('completed');
      // Make it the case a takeover meets: a submitted task, resumed on another connection.
      await pool.query(
        `UPDATE generation_run_steps SET output = $3::jsonb WHERE run_id = $1 AND step_id = $2`,
        [
          run.id,
          'media:gen_vid_1',
          JSON.stringify({ mediaType: 'video', status: 'submitted', task: TASK }),
        ],
      );
      await pool.query('UPDATE generation_runs SET media_pending = true WHERE id = $1', [run.id]);
      expect(await drive(run.id, first.services)).toBe('completed');
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({
        mediaType: 'video',
        status: 'failed',
        message: 'The video slot changed',
        errorCode: 'TASK_CONNECTION_CHANGED',
      });
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'v1',
        media: { elementId: 'gen_vid_1' },
      });
      const second = mediaServices();
      expect(await drive(run.id, second.services)).toBe('completed');
      expect(second.media.video).toEqual([{ resume: undefined }]);
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'done' });
    });

    it('stores material images as course assets and generates with them by id', async () => {
      const outlineInputs: unknown[] = [];
      const contentInputs: Array<Record<string, unknown>> = [];
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: { status: 'off' }, video: { status: 'off' } }),
        analyzeMaterials: async () => ({
          text: 'material text [img_1]',
          images: [
            {
              id: 'img_1',
              pageNumber: 2,
              description: 'A chloroplast',
              width: 640,
              height: 480,
              visionPriority: 1,
              bytes: IMAGE_BYTES,
              mimeType: 'image/png',
            },
          ],
        }),
        outline: async (_owner, input) => {
          outlineInputs.push(input);
          return {
            outlines: OUTLINES.map((outline, index) =>
              index === 0 ? { ...outline, suggestedImageIds: ['img_1'] } : outline,
            ),
            languageDirective: 'Use English.',
            courseTitle: 'Plants',
            taskEngineMode: false,
          };
        },
        sceneContent: async (owner, input, ctx) => {
          contentInputs.push(input as never);
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
        sceneActions: async (_owner, input) => {
          // The content step resolves `img_1` through the mapping it was given.
          const mapping = contentInputs.at(-1)!.imageMapping as Record<string, string>;
          const imageSrc = input.outline.id === 'o1' ? mapping.img_1 : undefined;
          return {
            scene: mediaScene(input.stageId, input.outline, imageSrc) as never,
            previousSpeeches: [],
          };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto', materialIds: ['mat-1'] }));
      expect(await drive(run.id, services)).toBe('completed');

      const material = (await readGenerationRunSteps(run.id)).get('material-analysis') as {
        pdfImages: Array<Record<string, unknown>>;
        imageMapping: Record<string, string>;
        stageId: string;
      };
      const assetId = material.imageMapping.img_1!;
      expect(assetId).toMatch(/^ast_/);
      expect(material.pdfImages).toEqual([
        {
          id: 'img_1',
          src: '',
          assetId,
          pageNumber: 2,
          description: 'A chloroplast',
          width: 640,
          height: 480,
          visionPriority: 1,
        },
      ]);
      expect(outlineInputs[0]).toMatchObject({
        pdfText: 'material text [img_1]',
        pdfImages: material.pdfImages,
        imageMapping: { img_1: assetId },
      });
      for (const input of contentInputs) {
        expect(input).toMatchObject({
          pdfImages: material.pdfImages,
          imageMapping: { img_1: assetId },
        });
      }
      const stored = (await readGenerationRun(run.id, OWNER))!;
      // The course is the one the images were stored for, and its write committed them.
      expect(stored.stageId).toBe(material.stageId);
      const document = (await documentStore(OWNER).loadDocument(stored.stageId!))!;
      expect(
        elementsOf(document.scenes[0]).find((element) => element.id === 'el-material')!.src,
      ).toBe(assetId);
      expect(await committedAt(assetId)).not.toBeNull();
      // No image bytes travel in the checkpoints.
      const raw = await pool.query<{ output: string }>(
        'SELECT output::text AS output FROM generation_run_steps WHERE run_id = $1',
        [run.id],
      );
      expect(raw.rows.some((row) => row.output.includes('base64'))).toBe(false);
    });

    it('a slot the route refuses fails its items with the route code; a fault of the pass fails the media, not the run', async () => {
      const refused = mediaServices({
        mediaConnections: async () => ({
          image: { status: 'refused', message: 'endpoint not allowed', errorCode: 'INVALID_URL' },
          video: OFF,
        }),
      });
      const first = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(first.id, refused.services)).toBe('completed');
      expect((await mediaOf(first.id)).gen_img_1).toEqual({
        mediaType: 'image',
        status: 'failed',
        message: 'endpoint not allowed',
        errorCode: 'INVALID_URL',
      });

      const broken = mediaServices({
        mediaConnections: async () => {
          throw new Error('model configuration unreadable');
        },
      });
      const second = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(second.id, broken.services)).toBe('completed');
      expect(await mediaOf(second.id)).toEqual({
        gen_img_1: { mediaType: 'image', status: 'failed', message: 'Image generation failed' },
        gen_vid_1: { mediaType: 'video', status: 'failed', message: 'Video generation failed' },
      });
      expect(await readGenerationRun(second.id, OWNER)).toMatchObject({
        state: 'completed',
        mediaPending: false,
      });
    });

    it('a failed video lets go of its task: Retry submits a new one, as the browser does', async () => {
      let attempt = 0;
      const submissions: unknown[] = [];
      const { services } = mediaServices({
        generateVideo: async (_owner, input) => {
          attempt += 1;
          expect(input.resume).toBeUndefined();
          submissions.push(input.request.elementId);
          await input.onProviderTask({ ...TASK, taskId: `task-${attempt}` });
          if (attempt === 1) throw new Error('Seedance video generation timed out after 300s');
          return { video: { bytes: VIDEO_BYTES, mimeType: 'video/mp4' } };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({
        mediaType: 'video',
        status: 'failed',
        message: 'Video generation failed',
      });
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'v-a',
        media: { elementId: 'gen_vid_1' },
      });
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({ mediaType: 'video', status: 'queued' });
      expect(await drive(run.id, services)).toBe('completed');
      expect(submissions).toHaveLength(2);
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'done' });
    });

    it('keeps bytes stored when placing them into a completed course fails, and places them later', async () => {
      // The same image is asked for on two slides.
      const twice = MEDIA_OUTLINES.map((outline, index) =>
        index === 2
          ? { ...outline, mediaGenerations: MEDIA_OUTLINES[0]!.mediaGenerations }
          : outline,
      );
      let failImage = true;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        outline: async () => ({
          outlines: twice,
          languageDirective: 'Use English.',
          courseTitle: 'Plants',
          taskEngineMode: false,
        }),
        generateImage: async (_owner, input) => {
          media.image.push(input.request.elementId);
          if (failImage) throw new Error('provider down');
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      failImage = false;
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'p1',
        media: { elementId: 'gen_img_1' },
      });
      // The first scene is written; the write of the second fails (a passing fault).
      let writes = 0;
      completionHooks.beforeMutate = async () => {
        writes += 1;
        if (writes === 2) throw new Error('connection reset');
      };
      try {
        expect(await drive(run.id, services)).toBe('completed');
      } finally {
        completionHooks.beforeMutate = undefined;
      }
      const stored = (await mediaOf(run.id)).gen_img_1!;
      expect(stored).toMatchObject({ mediaType: 'image', status: 'stored' });
      let document = (await documentStore(OWNER).loadDocument(stageId))!;
      expect(elementsOf(document.scenes[0]).find((element) => element.type === 'image')!.src).toBe(
        stored.assetId,
      );
      expect(elementsOf(document.scenes[2]).find((element) => element.type === 'image')!.src).toBe(
        'gen_img_1',
      );
      // Still owed: the next claim places the rest, without generating again.
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'completed',
        mediaPending: true,
      });
      expect(await drive(run.id, services)).toBe('completed');
      expect(media.image).toEqual(['gen_img_1', 'gen_img_1']);
      document = (await documentStore(OWNER).loadDocument(stageId))!;
      for (const index of [0, 2]) {
        expect(
          elementsOf(document.scenes[index]).find((element) => element.type === 'image')!.src,
        ).toBe(stored.assetId);
      }
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({
        status: 'done',
        assetId: stored.assetId,
      });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ mediaPending: false });
    });

    it('stops placing bytes whose placement keeps failing: the item fails with a Retry', async () => {
      let failImage = true;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        generateImage: async (_owner, input) => {
          media.image.push(input.request.elementId);
          if (failImage) throw new Error('provider down');
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      failImage = false;
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'cap',
        media: { elementId: 'gen_img_1' },
      });
      completionHooks.beforeMutate = async () => {
        throw new Error('scene writes keep failing');
      };
      let assetId = '';
      try {
        for (const failures of [1, 2]) {
          expect(await drive(run.id, services)).toBe('completed');
          const stored = (await mediaOf(run.id)).gen_img_1!;
          expect(stored).toMatchObject({ status: 'stored', placementFailures: failures });
          assetId = stored.assetId as string;
          expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ mediaPending: true });
        }
        expect(await drive(run.id, services)).toBe('completed');
      } finally {
        completionHooks.beforeMutate = undefined;
      }
      // Generated once; placed never; failed with a Retry, its bytes released.
      expect(media.image).toEqual(['gen_img_1', 'gen_img_1']);
      expect((await mediaOf(run.id)).gen_img_1).toEqual({
        mediaType: 'image',
        status: 'failed',
        message: 'The image could not be placed in the course',
        errorCode: 'MEDIA_PLACEMENT_FAILED',
      });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ mediaPending: false });
      expect(await claim(run.id)).toBeNull();
      expect(
        (await pool.query('SELECT 1 FROM asset_entries WHERE id = $1', [assetId])).rows,
      ).toEqual([]);
      // A Retry generates it again and places it.
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'cap-2',
        media: { elementId: 'gen_img_1' },
      });
      expect(await drive(run.id, services)).toBe('completed');
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({ status: 'done' });
    });

    it('fails stored bytes loud when they are gone before they are placed', async () => {
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        generateImage: async () => {
          throw new Error('provider down');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      // A takeover finds bytes stored whose entry is gone.
      await pool.query(
        `UPDATE generation_run_steps SET output = $3::jsonb WHERE run_id = $1 AND step_id = $2`,
        [
          run.id,
          'media:gen_img_1',
          JSON.stringify({ mediaType: 'image', status: 'stored', assetId: 'ast_gone' }),
        ],
      );
      await pool.query('UPDATE generation_runs SET media_pending = true WHERE id = $1', [run.id]);
      expect(await drive(run.id, services)).toBe('completed');
      expect((await mediaOf(run.id)).gen_img_1).toEqual({
        mediaType: 'image',
        status: 'failed',
        message: 'The stored image was gone before it was placed',
      });
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      const document = (await documentStore(OWNER).loadDocument(stageId))!;
      expect(elementsOf(document.scenes[0]).find((element) => element.type === 'image')!.src).toBe(
        'gen_img_1',
      );
    });

    it('releases what a run held when its course is deleted', async () => {
      const blocked = gate();
      const reached = gate();
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: OFF }),
        analyzeMaterials: async () => ({
          text: 'material text',
          images: [{ id: 'img_1', pageNumber: 1, bytes: IMAGE_BYTES, mimeType: 'image/png' }],
        }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o2') {
            reached.release();
            await blocked.promise;
          }
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
      });
      const run = await start(runInput({ outlineReview: 'auto', materialIds: ['mat-1'] }));
      const execution = drive(run.id, services);
      await reached.promise;
      const assetId = (
        (await readGenerationRunSteps(run.id)).get('material-analysis') as {
          imageMapping: Record<string, string>;
        }
      ).imageMapping.img_1!;
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      await documentStore(OWNER).deleteDocument(stageId);
      const expiry = await pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM asset_entries WHERE id = $1',
        [assetId],
      );
      expect(expiry.rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      blocked.release();
      expect(await execution).toBe('interrupted');
    });

    it('finds the runs producing a course through the stage index', async () => {
      const run = await start();
      await pool.query("UPDATE generation_runs SET stage_id = 'stage-explain' WHERE id = $1", [
        run.id,
      ]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        for (const sql of [
          // The read-only guard's lookup.
          `SELECT id FROM generation_runs WHERE stage_id = $1 AND id IS DISTINCT FROM $2
              AND state NOT IN ('completed', 'ended') LIMIT 1`,
          // The deletion's.
          `SELECT id FROM generation_runs WHERE stage_id = $1
              AND (state NOT IN ('completed', 'ended') OR (state = 'completed' AND media_pending))`,
        ]) {
          const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [
            'stage-explain',
            ...(sql.includes('$2') ? [null] : []),
          ]);
          expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
            'generation_runs_stage_active_idx',
          );
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('a paused run goes on with its video after the pause, and a step Retry meanwhile takes no lease', async () => {
      const submitted = gate();
      const releaseVideo = gate();
      let failScene = true;
      let lastSceneAfterRetry = 0;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: ready('seedance') }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o3' && !failScene) lastSceneAfterRetry += 1;
          if (input.outline.id === 'o3' && failScene) {
            await submitted.promise;
            throw new Error('content model down');
          }
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
        generateVideo: async (_owner, input, ctx) => {
          media.video.push({ resume: input.resume });
          if (!input.resume) {
            await input.onProviderTask(TASK);
            submitted.release();
            // Waits until the pause aborts the wait.
            await new Promise((_, reject) =>
              ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), {
                once: true,
              }),
            );
          }
          await releaseVideo.promise;
          return { video: { bytes: VIDEO_BYTES, mimeType: 'video/mp4' } };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('paused');
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({
        mediaType: 'video',
        status: 'submitted',
        task: TASK,
      });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'paused',
        mediaPending: true,
        leaseWorkerId: null,
      });

      // Claimed for its media alone; a step Retry arrives while the video waits.
      const claimed = (await claim(run.id, 'worker-m'))!;
      const execution = executeGenerationRun(claimed, {
        services,
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(media.video).toHaveLength(2));
      failScene = false;
      await retryGenerationRun(run.id, OWNER, { commandId: 'step' });
      // The lease stays with the worker generating the video.
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'generating',
        leaseWorkerId: 'worker-m',
      });
      expect(await claim(run.id, 'worker-n')).toBeNull();
      releaseVideo.release();
      // That worker goes on with the run once its media is done.
      expect(await execution).toBe('completed');
      expect(media.video).toEqual([{ resume: undefined }, { resume: TASK }]);
      expect(lastSceneAfterRetry).toBe(1);
      expect((await mediaOf(run.id)).gen_vid_1).toMatchObject({ status: 'done' });
    });

    it('fails the media of a paused or completed run whose workers keep dying', async () => {
      const { services } = mediaServices({
        generateImage: async () => {
          throw new Error('provider down');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'dies',
        media: { elementId: 'gen_img_1' },
      });
      expect(await claim(run.id, 'worker-a')).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await claimNextGenerationRun('worker-b', { leaseTtlMs: 1, maxTakeovers: 0, runId: run.id }),
      ).toBeNull();
      expect((await mediaOf(run.id)).gen_img_1).toEqual({
        mediaType: 'image',
        status: 'failed',
        message: 'The media generation was interrupted too many times',
      });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'completed',
        mediaPending: false,
        leaseWorkerId: null,
      });
    });

    it('generates media a Retry queued while the run was completing before it completes', async () => {
      let failImage = true;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        generateImage: async (_owner, input) => {
          media.image.push(input.request.elementId);
          if (failImage) throw new Error('provider down');
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      // The Retry lands after the pass settled, inside the completion window.
      completionHooks.before = async () => {
        completionHooks.before = undefined;
        failImage = false;
        await retryGenerationRun(run.id, OWNER, {
          commandId: 'race',
          media: { elementId: 'gen_img_1' },
        });
      };
      expect(await drive(run.id, services)).toBe('completed');
      expect(media.image).toEqual(['gen_img_1', 'gen_img_1']);
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({ status: 'done' });
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({ mediaPending: false });
    });

    it('fails a held image loud when its bytes are gone before its scene is written', async () => {
      const stored = gate();
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: ready('seedance') }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o2') await stored.promise;
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      const execution = drive(run.id, services);
      await vi.waitFor(async () => {
        const video = (await mediaOf(run.id)).gen_vid_1;
        expect(video?.status).toBe('stored');
      });
      // The pool lost the held bytes.
      const assetId = (await mediaOf(run.id)).gen_vid_1!.assetId as string;
      await pool.query('DELETE FROM asset_entries WHERE id = $1', [assetId]);
      stored.release();
      expect(await execution).toBe('completed');
      expect((await mediaOf(run.id)).gen_vid_1).toEqual({
        mediaType: 'video',
        status: 'failed',
        message: 'The stored video was gone before its scene was written',
      });
      const document = (await documentStore(OWNER).loadDocument(
        (await readGenerationRun(run.id, OWNER))!.stageId!,
      ))!;
      expect(
        elementsOf(document.scenes[1]).find((element) => element.type === 'video')!.mediaRef,
      ).toBe('gen_vid_1');
    });

    it('deleting a completed course whose media is being retried ends the run', async () => {
      const { services } = mediaServices({
        generateImage: async () => {
          throw new Error('provider down');
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      await retryGenerationRun(run.id, OWNER, {
        commandId: 'del',
        media: { elementId: 'gen_img_1' },
      });
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      await documentStore(OWNER).deleteDocument(stageId);
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'ended',
        mediaPending: false,
      });
      expect(await claim(run.id)).toBeNull();
    });

    it('places into every scene that holds the placeholder, resuming after a crash in between', async () => {
      // The same image is asked for on two slides.
      const twice = MEDIA_OUTLINES.map((outline, index) =>
        index === 2
          ? { ...outline, mediaGenerations: MEDIA_OUTLINES[0]!.mediaGenerations }
          : outline,
      );
      let failImage = true;
      const { services, media } = mediaServices({
        mediaConnections: async () => ({ image: ready('seedream'), video: OFF }),
        outline: async () => ({
          outlines: twice,
          languageDirective: 'Use English.',
          courseTitle: 'Plants',
          taskEngineMode: false,
        }),
        generateImage: async () => {
          if (failImage) throw new Error('provider down');
          return { bytes: IMAGE_BYTES, mimeType: 'image/png' };
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      expect(await drive(run.id, services)).toBe('completed');
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      // The state a crash between the two scene writes leaves: bytes stored,
      // the first slide written, the third still holding the placeholder.
      const kept = await storeGeneratedAsset({
        ownerId: OWNER,
        stageId,
        bytes: IMAGE_BYTES,
        mimeType: 'image/png',
        kind: 'image',
      });
      const assetId = (kept as { assetId: string }).assetId;
      const first = (await documentStore(OWNER).loadDocument(stageId))!.scenes[0]!;
      for (const element of elementsOf(first)) if (element.type === 'image') element.src = assetId;
      await pool.query('UPDATE generation_runs SET media_pending = true WHERE id = $1', [run.id]);
      await documentStore(OWNER).putScene(stageId, first);
      await pool.query(
        `UPDATE generation_run_steps SET output = $3::jsonb WHERE run_id = $1 AND step_id = $2`,
        [
          run.id,
          'media:gen_img_1',
          JSON.stringify({ mediaType: 'image', status: 'stored', assetId }),
        ],
      );
      failImage = false;
      expect(await drive(run.id, services)).toBe('completed');
      expect(media.image).toEqual([]);
      const document = (await documentStore(OWNER).loadDocument(stageId))!;
      for (const index of [0, 2]) {
        expect(
          elementsOf(document.scenes[index]).find((element) => element.type === 'image')!.src,
        ).toBe(assetId);
      }
      expect((await mediaOf(run.id)).gen_img_1).toMatchObject({ status: 'done', assetId });
    });

    it('keeps the allocations a live run holds from expiring, and releases them when it ends', async () => {
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: OFF }),
        analyzeMaterials: async () => ({
          text: 'material text',
          images: [{ id: 'img_1', pageNumber: 1, bytes: IMAGE_BYTES, mimeType: 'image/png' }],
        }),
      });
      const run = await start(runInput({ materialIds: ['mat-1'] }));
      expect(await drive(run.id, services)).toBe('waiting');
      const material = (await readGenerationRunSteps(run.id)).get('material-analysis') as {
        imageMapping: Record<string, string>;
      };
      const assetId = material.imageMapping.img_1!;
      const expiry = async () =>
        (
          await pool.query<{ expires_at: Date | null }>(
            'SELECT expires_at FROM asset_entries WHERE id = $1',
            [assetId],
          )
        ).rows[0]?.expires_at ?? null;
      await pool.query(
        "UPDATE asset_entries SET expires_at = now() + interval '1 minute' WHERE id = $1",
        [assetId],
      );
      expect(await keepGenerationRunAssetsAlive(48 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
      expect((await expiry())!.getTime()).toBeGreaterThan(Date.now() + 47 * 60 * 60 * 1000);
      // Discarding the run releases what it held.
      await discardGenerationRun(run.id, OWNER);
      expect((await expiry())!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('fails the scene loud when a material image it is assigned is gone', async () => {
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: OFF }),
        analyzeMaterials: async () => ({
          text: 'material text',
          images: [{ id: 'img_1', pageNumber: 1, bytes: IMAGE_BYTES, mimeType: 'image/png' }],
        }),
        outline: async () => ({
          outlines: OUTLINES.map((outline, index) =>
            index === 0 ? { ...outline, suggestedImageIds: ['img_1'] } : outline,
          ),
          languageDirective: 'Use English.',
          courseTitle: 'Plants',
          taskEngineMode: false,
        }),
        // The production content service, whose image check is under test.
        sceneContent: (owner, input, ctx) => defaultRunStepServices.sceneContent(owner, input, ctx),
      });
      const run = await start(runInput({ outlineReview: 'auto', materialIds: ['mat-1'] }));
      const material = async () =>
        (await readGenerationRunSteps(run.id)).get('material-analysis') as
          | { imageMapping: Record<string, string> }
          | undefined;
      // Lose the image once the analysis stored it.
      const claimed = (await claim(run.id))!;
      const execution = executeGenerationRun(claimed, {
        services: {
          ...services,
          research: async () => {
            const assetId = (await material())!.imageMapping.img_1!;
            await pool.query('DELETE FROM asset_entries WHERE id = $1', [assetId]);
            return null;
          },
        },
        signal: new AbortController().signal,
      });
      expect(await execution).toBe('paused');
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'paused',
        step: 'scene:0:content',
        error: { message: 'The material image img_1 is no longer stored' },
      });
    });

    it('generation-complete answers 409 while the run produces the course', async () => {
      const blocked = gate();
      const reached = gate();
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: OFF, video: OFF }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o3') {
            reached.release();
            await blocked.promise;
          }
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      const execution = drive(run.id, services);
      await reached.promise;
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      const route = await import('@/app/api/stages/[id]/generation-complete/route');
      const mark = () =>
        route.POST(
          new NextRequest(`http://localhost/api/stages/${stageId}/generation-complete`, {
            method: 'POST',
            headers: cookie(OWNER_COOKIE),
          }),
          { params: Promise.resolve({ id: stageId }) },
        );
      const refused = await mark();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'COURSE_GENERATING' } });
      blocked.release();
      expect(await execution).toBe('completed');
      expect((await mark()).status).toBe(200);
    });

    it('keeps the course read-only to every other writer until its run completes', async () => {
      const blocked = gate();
      const reached = gate();
      const { services } = mediaServices({
        mediaConnections: async () => ({ image: { status: 'off' }, video: { status: 'off' } }),
        sceneContent: async (owner, input, ctx) => {
          if (input.outline.id === 'o3') {
            reached.release();
            await blocked.promise;
          }
          return fakeServices().services.sceneContent(owner, input, ctx);
        },
      });
      const run = await start(runInput({ outlineReview: 'auto' }));
      const execution = drive(run.id, services);
      await reached.promise;
      const stageId = (await readGenerationRun(run.id, OWNER))!.stageId!;
      const editor = documentStore(OWNER);
      const document = (await editor.loadDocument(stageId))!;

      // The classroom editor's whole-document save, through the route.
      const stages = await import('@/app/api/stages/[id]/route');
      const save = () =>
        stages.PUT(
          new NextRequest(`http://localhost/api/stages/${stageId}`, {
            method: 'PUT',
            headers: { ...cookie(OWNER_COOKIE), 'content-type': 'application/json' },
            body: JSON.stringify(document),
          }),
          { params: Promise.resolve({ id: stageId }) },
        );
      const refused = await save();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'COURSE_GENERATING' } });
      // Every content write of the store, and the Pro agent's background store.
      await expect(editor.putScene(stageId, document.scenes[0]!)).rejects.toMatchObject({
        code: 'COURSE_GENERATING',
      });
      await expect(editor.putStage(stageId, document.stage)).rejects.toMatchObject({
        code: 'COURSE_GENERATING',
      });
      await expect(editor.deleteScene(stageId, document.scenes[0]!.id)).rejects.toMatchObject({
        code: 'COURSE_GENERATING',
      });
      const { getBackgroundDocumentStore } =
        await import('@/lib/server/agent-runtime/owner-scoped-documents');
      const agent = await getBackgroundDocumentStore(OWNER);
      await expect(agent.putScene(stageId, document.scenes[0]!)).rejects.toMatchObject({
        code: 'COURSE_GENERATING',
      });
      // Library organization is not a content write.
      await (
        editor as unknown as { setStageFolder(id: string, folder: string | null): Promise<boolean> }
      ).setStageFolder(stageId, null);

      blocked.release();
      expect(await execution).toBe('completed');
      expect((await save()).status).toBe(200);
      await agent.putScene(stageId, (await editor.loadDocument(stageId))!.scenes[0]!);
    });
  });

  describe('the runner', () => {
    beforeEach(async () => {
      // A runner claims any executable run: leave it only the test's own
      // (the read first provisions the run tables when this block runs alone).
      await listActiveGenerationRuns(OWNER);
      await pool.query(
        `UPDATE generation_runs SET state = 'ended', lease_worker_id = NULL
          WHERE state IN ('preparing', 'outlining', 'generating')`,
      );
      await pool.query('UPDATE generation_runs SET media_pending = false');
    });

    /** An outline step that runs until its signal aborts. */
    function blockingServices() {
      const started = gate();
      const aborted = gate();
      const { services } = fakeServices({
        research: async () => null,
        outline: (_owner, _input, ctx) =>
          new Promise((_resolve, reject) => {
            started.release();
            ctx.signal!.addEventListener('abort', () => {
              aborted.release();
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      });
      return { services, started, aborted };
    }

    it('keeps the allocations of live runs alive while it runs', async () => {
      const { services } = fakeServices({
        research: async () => null,
        analyzeMaterials: async () => ({
          text: 'material text',
          images: [{ id: 'img_1', pageNumber: 1, bytes: CLIP, mimeType: 'image/png' }],
        }),
      });
      const run = await start(runInput({ materialIds: ['mat-1'] }));
      expect(await drive(run.id, services)).toBe('waiting');
      const assetId = (
        (await readGenerationRunSteps(run.id)).get('material-analysis') as {
          imageMapping: Record<string, string>;
        }
      ).imageMapping.img_1!;
      await pool.query(
        "UPDATE asset_entries SET expires_at = now() + interval '1 minute' WHERE id = $1",
        [assetId],
      );
      const runner = startGenerationRunner({
        services,
        workerId: 'keepalive',
        config: { scanIntervalMs: 60_000 },
      });
      try {
        await vi.waitFor(async () => {
          const row = await pool.query<{ expires_at: Date }>(
            'SELECT expires_at FROM asset_entries WHERE id = $1',
            [assetId],
          );
          expect(row.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
        });
      } finally {
        await runner.stop();
      }
    });

    it('stops without a lease-lost warning when the run was ended on purpose', async () => {
      const { services, started, aborted } = blockingServices();
      const run = await start();
      const claimed = (await claim(run.id, 'worker-a'))!;
      const warn = vi.spyOn(console, 'warn');
      const log = vi.spyOn(console, 'log');
      try {
        const execution = runClaimedGenerationRun(claimed, services, new AbortController(), 20);
        await started.promise;
        // Discarding the pending course ends the run and takes its lease.
        expect(await discardGenerationRun(run.id, OWNER)).toMatchObject({ state: 'ended' });
        await aborted.promise;
        expect(await execution).toBe('interrupted');
        await new Promise((resolve) => setTimeout(resolve, 50));
        const messages = (spy: typeof warn) => spy.mock.calls.map((call) => call.join(' '));
        expect(messages(warn).some((message) => message.includes('lease lost'))).toBe(false);
        expect(
          messages(log).some((message) => message.includes('ended (its course was deleted)')),
        ).toBe(true);
      } finally {
        warn.mockRestore();
        log.mockRestore();
      }
    });

    it('aborts a local execution once its heartbeat finds the lease gone', async () => {
      const { services, started, aborted } = blockingServices();
      const run = await start();
      const claimed = (await claim(run.id, 'worker-a'))!;
      const execution = runClaimedGenerationRun(claimed, services, new AbortController(), 20);
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Another worker takes the run over; A's next heartbeat notices.
      let takenOver = null;
      for (let attempt = 0; !takenOver && attempt < 100; attempt += 1) {
        takenOver = await claim(run.id, 'worker-b', 1);
        if (!takenOver) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(takenOver).not.toBeNull();
      await aborted.promise;
      expect(await execution).toBe('interrupted');
    });

    it('releases its leases when it stops, without counting a takeover', async () => {
      const { services, started, aborted } = blockingServices();
      const run = await start();
      const runner = startGenerationRunner({
        services,
        workerId: 'runner-stop',
        config: {
          scanIntervalMs: 20,
          heartbeatIntervalMs: 50,
          leaseTtlMs: 60_000,
          maxConcurrent: 1,
        },
      });
      await started.promise;
      expect((await readGenerationRun(run.id, OWNER))!.leaseWorkerId).toBe('runner-stop');
      await runner.stop({ timeoutMs: 5_000 });
      await aborted.promise;
      expect(await readGenerationRun(run.id, OWNER)).toMatchObject({
        state: 'outlining',
        leaseWorkerId: null,
        takeovers: 0,
      });
    });

    it('hands back a claim of a run it still executes under a stale lease, uncounted', async () => {
      const { services, started, aborted } = blockingServices();
      const run = await start();
      // A heartbeat that never fires within the test, and a lease that only
      // goes stale once the execution is under way (set below). Two slots, so
      // a scan may claim while the first execution still runs: the race.
      const runner = startGenerationRunner({
        services,
        workerId: 'runner-race',
        config: {
          scanIntervalMs: 20,
          heartbeatIntervalMs: 60_000,
          leaseTtlMs: 60_000,
          maxConcurrent: 2,
        },
      });
      try {
        await started.promise;
        await pool.query('UPDATE generation_runs SET lease_heartbeat_at = 0 WHERE id = $1', [
          run.id,
        ]);
        // The next scan claims the run it still executes: it aborts the stale
        // execution and hands the claim back rather than running it twice.
        await aborted.promise;
        const stored = (await readGenerationRun(run.id, OWNER))!;
        expect(stored.leaseGeneration).toBeGreaterThan(1);
      } finally {
        await runner.stop({ timeoutMs: 5_000 });
      }
      expect((await readGenerationRun(run.id, OWNER))!).toMatchObject({
        leaseWorkerId: null,
        takeovers: 0,
      });
    }, 30_000);
  });
});
