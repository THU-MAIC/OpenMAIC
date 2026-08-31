import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  getSessionMaterial: vi.fn(),
  getReadyOwnerMaterial: vi.fn(),
  deleteOwnedMaterial: vi.fn(),
  queryPool: { query: vi.fn() },
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
    getSessionMaterial: mocks.getSessionMaterial,
  };
});
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/persistence/owner-materials')>();
  return { ...actual, getReadyOwnerMaterial: mocks.getReadyOwnerMaterial };
});
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: mocks.queryPool }),
}));
vi.mock('@/lib/server/materials/owner-assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/materials/owner-assets')>();
  return { ...actual, deleteOwnedMaterial: mocks.deleteOwnedMaterial };
});

import { DELETE, GET } from '@/app/api/materials/[id]/route';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';

const SESSION_ID = 'session-1';
const MATERIAL_ID = 'mat_00000000000000000000000000';

function material(overrides: Partial<AgentSessionMaterial> = {}): AgentSessionMaterial {
  return {
    id: MATERIAL_ID,
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
    id: MATERIAL_ID,
    ownerId: 'owner-1',
    kind: 'source',
    derivedFrom: null,
    mime: 'application/pdf',
    bytes: 42,
    originalName: 'paper.pdf',
    ossKey: 'private-object-key',
    sha256: 'a'.repeat(64),
    status: 'ready',
    extraction: {
      status: 'idle',
      objectKey: 'private-nested-object-key',
      sha256: 'private-nested-digest',
      ownerId: 'private-nested-owner',
    },
    createdAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

function call(id = MATERIAL_ID) {
  const req = new NextRequest(`http://localhost/api/materials/${id}?sessionId=${SESSION_ID}`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.resolveOwnedSession.mockResolvedValue({ id: SESSION_ID, ownerId: 'owner-1' });
  mocks.getSessionMaterial.mockResolvedValue(material());
  mocks.getReadyOwnerMaterial.mockResolvedValue(ownerMaterial());
  mocks.deleteOwnedMaterial.mockResolvedValue('deleted');
});

describe('GET /api/materials/[id]', () => {
  it('returns owner-scoped metadata without private storage fields', async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/materials/${MATERIAL_ID}?scope=owner`),
      { params: Promise.resolve({ id: MATERIAL_ID }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      material: {
        materialId: MATERIAL_ID,
        kind: 'source',
        mime: 'application/pdf',
        bytes: 42,
        originalName: 'paper.pdf',
        extraction: { status: 'idle' },
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /ownerId|ossKey|sha256|private-object-key|private-nested-object-key|private-nested-digest|private-nested-owner/,
    );
    expect(mocks.getReadyOwnerMaterial).toHaveBeenCalledWith(
      mocks.queryPool,
      'owner-1',
      MATERIAL_ID,
    );
  });

  it('answers 404 for a foreign owner material without falling back to session scope', async () => {
    mocks.getReadyOwnerMaterial.mockResolvedValue(null);
    const response = await GET(
      new NextRequest(`http://localhost/api/materials/${MATERIAL_ID}?scope=owner`),
      { params: Promise.resolve({ id: MATERIAL_ID }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.getSessionMaterial).not.toHaveBeenCalled();
  });

  it("returns one owned session's material as a public view", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      material: {
        materialId: MATERIAL_ID,
        kind: 'web',
        title: 'Example',
        sourceUrl: 'https://example.com/doc',
        textChars: 42,
        extraction: { status: 'done', attempts: 0 },
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    });
    expect(mocks.getSessionMaterial).toHaveBeenCalledWith(SESSION_ID, MATERIAL_ID);
  });

  it('maps a historical raw extraction error to a closed public code', async () => {
    const privateDiagnostic =
      'provider stderr C:\\private\\student\\paper.pdf materials/v1/sessions/secret/raw.pdf';
    mocks.getSessionMaterial.mockResolvedValue(
      material({
        extraction: {
          status: 'failed',
          attempts: 2,
          error: privateDiagnostic,
        } as unknown as AgentSessionMaterial['extraction'],
      }),
    );

    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.material.extraction).toEqual({
      status: 'failed',
      attempts: 2,
      errorCode: 'MATERIAL_EXTRACTION_FAILED',
    });
    expect(JSON.stringify(body)).not.toContain(privateDiagnostic);
    expect(JSON.stringify(body)).not.toMatch(/provider stderr|C:\\private|materials\/v1\/sessions/);
  });

  it('rejects a missing sessionId', async () => {
    const req = new NextRequest(`http://localhost/api/materials/${MATERIAL_ID}`);
    const response = await GET(req, { params: Promise.resolve({ id: MATERIAL_ID }) });
    expect(response.status).toBe(400);
    expect(mocks.getSessionMaterial).not.toHaveBeenCalled();
  });

  it('answers 404 for a foreign or missing session (no existence oracle)', async () => {
    mocks.resolveOwnedSession.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(mocks.getSessionMaterial).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or foreign material', async () => {
    mocks.getSessionMaterial.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('rides the owner cookie on the 404', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce((_req, responseHeaders: Headers) => {
      responseHeaders.set('Set-Cookie', 'anonymous_id=anon-2; Path=/');
      return 'anon:anon-2';
    });
    mocks.getSessionMaterial.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=anon-2');
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call()).status).toBe(404);
  });
});

describe('DELETE /api/materials/[id]', () => {
  function remove(id = MATERIAL_ID, query = '?scope=owner') {
    return DELETE(new NextRequest(`http://localhost/api/materials/${id}${query}`), {
      params: Promise.resolve({ id }),
    });
  }

  it('deletes only through explicit owner scope and is absence-idempotent', async () => {
    expect((await remove()).status).toBe(204);
    expect(mocks.deleteOwnedMaterial).toHaveBeenCalledWith('owner-1', MATERIAL_ID);
    expect(mocks.getReadyOwnerMaterial).not.toHaveBeenCalled();
    mocks.deleteOwnedMaterial.mockResolvedValue('absent');
    expect((await remove()).status).toBe(204);
  });

  it('fails malformed ids and mixed scope closed before deletion', async () => {
    expect((await remove('../bad')).status).toBe(404);
    expect((await remove(MATERIAL_ID, '?scope=owner&sessionId=session-1')).status).toBe(400);
    expect(mocks.deleteOwnedMaterial).not.toHaveBeenCalled();
  });

  it('returns 500 while a tombstoned cleanup remains retryable', async () => {
    mocks.deleteOwnedMaterial.mockRejectedValue(new Error('byte cleanup failed'));
    const response = await remove();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
  });
});
