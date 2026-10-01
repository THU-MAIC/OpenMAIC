import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { StoredRun } from '@/lib/server/generation/run/store';
import type { GenerationRunMediaCheckpoint } from '@/lib/server/generation/run/types';

const mocks = vi.hoisted(() => ({
  buildRequestOrigin: vi.fn(),
  createGenerationRun: vi.fn(),
  readGenerationRunWithMedia: vi.fn(),
  wakeGenerationRunner: vi.fn(),
  resolveModel: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
  getReadyOwnerMaterials: vi.fn(),
  extractable: new Set<string>(),
  extractError: undefined as unknown,
}));

vi.mock('@/lib/server/generation/run/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation/run/store')>()),
  createGenerationRun: mocks.createGenerationRun,
  readGenerationRunWithMedia: mocks.readGenerationRunWithMedia,
}));

vi.mock('@/lib/server/generation/run/runner', () => ({
  wakeGenerationRunner: mocks.wakeGenerationRunner,
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));

vi.mock('@/lib/persistence/owner-merges', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-merges')>()),
  canonicalizeStoredOwner: async (ownerId: string) => ownerId,
}));

vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  getReadyOwnerMaterials: mocks.getReadyOwnerMaterials,
}));

vi.mock('@/lib/server/material-extraction/availability', () => ({
  resolveExtractableMimeTypes: async () => {
    if (mocks.extractError) throw mocks.extractError;
    return mocks.extractable;
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const RUN_ID = 'run-AAAAAAAAAAAAAAAA';

function storedRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: RUN_ID,
    ownerId: 'owner-1',
    mediaPending: false,
    state: 'preparing',
    step: null,
    seq: 1,
    input: {
      requirement: 'Teach photosynthesis',
      materialIds: [],
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'auto',
    },
    outline: null,
    agents: null,
    stageId: null,
    progress: { scenesTotal: 0, scenesCompleted: 0 },
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    leaseWorkerId: null,
    leaseHeartbeatAt: null,
    leaseGeneration: 0,
    takeovers: 0,
    ...overrides,
  };
}

async function postGenerateClassroom(body: unknown) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new NextRequest('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request);
}

async function pollJob(jobId: string) {
  const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
  return GET(new NextRequest(`http://localhost/api/generate-classroom/${jobId}`), {
    params: Promise.resolve({ jobId }),
  });
}

function readyMaterial(id: string, ownerId = 'owner-1') {
  return {
    id,
    ownerId,
    kind: 'source',
    derivedFrom: null,
    mime: 'application/pdf',
    bytes: 5,
    originalName: `${id}.pdf`,
    ossKey: `materials/${ownerId}/${id}`,
    sha256: 'abc',
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: 1,
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  for (const mock of [
    mocks.buildRequestOrigin,
    mocks.createGenerationRun,
    mocks.readGenerationRunWithMedia,
    mocks.wakeGenerationRunner,
    mocks.resolveModel,
    mocks.resolveRequestOwnerId,
    mocks.getReadyOwnerMaterials,
  ]) {
    mock.mockReset();
  }
  mocks.extractable = new Set(['application/pdf']);
  mocks.extractError = undefined;

  mocks.buildRequestOrigin.mockReturnValue('http://localhost');
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.resolveModel.mockResolvedValue({ providerId: 'openai', apiKey: 'server-key' });
  mocks.createGenerationRun.mockImplementation(async (ownerId: string, input: unknown) =>
    storedRun({ ownerId, input: input as StoredRun['input'] }),
  );
  // Only the owner's own ready rows come back, as the SQL filter does.
  mocks.getReadyOwnerMaterials.mockImplementation(
    async (_pool: unknown, ownerId: string, ids: string[]) =>
      ownerId === 'owner-1'
        ? ids.filter((id) => id.startsWith('mat_mmmm')).map((id) => readyMaterial(id))
        : [],
  );
});

describe('POST /api/generate-classroom', () => {
  it('starts a run as the request owner, outline confirmed automatically, with the browser defaults', async () => {
    const res = await postGenerateClassroom({ requirement: 'Teach photosynthesis' });
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual({
      success: true,
      jobId: RUN_ID,
      runId: RUN_ID,
      status: 'queued',
      step: 'queued',
      progress: 0,
      message: 'Classroom generation job queued',
      pollUrl: `http://localhost/api/generate-classroom/${RUN_ID}`,
      pollIntervalMs: 5000,
      scenesGenerated: 0,
      done: false,
    });
    expect(mocks.createGenerationRun).toHaveBeenCalledWith(
      'owner-1',
      {
        requirement: 'Teach photosynthesis',
        materialIds: [],
        interactive: false,
        taskEngine: false,
        agents: { mode: 'auto' },
        outlineReview: 'auto',
      },
      { maxActiveRunsPerOwner: 2, maxWaitingRunsPerOwner: 10 },
    );
    expect(mocks.wakeGenerationRunner).toHaveBeenCalledTimes(1);
    // The outline model is checked for the run's owner, through the outline slot.
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'scene-outlines-stream',
      workspaceId: 'owner-1',
    });
  });

  it('attaches the owner cookies the resolution minted to the response', async () => {
    mocks.resolveRequestOwnerId.mockImplementation((_req: unknown, headers: Headers) => {
      headers.append('Set-Cookie', 'openmaic_owner=minted; Path=/; HttpOnly');
      return 'anon:minted';
    });

    const res = await postGenerateClassroom({ requirement: 'Teach photosynthesis' });

    expect(res.status).toBe(202);
    expect(res.headers.getSetCookie()).toContain('openmaic_owner=minted; Path=/; HttpOnly');
    expect(mocks.createGenerationRun.mock.calls[0][0]).toBe('anon:minted');
  });

  it('answers 429 ACTIVE_RUN_LIMIT when the owner has the limit of runs in progress', async () => {
    const { ActiveRunLimitError } = await import('@/lib/server/generation/run/store');
    mocks.createGenerationRun.mockRejectedValue(new ActiveRunLimitError(2));

    const res = await postGenerateClassroom({ requirement: 'Teach' });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.errorCode).toBe('ACTIVE_RUN_LIMIT');
    expect(json.error).toContain('2');
    expect(mocks.wakeGenerationRunner).not.toHaveBeenCalled();
  });

  it('refuses a submission when no outline model is configured', async () => {
    const { SlotUnassignedError } = await import('@/lib/server/model-config/runtime');
    mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));

    const res = await postGenerateClassroom({ requirement: 'Teach' });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe('MISSING_MODEL');
    expect(json.error).toContain('No model is configured for course.outline');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('refuses a submission when the outline slot is turned off', async () => {
    const { SlotDisabledError } = await import('@/lib/server/model-config/runtime');
    mocks.resolveModel.mockRejectedValue(new SlotDisabledError('llm'));

    const res = await postGenerateClassroom({ requirement: 'Teach' });

    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe('MISSING_MODEL');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('refuses a submission when the outline provider has no key', async () => {
    mocks.resolveModel.mockResolvedValue({ providerId: 'openai', apiKey: '' });

    const res = await postGenerateClassroom({ requirement: 'Teach' });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe('MISSING_API_KEY');
    expect(json.error).toContain('openai');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('answers 403 when the workspace document service is one it may not use', async () => {
    const { WorkspaceEndpointError } = await import('@/lib/server/model-config/media');
    mocks.extractError = new WorkspaceEndpointError('deployment only');
    const res = await postGenerateClassroom({
      requirement: 'Teach from my notes',
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
    });

    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('INVALID_URL');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('passes owned materialIds to the run, deduplicated and in the given order', async () => {
    const res = await postGenerateClassroom({
      requirement: 'Teach from my notes',
      materialIds: [
        'mat_mmmmmmmmmmmmmmmmmmmmmmmmm2',
        ' mat_mmmmmmmmmmmmmmmmmmmmmmmmm1 ',
        'mat_mmmmmmmmmmmmmmmmmmmmmmmmm2',
      ],
    });

    expect(res.status).toBe(202);
    expect(mocks.getReadyOwnerMaterials).toHaveBeenCalledWith(expect.anything(), 'owner-1', [
      'mat_mmmmmmmmmmmmmmmmmmmmmmmmm2',
      'mat_mmmmmmmmmmmmmmmmmmmmmmmmm1',
    ]);
    expect(mocks.createGenerationRun.mock.calls[0][1]).toMatchObject({
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm2', 'mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
    });
  });

  it('rejects pdfContent and points the caller at the materials upload', async () => {
    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent: { text: 'parsed text', images: [] },
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe('INVALID_REQUEST');
    expect(json.error).toContain('POST /api/materials');
    expect(json.error).toContain('materialIds');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
    ['a non-string entry', ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1', 7]],
    ['an empty entry', ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1', '  ']],
    ['too many ids', ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `mat_${'m'.repeat(25)}${id}`)],
    ['an overlong id', [`mat_${'m'.repeat(64)}`]],
    ['an id with an embedded NUL', [`mat_${'m'.repeat(24)}\u00001`]],
    ['an id outside the material id alphabet', [`mat_${'m'.repeat(25)}u`]],
  ])('returns 400 when materialIds is %s', async (_label, materialIds) => {
    const res = await postGenerateClassroom({ requirement: 'Teach', materialIds });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'materialIds must be an array of at most 5 material ids',
    });
    // Malformed ids never reach the database.
    expect(mocks.getReadyOwnerMaterials).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('answers unknown and foreign materials with one uniform error', async () => {
    const unknown = await postGenerateClassroom({
      requirement: 'Teach',
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1', 'mat_xxxxxxxxxxxxxxxxxxxxxxxxxx'],
    });
    mocks.resolveRequestOwnerId.mockReturnValue('owner-2');
    const foreign = await postGenerateClassroom({
      requirement: 'Teach',
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
    });

    const expected = {
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'One or more materials are unavailable',
    };
    expect(unknown.status).toBe(400);
    expect(foreign.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual(expected);
    await expect(foreign.json()).resolves.toEqual(expected);
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it("ignores removed capability, provider and agent fields, and the run API's own options", async () => {
    const res = await postGenerateClassroom({
      requirement: 'Teach photosynthesis',
      enableWebSearch: true,
      webSearchProviderId: 'tavily',
      webSearchApiKey: 'caller-key',
      webSearchModelId: 'm',
      baiduSubSources: { webSearch: true },
      enableImageGeneration: true,
      enableVideoGeneration: true,
      enableTTS: true,
      agentMode: 'default',
      language: 'en-US',
      interactive: true,
      taskEngine: true,
      agents: { mode: 'preset', agentIds: ['default-1'] },
      outlineReview: 'wait',
      learnerProfile: { nickname: 'Ada' },
      voice: { providerId: 'openai-tts', voiceId: 'alloy' },
    });

    expect(res.status).toBe(202);
    expect(mocks.createGenerationRun.mock.calls[0][1]).toEqual({
      requirement: 'Teach photosynthesis',
      materialIds: [],
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'auto',
    });
  });

  it.each([
    ['without a requirement', { materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'] }],
    ['with a blank requirement', { requirement: '   ' }],
  ])('returns 400 %s', async (_label, body) => {
    const res = await postGenerateClassroom(body);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ errorCode: 'MISSING_REQUIRED_FIELD' }),
    );
  });

  it('refuses materials whose type this server cannot extract', async () => {
    mocks.getReadyOwnerMaterials.mockResolvedValue([
      { ...readyMaterial('mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'), mime: 'application/vnd.ms-powerpoint' },
    ]);

    const res = await postGenerateClassroom({
      requirement: 'Teach',
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe('INVALID_REQUEST');
    expect(json.error).toContain('cannot extract');
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it('refuses materials over the bundle total size', async () => {
    mocks.getReadyOwnerMaterials.mockResolvedValue([
      { ...readyMaterial('mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'), bytes: 100 * 1024 * 1024 },
      { ...readyMaterial('mat_mmmmmmmmmmmmmmmmmmmmmmmmm2'), bytes: 60 * 1024 * 1024 },
    ]);

    const res = await postGenerateClassroom({
      requirement: 'Teach',
      materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1', 'mat_mmmmmmmmmmmmmmmmmmmmmmmmm2'],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringContaining('total') }),
    );
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  describe('owner cookies ride every response', () => {
    const minted = 'openmaic_owner=minted; Path=/; HttpOnly';

    beforeEach(() => {
      mocks.resolveRequestOwnerId.mockImplementation((_req: unknown, headers: Headers) => {
        headers.append('Set-Cookie', minted);
        return 'anon:minted';
      });
    });

    it.each([
      ['a missing requirement', {}, 400],
      ['pdfContent', { requirement: 'Teach', pdfContent: { text: '', images: [] } }, 400],
      ['malformed materialIds', { requirement: 'Teach', materialIds: 'x' }, 400],
      [
        'unavailable materials',
        { requirement: 'Teach', materialIds: ['mat_xxxxxxxxxxxxxxxxxxxxxxxxxx'] },
        400,
      ],
    ])('on %s', async (_label, body, status) => {
      const res = await postGenerateClassroom(body);
      expect(res.status).toBe(status);
      expect(res.headers.getSetCookie()).toContain(minted);
    });

    it('on invalid JSON', async () => {
      const { POST } = await import('@/app/api/generate-classroom/route');
      const res = await POST(
        new NextRequest('http://localhost/api/generate-classroom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not json',
        }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toContain(minted);
    });

    it('on a run creation failure, without leaking the underlying error text', async () => {
      mocks.createGenerationRun.mockRejectedValue(
        new Error('invalid byte sequence for encoding "UTF8": 0x00'),
      );
      const res = await postGenerateClassroom({ requirement: 'Teach' });
      expect(res.status).toBe(500);
      expect(res.headers.getSetCookie()).toContain(minted);
      await expect(res.json()).resolves.toEqual({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'Failed to create classroom generation job',
      });
    });
  });
});

describe('GET /api/generate-classroom/:jobId', () => {
  function answer(run: StoredRun, media: Record<string, GenerationRunMediaCheckpoint> = {}) {
    mocks.readGenerationRunWithMedia.mockResolvedValue({
      run,
      media: new Map(Object.entries(media)),
    });
  }

  it.each<[string, Partial<StoredRun>, Record<string, unknown>]>([
    [
      'a run no worker picked up yet',
      {},
      { status: 'queued', step: 'queued', progress: 0, done: false },
    ],
    [
      'material analysis',
      { step: 'material-analysis' },
      { status: 'running', step: 'initializing', progress: 5 },
    ],
    ['research', { step: 'research' }, { status: 'running', step: 'researching', progress: 10 }],
    [
      'the outline',
      { state: 'outlining', step: 'outline' },
      { status: 'running', step: 'generating_outlines', progress: 15 },
    ],
    [
      'a confirmed outline the run has not moved on from',
      { state: 'awaiting_outline_confirmation', progress: { scenesTotal: 4, scenesCompleted: 0 } },
      { status: 'running', step: 'generating_outlines', progress: 30, totalScenes: 4 },
    ],
    [
      'scene generation',
      {
        state: 'generating',
        step: 'scene:2:actions',
        stageId: 'stage-1',
        progress: { scenesTotal: 4, scenesCompleted: 2 },
      },
      {
        status: 'running',
        step: 'generating_scenes',
        progress: 60,
        message: 'Generated 2/4 scenes',
        scenesGenerated: 2,
        totalScenes: 4,
        done: false,
      },
    ],
    [
      'the media pass after the last scene',
      {
        state: 'generating',
        step: 'scene:3:narration',
        stageId: 'stage-1',
        progress: { scenesTotal: 4, scenesCompleted: 4 },
      },
      { status: 'running', step: 'generating_media', progress: 90 },
    ],
  ])('maps %s', async (_label, overrides, expected) => {
    answer(storedRun(overrides));

    const res = await pollJob(RUN_ID);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ jobId: RUN_ID, runId: RUN_ID, ...expected });
    expect(json).not.toHaveProperty('result');
    expect(json).not.toHaveProperty('error');
  });

  it('answers a completed run as a succeeded job with the course', async () => {
    answer(
      storedRun({
        state: 'completed',
        stageId: 'stage-done',
        progress: { scenesTotal: 3, scenesCompleted: 3 },
      }),
      { img_1: { mediaType: 'image', status: 'done', assetId: 'ast_1' } },
    );

    const json = await (await pollJob(RUN_ID)).json();

    expect(json).toEqual({
      success: true,
      jobId: RUN_ID,
      runId: RUN_ID,
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      message: 'Classroom generation completed',
      pollUrl: `http://localhost/api/generate-classroom/${RUN_ID}`,
      pollIntervalMs: 5000,
      scenesGenerated: 3,
      totalScenes: 3,
      result: {
        classroomId: 'stage-done',
        url: 'http://localhost/classroom/stage-done',
        scenesCount: 3,
      },
      done: true,
    });
  });

  it('names failed images and videos of a completed run in the warning', async () => {
    answer(
      storedRun({
        state: 'completed',
        stageId: 'stage-done',
        progress: { scenesTotal: 1, scenesCompleted: 1 },
      }),
      {
        img_1: { mediaType: 'image', status: 'done', assetId: 'ast_1' },
        vid_1: {
          mediaType: 'video',
          status: 'failed',
          message: 'Asset storage is full',
          errorCode: 'ASSET_QUOTA_EXCEEDED',
        },
      },
    );

    const json = await (await pollJob(RUN_ID)).json();

    const warning = `1 of 2 images and videos could not be generated; see GET /api/generation-runs/${RUN_ID} for each one`;
    expect(json.status).toBe('succeeded');
    expect(json.message).toBe(warning);
    expect(json.result.warning).toBe(warning);
  });

  it('answers a paused run as a failed job with the failed step, and its run id for Retry', async () => {
    answer(
      storedRun({
        state: 'paused',
        step: 'scene:1:content',
        stageId: 'stage-1',
        progress: { scenesTotal: 3, scenesCompleted: 1 },
        error: { step: 'scene:1:content', message: 'Upstream rate limit reached.' },
      }),
    );

    const json = await (await pollJob(RUN_ID)).json();

    expect(json).toMatchObject({
      runId: RUN_ID,
      status: 'failed',
      step: 'failed',
      message: 'Classroom generation failed',
      error: 'scene:1:content: Upstream rate limit reached.',
      scenesGenerated: 1,
      done: true,
    });
    expect(json).not.toHaveProperty('result');
  });

  it.each([
    ['a deleted course', 'stage-1', 'The classroom was deleted before its generation finished'],
    ['a discarded run', null, 'The generation run was discarded'],
  ])('answers an ended run (%s) as a failed job', async (_label, stageId, error) => {
    answer(storedRun({ state: 'ended', stageId }));

    const json = await (await pollJob(RUN_ID)).json();

    expect(json).toMatchObject({ status: 'failed', error, done: true });
  });

  it('reads the run for the request owner, and answers 404 when it is not theirs', async () => {
    mocks.resolveRequestOwnerId.mockReturnValue('owner-2');
    mocks.readGenerationRunWithMedia.mockResolvedValue(null);

    const res = await pollJob(RUN_ID);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Classroom generation job not found');
    expect(mocks.readGenerationRunWithMedia).toHaveBeenCalledWith(RUN_ID, 'owner-2');
  });

  it('answers 404 for a job id of an earlier release without reading anything', async () => {
    const res = await pollJob('abc123DEF0');

    expect(res.status).toBe(404);
    expect(mocks.readGenerationRunWithMedia).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed job id', async () => {
    const res = await pollJob('bad.id');

    expect(res.status).toBe(400);
    expect(mocks.readGenerationRunWithMedia).not.toHaveBeenCalled();
  });
});
