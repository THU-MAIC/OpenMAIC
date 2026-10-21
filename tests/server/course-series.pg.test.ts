/**
 * The course-series flow end to end on PostgreSQL: a run whose material is
 * over one course's budget is promoted to a series' first part mid
 * material-analysis, and completing a part automatically starts the next
 * one, until none are left. The engine's step services are faked (as in
 * `generation-runs.pg.test.ts`); the run store, the series table and the
 * engine's own completion path are real.
 */
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCourseSeries } from '@/lib/persistence/course-series';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { stopAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import { executeGenerationRun } from '@/lib/server/generation/run/engine';
import { defaultRunStepServices, type RunStepServices } from '@/lib/server/generation/run/services';
import {
  claimNextGenerationRun,
  createGenerationRun,
  listGenerationRunsUpdatedSince,
  readGenerationRun,
  resetGenerationRunSchemaForTests,
  type StoredRun,
} from '@/lib/server/generation/run/store';
import type { GenerationRunInput } from '@/lib/server/generation/run/types';
import {
  resetCourseSeriesSchemaForTests,
  resumeStalledCourseSeries,
  startCourseSeries,
  startNextSeriesPart,
  type SeriesSplitPlan,
} from '@/lib/server/generation/series/orchestrator';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_course_series_test';
const OWNER_COOKIE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e';
const OWNER = `anon:${OWNER_COOKIE}`;
const MATERIAL_ID = 'material-1';

const OUTLINES: SceneOutline[] = [
  { id: 'o1', type: 'slide', title: 'Intro', description: 'Why', keyPoints: ['a'], order: 1 },
];

const UNTIL = { timeout: 25_000, interval: 20 };

function cookie(value: string) {
  return { cookie: `anonymous_id=${value}` };
}

/** A single-scene course, enough to drive a run through to `completed`. */
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

/** A two-part plan: part 1 is this run's own, part 2 the only pending one. */
function twoPartPlan(): SeriesSplitPlan {
  return {
    firstPart: { order: 1, textRanges: { [MATERIAL_ID]: { start: 0, end: 500 } } },
    restParts: [{ order: 2, textRanges: { [MATERIAL_ID]: { start: 500, end: 1000 } } }],
  };
}

/**
 * Step fakes for a single-scene, no-outline-wait run (`outlineReview:
 * 'auto'` on every input in this file, so a part never stalls waiting for a
 * confirmation nobody sees). `plan` is what `planMaterialSeries` answers; a
 * series part's own run always gets `null` passed in here, mirroring the
 * engine's own guard that only asks a run not already a series part.
 */
function fakeServices(plan: SeriesSplitPlan | null) {
  const analyzed: Array<{ materialIds: string[]; textRanges: unknown }> = [];
  const services: RunStepServices = {
    materialKinds: async (_owner, materialIds) => materialIds.map(() => 'document' as const),
    materialsReady: async () => true,
    planMaterialSeries: async () => plan,
    analyzeMaterials: async (_owner, materialIds, _ctx, textRanges) => {
      analyzed.push({ materialIds, textRanges });
      return { text: 'material text', images: [] };
    },
    research: async () => null,
    outline: async () => ({
      outlines: OUTLINES,
      languageDirective: 'Use English.',
      courseTitle: 'Plants',
      taskEngineMode: false,
    }),
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
    ],
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
    sceneContent: async (_owner, input) => ({
      content: { elements: [], remark: input.outline.title } as never,
      effectiveOutline: input.outline,
    }),
    sceneActions: async (_owner, input) => ({
      scene: slideScene(input.stageId, input.outline) as never,
      previousSpeeches: [`Say ${input.outline.title}`],
    }),
    narrationTarget: async () => ({
      connection: {
        providerId: 'openai-tts',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      } as never,
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
    }),
    narrateClip: async () => null,
    releaseAssets: async (owner, ids, ctx) => defaultRunStepServices.releaseAssets(owner, ids, ctx),
    mediaConnections: async () => ({ image: { status: 'off' }, video: { status: 'off' } }),
    generateImage: async () => {
      throw new Error('no image slot in this test');
    },
    generateVideo: async () => {
      throw new Error('no video slot in this test');
    },
    parallelSceneConcurrency: () => 0,
    sleep: async () => undefined,
  };
  return { services, analyzed };
}

function runInput(overrides: Partial<GenerationRunInput> = {}): GenerationRunInput {
  return {
    requirement: 'Teach a very long chapter',
    materialIds: [MATERIAL_ID],
    interactive: false,
    taskEngine: false,
    agents: { mode: 'auto' },
    learnerProfile: { nickname: 'Sam', bio: 'Grade 8' },
    outlineReview: 'auto',
    ...overrides,
  };
}

function threePartPlan(): SeriesSplitPlan {
  return {
    firstPart: { order: 1, textRanges: { [MATERIAL_ID]: { start: 0, end: 400 } } },
    restParts: [
      { order: 2, textRanges: { [MATERIAL_ID]: { start: 400, end: 800 } } },
      { order: 3, textRanges: { [MATERIAL_ID]: { start: 800, end: 1200 } } },
    ],
  };
}

const CONTINUATION_LIMITS = { maxActiveRunsPerOwner: 50, maxWaitingRunsPerOwner: 50 };

function continuationBase(input: GenerationRunInput) {
  return {
    requirement: input.requirement,
    interactive: input.interactive,
    taskEngine: input.taskEngine,
    agents: input.agents,
    ...(input.learnerProfile ? { learnerProfile: input.learnerProfile } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
  };
}

describe.skipIf(!contractUrl)('course series on PostgreSQL', () => {
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
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=course-series`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    resetGenerationRunSchemaForTests();
    resetCourseSeriesSchemaForTests();
    await getServerPersistenceProvider(databaseUrl, () => pool);
  });

  beforeEach(() => {
    process.env.OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER = '50';
  });

  afterAll(async () => {
    await stopAgentEventNotifyBus();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetGenerationRunSchemaForTests();
    resetCourseSeriesSchemaForTests();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function start(input: GenerationRunInput) {
    return createGenerationRun(OWNER, input, {
      maxActiveRunsPerOwner: 50,
      maxWaitingRunsPerOwner: 50,
    });
  }

  async function claim(runId: string, workerId = 'worker-a') {
    return claimNextGenerationRun(workerId, { leaseTtlMs: 60_000, maxTakeovers: 3, runId });
  }

  /** Drive one run to its next pause point (waiting, paused, ended, or completed). */
  async function drive(runId: string, services: RunStepServices, workerId = 'worker-a') {
    const claimed = await claim(runId, workerId);
    if (!claimed) return null;
    return executeGenerationRun(claimed, { services, signal: new AbortController().signal });
  }

  /** Drive a run through every step it has left, assuming none of them wait. */
  async function driveToCompletion(runId: string, services: RunStepServices) {
    for (let i = 0; i < 20; i++) {
      const outcome = await drive(runId, services);
      const stored = (await readGenerationRun(runId, OWNER))!;
      if (stored.state === 'completed' || stored.state === 'ended' || stored.state === 'paused') {
        return stored;
      }
      if (outcome === null) throw new Error(`run ${runId} produced no worker to claim`);
    }
    throw new Error(`run ${runId} did not reach a final state within the step budget`);
  }

  it(
    'promotes a run to series part 1 and auto-starts part 2 once part 1 completes',
    async () => {
      // Part 1's own run never knows it is one until material-analysis: it
      // starts as an ordinary run, with no seriesContext.
      const run = await start(runInput());
      expect(run.series).toBeNull();

      const since = new Date();
      const { services: part1Services, analyzed } = fakeServices(twoPartPlan());
      const completedPart1 = await driveToCompletion(run.id, part1Services);

      // The material-analysis step saw the first part's own slice, not the
      // whole material: the split took effect on this very run.
      expect(analyzed).toHaveLength(1);
      expect(analyzed[0]!.textRanges).toEqual({ [MATERIAL_ID]: { start: 0, end: 500 } });

      expect(completedPart1.state).toBe('completed');
      expect(completedPart1.series).toEqual({ seriesId: expect.any(String), order: 1 });
      const seriesId = completedPart1.series!.seriesId;

      const series = await getCourseSeries(pool, seriesId, OWNER);
      expect(series).not.toBeNull();
      expect(series!.partCount).toBe(2);
      expect(series!.materialIds).toEqual([MATERIAL_ID]);

      // Part 2 is started by the engine's own completion path, not by this
      // test: it only shows up once `complete()`'s fire-and-forget call to
      // `startNextSeriesPart` lands.
      let part2: StoredRun | undefined;
      await vi.waitFor(async () => {
        const updated = await listGenerationRunsUpdatedSince(OWNER, since);
        part2 = updated.find((candidate) => candidate.series?.order === 2);
        expect(part2).toBeDefined();
      }, UNTIL);

      expect(part2!.series).toEqual({ seriesId, order: 2 });
      expect(part2!.input.materialIds).toEqual([MATERIAL_ID]);
      expect(part2!.input.seriesContext).toEqual({
        seriesId,
        order: 2,
        textRanges: { [MATERIAL_ID]: { start: 500, end: 1000 } },
      });
      // Every later part is confirmed on its own: nobody is shown its outline.
      expect(part2!.input.outlineReview).toBe('auto');

      // The read route carries the series-wide count once only a part's
      // `seriesId` is known. At this deterministic point part 2 has already
      // been claimed, so no planned part remains pending.
      const seriesRoute = await import('@/app/api/course-series/[id]/route');
      const seriesRead = await seriesRoute.GET(
        new NextRequest(`http://localhost/api/course-series/${seriesId}`, {
          headers: cookie(OWNER_COOKIE),
        }),
        { params: Promise.resolve({ id: seriesId }) },
      );
      expect((await seriesRead.json()).series).toMatchObject({
        id: seriesId,
        partCount: 2,
        pendingPartCount: 0,
      });

      // Part 2's own material-analysis never asks for another split: a
      // series part reads only its own slice, so `planMaterialSeries` would
      // not even be consulted in a real run; this fake simply never answers
      // one for it (`null`), the same guard the engine itself applies.
      const { services: part2Services, analyzed: analyzedPart2 } = fakeServices(null);
      const completedPart2 = await driveToCompletion(part2!.id, part2Services);
      expect(completedPart2.state).toBe('completed');
      expect(analyzedPart2[0]!.textRanges).toEqual({ [MATERIAL_ID]: { start: 500, end: 1000 } });

      // No part 3: the series had exactly two parts, so completing the last
      // one must not spin up another run. `startNextSeriesPart` for part 2
      // is fire-and-forget too, but `restParts` is empty by now, so it
      // resolves to null synchronously with no run created; a short
      // negative wait covers the (unlikely) case it is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stillActive = await listGenerationRunsUpdatedSince(OWNER, since);
      expect(stillActive.find((candidate) => candidate.series?.order === 3)).toBeUndefined();

      const seriesReadAfter = await seriesRoute.GET(
        new NextRequest(`http://localhost/api/course-series/${seriesId}`, {
          headers: cookie(OWNER_COOKIE),
        }),
        { params: Promise.resolve({ id: seriesId }) },
      );
      expect((await seriesReadAfter.json()).series).toMatchObject({ pendingPartCount: 0 });

      const seriesAfter = await getCourseSeries(pool, seriesId, OWNER);
      expect(seriesAfter!.pendingParts).toEqual([]);
    },
    30_000,
  );

  it('leaves an ordinary run with no series membership', async () => {
    const run = await start(runInput({ requirement: 'Teach a short topic' }));
    const { services } = fakeServices(null);
    const completed = await driveToCompletion(run.id, services);
    expect(completed.state).toBe('completed');
    expect(completed.series).toBeNull();
  });

  it('rolls back the pending claim when successor creation fails after claiming it', async () => {
    const owner = `${OWNER}:rollback`;
    const input = runInput();
    const predecessor = await createGenerationRun(owner, input, CONTINUATION_LIMITS);
    const { seriesId } = await startCourseSeries({
      ownerId: owner,
      title: 'Rollback series',
      materialIds: input.materialIds,
      plan: twoPartPlan(),
    });
    await pool.query(
      `UPDATE generation_runs
          SET series_id = $2, series_order = 1, state = 'completed'
        WHERE id = $1`,
      [predecessor.id, seriesId],
    );
    const cyclicAgents: Record<string, unknown> = {};
    cyclicAgents.self = cyclicAgents;

    await expect(
      startNextSeriesPart(
        owner,
        seriesId,
        { ...continuationBase(input), agents: cyclicAgents as GenerationRunInput['agents'] },
        CONTINUATION_LIMITS,
      ),
    ).rejects.toThrow();
    expect((await getCourseSeries(pool, seriesId, owner))!.pendingParts).toHaveLength(1);
    const runs = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM generation_runs WHERE series_id = $1',
      [seriesId],
    );
    expect(Number(runs.rows[0]!.n)).toBe(1);
    await expect(
      startNextSeriesPart(owner, seriesId, continuationBase(input), CONTINUATION_LIMITS),
    ).resolves.not.toBeNull();
  });

  it('creates only one successor under concurrent continuation calls', async () => {
    const owner = `${OWNER}:concurrent`;
    const input = runInput();
    const predecessor = await createGenerationRun(owner, input, CONTINUATION_LIMITS);
    const { seriesId } = await startCourseSeries({
      ownerId: owner,
      title: 'Concurrent series',
      materialIds: input.materialIds,
      plan: twoPartPlan(),
    });
    await pool.query(
      `UPDATE generation_runs
          SET series_id = $2, series_order = 1, state = 'completed'
        WHERE id = $1`,
      [predecessor.id, seriesId],
    );

    const results = await Promise.all([
      startNextSeriesPart(owner, seriesId, continuationBase(input), CONTINUATION_LIMITS),
      startNextSeriesPart(owner, seriesId, continuationBase(input), CONTINUATION_LIMITS),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const runs = await pool.query<{ series_order: number }>(
      'SELECT series_order FROM generation_runs WHERE series_id = $1 ORDER BY series_order',
      [seriesId],
    );
    expect(runs.rows.map((row) => row.series_order)).toEqual([1, 2]);
  });

  it('recovers a missing successor but never skips past a running part', async () => {
    const owner = `${OWNER}:recovery`;
    const input = runInput();
    const predecessor = await createGenerationRun(owner, input, CONTINUATION_LIMITS);
    const { seriesId } = await startCourseSeries({
      ownerId: owner,
      title: 'Recovery series',
      materialIds: input.materialIds,
      plan: threePartPlan(),
    });
    await pool.query(
      `UPDATE generation_runs
          SET series_id = $2, series_order = 1, state = 'completed'
        WHERE id = $1`,
      [predecessor.id, seriesId],
    );

    expect(await resumeStalledCourseSeries(CONTINUATION_LIMITS)).toBeGreaterThanOrEqual(1);
    const runs = await pool.query<{ series_order: number; state: string }>(
      'SELECT series_order, state FROM generation_runs WHERE series_id = $1 ORDER BY series_order',
      [seriesId],
    );
    expect(runs.rows).toMatchObject([
      { series_order: 1, state: 'completed' },
      { series_order: 2, state: 'preparing' },
    ]);

    expect(await resumeStalledCourseSeries(CONTINUATION_LIMITS)).toBe(0);
    const runsAfterRetry = await pool.query<{ series_order: number }>(
      'SELECT series_order FROM generation_runs WHERE series_id = $1 ORDER BY series_order',
      [seriesId],
    );
    expect(runsAfterRetry.rows.map((row) => row.series_order)).toEqual([1, 2]);
    expect((await getCourseSeries(pool, seriesId, owner))!.pendingParts.map((part) => part.order)).toEqual([
      3,
    ]);
  });

  it('keeps a stalled part pending at the owner limit and starts it after capacity returns', async () => {
    const owner = `${OWNER}:capacity`;
    const input = runInput();
    const predecessor = await createGenerationRun(owner, input, CONTINUATION_LIMITS);
    const blocker = await createGenerationRun(owner, runInput({ materialIds: [] }), CONTINUATION_LIMITS);
    const { seriesId } = await startCourseSeries({
      ownerId: owner,
      title: 'Capacity series',
      materialIds: input.materialIds,
      plan: twoPartPlan(),
    });
    await pool.query(
      `UPDATE generation_runs
          SET series_id = $2, series_order = 1, state = 'completed'
        WHERE id = $1`,
      [predecessor.id, seriesId],
    );

    expect(
      await resumeStalledCourseSeries({ maxActiveRunsPerOwner: 1, maxWaitingRunsPerOwner: 50 }),
    ).toBe(0);
    expect((await getCourseSeries(pool, seriesId, owner))!.pendingParts).toHaveLength(1);

    await pool.query(`UPDATE generation_runs SET state = 'completed' WHERE id = $1`, [blocker.id]);
    expect(
      await resumeStalledCourseSeries({ maxActiveRunsPerOwner: 1, maxWaitingRunsPerOwner: 50 }),
    ).toBeGreaterThanOrEqual(1);
    expect((await getCourseSeries(pool, seriesId, owner))!.pendingParts).toEqual([]);
  });

  it('answers 404 for an unknown series id, and for another owner\'s series', async () => {
    const run = await start(runInput());
    const { services } = fakeServices(twoPartPlan());
    const completed = await driveToCompletion(run.id, services);
    const seriesId = completed.series!.seriesId;

    const route = await import('@/app/api/course-series/[id]/route');
    const unknown = await route.GET(
      new NextRequest('http://localhost/api/course-series/series-doesnotexist', {
        headers: cookie(OWNER_COOKIE),
      }),
      { params: Promise.resolve({ id: 'series-doesnotexist' }) },
    );
    expect(unknown.status).toBe(404);

    const otherOwner = await route.GET(
      new NextRequest(`http://localhost/api/course-series/${seriesId}`, {
        headers: cookie('9f8e7d6c-5b4a-4a3b-8c2d-1e0f9a8b7c6d'),
      }),
      { params: Promise.resolve({ id: seriesId }) },
    );
    expect(otherOwner.status).toBe(404);
  });
});
