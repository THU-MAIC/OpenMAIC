import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  listSessionMaterials: vi.fn(),
  getSessionMaterial: vi.fn(),
  listLinkedOwnerMaterials: vi.fn(),
  createSourceMaterial: vi.fn(),
  registerOwnerMaterial: vi.fn(),
  reclaimStaleOwnerMaterialUploads: vi.fn(),
  allocateOwnerMaterialBytes: vi.fn(),
  publishOwnerMaterialUpload: vi.fn(),
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
  /** The pool registry, plain and transaction-pinned: no upload may remove from it. */
  assetStore: { remove: vi.fn(), replace: vi.fn() },
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/server/agent-runtime/session-materials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return {
    ...actual,
    resolveOwnedSession: mocks.resolveOwnedSession,
    listSessionMaterials: mocks.listSessionMaterials,
    getSessionMaterial: mocks.getSessionMaterial,
    getSessionMaterialQueryable: async () => mocks.queryPool,
    createSourceMaterial: mocks.createSourceMaterial,
  };
});
// The materials the session's links reach (covered over PGlite in
// material-library-routes.test.ts); none here.
vi.mock('@/lib/persistence/session-material-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/session-material-links')>()),
  listLinkedOwnerMaterials: mocks.listLinkedOwnerMaterials,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: mocks.queryPool,
    assetStore: mocks.assetStore,
    assetStoreIn: () => mocks.assetStore,
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
    allocateOwnerMaterialBytes: mocks.allocateOwnerMaterialBytes,
    publishOwnerMaterialUpload: mocks.publishOwnerMaterialUpload,
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
    ossKey: '',
    assetId: 'ast_00000000000000000000000000',
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
  mocks.getSessionMaterial.mockResolvedValue(material());
  mocks.listLinkedOwnerMaterials.mockResolvedValue([]);
  mocks.registerOwnerMaterial.mockResolvedValue(ownerMaterial());
  mocks.reclaimStaleOwnerMaterialUploads.mockResolvedValue(undefined);
  mocks.allocateOwnerMaterialBytes.mockResolvedValue('ast_00000000000000000000000000');
  mocks.publishOwnerMaterialUpload.mockImplementation(
    async (_provider: unknown, _owner: string, id: string) => ownerMaterial({ id }),
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
    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID, { limit: 50 });
  });

  it('passes limit and a session row before through as keyset paging', async () => {
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

  it('drops the backend error of a legacy row whose retryable failure went back to pending', async () => {
    mocks.listSessionMaterials.mockResolvedValue([
      material({ extraction: { status: 'pending', attempts: 1, error: 'PRIVATE_UPSTREAM_BODY' } }),
    ]);
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    const body = await response.json();
    expect(body.materials[0].extraction).toEqual({ status: 'pending', attempts: 1 });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_UPSTREAM_BODY');
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
    // The reservation names no byte-store object: the bytes go to the pool.
    expect(mocks.registerOwnerMaterial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: body.materialId, ossKey: '' }),
      expect.anything(),
    );
    expect(mocks.allocateOwnerMaterialBytes).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      expect.any(Buffer),
      'application/pdf',
    );
    expect((mocks.allocateOwnerMaterialBytes.mock.calls[0]![2] as Buffer).toString()).toBe('hello');
    expect(mocks.publishOwnerMaterialUpload).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      body.materialId,
      {
        assetId: 'ast_00000000000000000000000000',
        bytes: 5,
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      },
    );
    expect(mocks.reclaimStaleOwnerMaterialUploads).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      expect.any(Function),
    );
    expect(mocks.allocateOwnerMaterialBytes.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.publishOwnerMaterialUpload.mock.invocationCallOrder[0]!,
    );
    // Nothing is written to, or deleted from, the material byte store.
    expect(mocks.byteStore.put).not.toHaveBeenCalled();
    expect(mocks.byteStore.delete).not.toHaveBeenCalled();
    expect(mocks.abandonOwnerMaterial).not.toHaveBeenCalled();
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

  it('derives the concrete mime from the filename when the client sends a generic Office MIME', async () => {
    // Older Linux XDG mime databases report OOXML uploads as the generic
    // `application/vnd.ms-office` container (#1497); the extension resolves it.
    const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const response = await post(Buffer.from('x'), {
      'content-type': 'application/vnd.ms-office',
      'x-material-filename': encodeURIComponent('slides.pptx'),
    });
    expect(response.status).toBe(201);
    // The resolved concrete MIME drives the reservation and the stored bytes.
    expect(mocks.registerOwnerMaterial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerId: 'owner-1', kind: 'source', mime: pptxMime }),
      expect.anything(),
    );
    expect(mocks.allocateOwnerMaterialBytes).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      expect.any(Buffer),
      pptxMime,
    );
  });

  it('still rejects a generic MIME whose extension is not an accepted material', async () => {
    const response = await post(Buffer.from('x'), {
      'content-type': 'application/vnd.ms-office',
      'x-material-filename': encodeURIComponent('blob.bin'),
    });
    expect(response.status).toBe(415);
    expect(mocks.registerOwnerMaterial).not.toHaveBeenCalled();
  });

  it('answers 415 for a generic MIME before the missing-filename 400', async () => {
    // A generic type with no filename cannot be resolved, so the mime gate
    // fires first — error precedence must match the specific-MIME path.
    const response = await post(Buffer.from('x'), {
      'content-type': 'application/vnd.ms-office',
      'x-material-filename': '',
    });
    expect(response.status).toBe(415);
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
    await expect(response.json()).resolves.toMatchObject({
      maxBytes: Math.min(agentRuntimeConfig.maxDocumentBytes, agentRuntimeConfig.maxUploadBytes),
    });
    expect(mocks.allocateOwnerMaterialBytes).not.toHaveBeenCalled();
    expect(mocks.publishOwnerMaterialUpload).not.toHaveBeenCalled();
  });

  it('does not include maxBytes when the body exceeds its declared length', async () => {
    // 0 < declared length < actual body < effective upload cap, so this is the
    // mismatch 413 and not either size-cap 413.
    const body = Buffer.from('hello world');
    const effectiveLimit = Math.min(
      agentRuntimeConfig.maxDocumentBytes,
      agentRuntimeConfig.maxUploadBytes,
    );
    expect(body.byteLength).toBeGreaterThan(4);
    expect(body.byteLength).toBeLessThan(effectiveLimit);
    const response = await post(body, { 'content-length': '4' });
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe('upload body exceeds its declared content length');
    expect(payload).not.toHaveProperty('maxBytes');
    expect(mocks.allocateOwnerMaterialBytes).not.toHaveBeenCalled();
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
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

  /** Nothing an upload failure does may delete stored bytes, in the byte store or the pool. */
  function expectNothingDeleted() {
    expect(mocks.byteStore.delete).not.toHaveBeenCalled();
    expect(mocks.byteStore.put).not.toHaveBeenCalled();
    expect(mocks.assetStore.remove).not.toHaveBeenCalled();
    expect(mocks.assetStore.replace).not.toHaveBeenCalled();
  }

  it('abandons the reservation and answers 500 when the allocation fails', async () => {
    mocks.allocateOwnerMaterialBytes.mockRejectedValue(new Error('asset registry unavailable'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.publishOwnerMaterialUpload).not.toHaveBeenCalled();
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalledWith(
      expect.anything(),
      'owner-1',
      expect.stringMatching(/^mat_/),
    );
    expectNothingDeleted();
  });

  it('answers 507 and abandons the reservation when the pool quota has no room', async () => {
    const { AssetQuotaExceededError } = await import('@openmaic/storage');
    mocks.allocateOwnerMaterialBytes.mockRejectedValue(new AssetQuotaExceededError());
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'ASSET_QUOTA_EXCEEDED' });
    expect(mocks.publishOwnerMaterialUpload).not.toHaveBeenCalled();
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('abandons the reservation and deletes nothing when the publication fails', async () => {
    // Including a publication that may have committed before its answer was
    // lost: the abandon only matches a row still uploading.
    mocks.publishOwnerMaterialUpload.mockRejectedValue(new Error('connection reset'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('answers 500 and abandons the reservation when the publication is refused', async () => {
    mocks.publishOwnerMaterialUpload.mockResolvedValue('refused');
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('answers 403 OWNER_RETIRED when the owner was claimed before the publication', async () => {
    const { OwnerRetiredError } = await import('@/lib/persistence/owner-merges');
    mocks.publishOwnerMaterialUpload.mockRejectedValue(new OwnerRetiredError('owner-1'));
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'OWNER_RETIRED' } });
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('answers 503 OWNER_BUSY when the owner fence times out at the allocation', async () => {
    const { OwnerBusyError } = await import('@/lib/persistence/owner-merges');
    mocks.allocateOwnerMaterialBytes.mockRejectedValue(new OwnerBusyError());
    const response = await post(Buffer.from('hello'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'OWNER_BUSY' } });
    expect(mocks.abandonOwnerMaterial).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    const response = await post(Buffer.from('x'));
    expect(response.status).toBe(404);
  });
});

describe('configured material upload limit metadata', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['application/pdf', 1024, 2048, 1024],
    ['image/png', 1024, 2048, 1024],
    ['audio/mpeg', 1024, 2048, 2048],
    ['video/mp4', 1024, 2048, 2048],
    ['application/pdf', 2048, 1024, 1024],
  ])(
    'reports the effective limit for %s (document %i, upload %i)',
    async (mime, documentBytes, uploadBytes, maxBytes) => {
      vi.resetModules();
      vi.stubEnv('MATERIALS_MAX_DOCUMENT_BYTES', String(documentBytes));
      vi.stubEnv('OPENMAIC_AGENT_MAX_UPLOAD_BYTES', String(uploadBytes));
      const { POST: configuredPost } = await import('@/app/api/materials/route');

      for (const declared of [true, false]) {
        const response = await configuredPost(
          new NextRequest('http://localhost/api/materials', {
            method: 'POST',
            headers: {
              'content-type': mime,
              'x-material-filename': 'material',
              ...(declared ? { 'content-length': String(maxBytes + 1) } : {}),
            },
            body: Buffer.alloc(maxBytes + 1),
          }),
        );
        expect(response.status).toBe(413);
        expect(response.headers.get('x-request-id')).toBeTruthy();
        await expect(response.json()).resolves.toEqual({
          success: false,
          errorCode: 'INVALID_REQUEST',
          error: `upload exceeds ${maxBytes} bytes`,
          maxBytes,
        });
      }
      expect(mocks.byteStore.put).not.toHaveBeenCalled();
    },
  );
});
