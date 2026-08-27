import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  listSessionMaterials: vi.fn(),
  createSourceMaterial: vi.fn(),
  registerOwnerMaterial: vi.fn(),
  reclaimStaleOwnerMaterialUploads: vi.fn(),
  finalizeOwnerMaterial: vi.fn(),
  abandonOwnerMaterial: vi.fn(),
  byteStore: {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  queryPool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/session-materials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return {
    ...actual,
    resolveOwnedSession: mocks.resolveOwnedSession,
    listSessionMaterials: mocks.listSessionMaterials,
    createSourceMaterial: mocks.createSourceMaterial,
  };
});
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: mocks.queryPool,
  }),
}));
vi.mock('@/lib/server/materials/bytes', () => ({
  getMaterialByteStore: () => mocks.byteStore,
}));
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/persistence/owner-materials')>();
  return {
    ...actual,
    registerOwnerMaterial: mocks.registerOwnerMaterial,
    reclaimStaleOwnerMaterialUploads: mocks.reclaimStaleOwnerMaterialUploads,
    finalizeOwnerMaterial: mocks.finalizeOwnerMaterial,
    abandonOwnerMaterial: mocks.abandonOwnerMaterial,
  };
});

import { GET, POST } from '@/app/api/materials/route';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';

const SESSION_ID = 'session-1';

function material(overrides: Partial<AgentSessionMaterial> = {}): AgentSessionMaterial {
  return {
    id: 'mat_00000000000000000000000000',
    sessionId: SESSION_ID,
    kind: 'web',
    title: 'Example',
    sourceUrl: 'https://example.com/doc',
    textAssetId: 'asset-1',
    rawAssetId: null,
    textChars: 42,
    derivedFrom: null,
    extraction: { status: 'done', attempts: 0 },
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ownerMaterial(overrides: Partial<OwnerMaterialRecord> = {}): OwnerMaterialRecord {
  return {
    id: 'mat_00000000000000000000000000',
    ownerId: 'owner-1',
    kind: 'source',
    derivedFrom: null,
    mime: 'application/pdf',
    bytes: 5,
    originalName: '讲义.pdf',
    ossKey: 'materials/owner-1/mat_00000000000000000000000000',
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.resolveOwnedSession.mockResolvedValue({ id: SESSION_ID, ownerId: 'owner-1' });
  mocks.listSessionMaterials.mockResolvedValue([material()]);
  mocks.registerOwnerMaterial.mockResolvedValue(ownerMaterial());
  mocks.reclaimStaleOwnerMaterialUploads.mockResolvedValue(undefined);
  mocks.finalizeOwnerMaterial.mockImplementation(async (_pool: unknown, id: string) =>
    ownerMaterial({ id }),
  );
  mocks.abandonOwnerMaterial.mockResolvedValue(undefined);
  mocks.byteStore.put.mockResolvedValue(undefined);
  mocks.byteStore.get.mockResolvedValue(null);
  mocks.byteStore.delete.mockResolvedValue(undefined);
});

describe('GET /api/materials', () => {
  it("lists one owned session's materials as public views", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      materials: [
        {
          materialId: 'mat_00000000000000000000000000',
          kind: 'web',
          title: 'Example',
          sourceUrl: 'https://example.com/doc',
          textChars: 42,
          extraction: { status: 'done', attempts: 0 },
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(mocks.resolveOwnedSession).toHaveBeenCalledWith(SESSION_ID, 'owner-1');
    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID, {});
  });

  it('passes limit and before through as keyset paging', async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/materials?sessionId=${SESSION_ID}&limit=10&before=mat_prev`,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID, {
      limit: 10,
      before: 'mat_prev',
    });
  });

  it('rejects a missing sessionId', async () => {
    const response = await GET(new NextRequest('http://localhost/api/materials'));
    expect(response.status).toBe(400);
    expect(mocks.resolveOwnedSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed or out-of-range limit', async () => {
    for (const limit of ['abc', '0', '201']) {
      const response = await GET(
        new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}&limit=${limit}`),
      );
      expect(response.status).toBe(400);
    }
  });

  it('answers 404 for a foreign or missing session (no existence oracle)', async () => {
    mocks.resolveOwnedSession.mockResolvedValue(null);
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(404);
    expect(mocks.listSessionMaterials).not.toHaveBeenCalled();
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/materials', () => {
  async function post(body: unknown, headers: Record<string, string> = {}) {
    return POST(
      new NextRequest('http://localhost/api/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-material-filename': 'a.pdf', ...headers },
        body: body as BodyInit,
      }),
    );
  }

  it('uploads raw bytes into the owner library and returns the flat 201 view', async () => {
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      materialId: string;
      originalName: string;
      bytes: number;
      mime: string;
      extraction: { status: string };
    };
    expect(body.materialId).toMatch(/^mat_/);
    expect(body).toEqual({
      materialId: body.materialId,
      originalName: '讲义.pdf',
      bytes: 5,
      mime: 'application/pdf',
      extraction: { status: 'idle' },
    });
    // The uploader's error pairing header is echoed.
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(mocks.registerOwnerMaterial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerId: 'owner-1', kind: 'source', mime: 'application/pdf' }),
      expect.objectContaining({
        maxCount: agentRuntimeConfig.maxMaterialsPerOwner,
        maxTotalBytes: agentRuntimeConfig.maxMaterialBytesPerOwner,
      }),
    );
    expect(mocks.byteStore.put).toHaveBeenCalledWith(
      `materials/owner-1/${body.materialId}`,
      expect.any(Buffer),
      'application/pdf',
    );
    expect((mocks.byteStore.put.mock.calls[0]![1] as Buffer).toString()).toBe('hello');
    expect(mocks.finalizeOwnerMaterial).toHaveBeenCalledWith(
      expect.anything(),
      body.materialId,
      5,
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    // The object key is part of the reservation before its bytes are written,
    // closing the crash window between the byte write and finalize.
    expect(mocks.reclaimStaleOwnerMaterialUploads).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      expect.any(Function),
    );
    const putCall = mocks.byteStore.put.mock.invocationCallOrder[0]!;
    const finalizeCall = mocks.finalizeOwnerMaterial.mock.invocationCallOrder[0]!;
    expect(putCall).toBeLessThan(finalizeCall);
  });

  it('rejects an unsupported mime type with 415', async () => {
    const response = await post(Buffer.from('x'), { 'content-type': 'application/x-unknown' });
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'INVALID_REQUEST',
      error: expect.stringContaining('unsupported material mime type'),
    });
    expect(mocks.registerOwnerMaterial).not.toHaveBeenCalled();
  });

  it('rejects a missing filename header', async () => {
    const response = await post(Buffer.from('x'), { 'x-material-filename': '' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.registerOwnerMaterial).not.toHaveBeenCalled();
  });

  it('rejects a body over the upload cap with 413', async () => {
    const response = await post(Buffer.alloc(agentRuntimeConfig.maxUploadBytes + 1));
    expect(response.status).toBe(413);
    expect(mocks.finalizeOwnerMaterial).not.toHaveBeenCalled();
  });

  it('answers 429 when the owner quota is exceeded', async () => {
    const { MaterialQuotaExceededError } = await import('@/lib/persistence/owner-materials');
    mocks.registerOwnerMaterial.mockRejectedValue(new MaterialQuotaExceededError('bytes', 1024));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(429);
    // The reclaim of stale uploads is a separate pre-step; the quota rejection
    // itself never touches the byte store.
    expect(mocks.byteStore.delete).not.toHaveBeenCalled();
  });

  it('abandons the reservation and answers 500 when the byte store fails', async () => {
    mocks.byteStore.put.mockRejectedValue(new Error('material byte store unavailable'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
  });

  it('removes stored bytes before abandoning the reservation when finalize fails', async () => {
    mocks.finalizeOwnerMaterial.mockRejectedValue(new Error('finalize failed'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.byteStore.delete).toHaveBeenCalledWith(
      expect.stringMatching(/^materials\/owner-1\/mat_/),
    );
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expect(mocks.byteStore.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.abandonOwnerMaterial.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the reservation when byte cleanup fails after finalize fails', async () => {
    mocks.finalizeOwnerMaterial.mockRejectedValue(new Error('finalize failed'));
    mocks.byteStore.delete.mockRejectedValue(new Error('delete failed'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    expect(mocks.abandonOwnerMaterial).not.toHaveBeenCalled();
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    const response = await post(Buffer.from('x'));
    expect(response.status).toBe(404);
  });
});
