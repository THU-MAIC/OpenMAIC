import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  buildRequestOrigin: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
  getReadyOwnerMaterials: vi.fn(),
  extractable: new Set<string>(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));

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

vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  getReadyOwnerMaterials: mocks.getReadyOwnerMaterials,
}));

vi.mock('@/lib/server/material-extraction/availability', () => ({
  resolveExtractableMimeTypes: async () => mocks.extractable,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postGenerateClassroom(body: unknown) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new NextRequest('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request);
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

describe('POST /api/generate-classroom', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    for (const mock of [
      mocks.after,
      mocks.buildRequestOrigin,
      mocks.createClassroomGenerationJob,
      mocks.runClassroomGenerationJob,
      mocks.resolveRequestOwnerId,
      mocks.getReadyOwnerMaterials,
    ]) {
      mock.mockReset();
    }
    mocks.extractable = new Set(['application/pdf']);

    mocks.buildRequestOrigin.mockReturnValue('http://localhost');
    mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
    mocks.createClassroomGenerationJob.mockResolvedValue({
      status: 'queued',
      step: 'queued',
      message: 'Classroom generation job queued',
    });
    // Only the owner's own ready rows come back, as the SQL filter does.
    mocks.getReadyOwnerMaterials.mockImplementation(
      async (_pool: unknown, ownerId: string, ids: string[]) =>
        ownerId === 'owner-1'
          ? ids.filter((id) => id.startsWith('mat_mmmm')).map((id) => readyMaterial(id))
          : [],
    );
  });

  it('submits a requirement-only job as the request owner', async () => {
    const res = await postGenerateClassroom({ requirement: 'Teach photosynthesis' });
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual(
      expect.objectContaining({
        success: true,
        status: 'queued',
        step: 'queued',
        pollUrl: expect.stringMatching(/^http:\/\/localhost\/api\/generate-classroom\//),
      }),
    );
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      {
        requirement: 'Teach photosynthesis',
      },
      { ownerId: 'owner-1' },
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);

    await mocks.after.mock.calls[0][0]();
    expect(mocks.runClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      { requirement: 'Teach photosynthesis' },
      'http://localhost',
      { ownerId: 'owner-1' },
    );
  });

  it('attaches the owner cookies the resolution minted to the response', async () => {
    mocks.resolveRequestOwnerId.mockImplementation((_req: unknown, headers: Headers) => {
      headers.append('Set-Cookie', 'openmaic_owner=minted; Path=/; HttpOnly');
      return 'anon:minted';
    });

    const res = await postGenerateClassroom({ requirement: 'Teach photosynthesis' });

    expect(res.status).toBe(202);
    expect(res.headers.getSetCookie()).toContain('openmaic_owner=minted; Path=/; HttpOnly');
    await mocks.after.mock.calls[0][0]();
    expect(mocks.runClassroomGenerationJob.mock.calls[0][3]).toEqual({ ownerId: 'anon:minted' });
  });

  it('passes owned materialIds to the job, deduplicated and in the given order', async () => {
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
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      {
        requirement: 'Teach from my notes',
        materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm2', 'mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'],
      },
      { ownerId: 'owner-1' },
    );
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
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
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
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
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
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('ignores removed capability, provider and agent fields', async () => {
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
    });

    expect(res.status).toBe(202);
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      {
        requirement: 'Teach photosynthesis',
      },
      { ownerId: 'owner-1' },
    );
  });

  it('returns 400 without a requirement', async () => {
    const res = await postGenerateClassroom({ materialIds: ['mat_mmmmmmmmmmmmmmmmmmmmmmmmm1'] });

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
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
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
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
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

    it('on a job creation failure, without leaking the underlying error text', async () => {
      mocks.createClassroomGenerationJob.mockRejectedValue(
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
