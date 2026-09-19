import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  getSessionMaterial: vi.fn(),
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

import { GET } from '@/app/api/materials/[id]/route';

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
});

describe('GET /api/materials/[id]', () => {
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
