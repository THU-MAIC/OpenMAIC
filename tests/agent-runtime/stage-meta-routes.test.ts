import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  accessRow: null as Record<string, unknown> | null,
  updatedRows: [] as unknown[],
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      query: vi.fn(async (text: string) => {
        if (text.includes('UPDATE stage_meta')) {
          return { rows: mocks.updatedRows };
        }
        if (text.includes('LEFT JOIN stage_meta')) {
          if (!mocks.accessRow) return { rows: [] };
          return { rows: [mocks.accessRow] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(),
        release: vi.fn(),
      })),
    },
  }),
}));

import { GET as getStageMeta } from '@/app/api/stage-meta/[stageId]/route';
import { GET as getStatus } from '@/app/api/stages/[id]/status/route';
import { POST as postGenerationComplete } from '@/app/api/stages/[id]/generation-complete/route';
import { POST as postPublish } from '@/app/api/stages/[id]/publish/route';
import { POST as postUnpublish } from '@/app/api/stages/[id]/unpublish/route';

const STAGE_ID = 'stage-1';
const stageMetaParams = (stageId: string) => ({ params: Promise.resolve({ stageId }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.accessRow = {
    meta_owner_id: 'owner-1',
    meta_is_public: false,
    meta_published_at: null,
    meta_generation_complete: false,
    meta_deleted_at: null,
    document_name: 'Course',
  };
  mocks.updatedRows = [{ stage_id: STAGE_ID }];
});

describe('GET /api/stage-meta/[stageId]', () => {
  it('returns the per-viewer facts for the owner', async () => {
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      isOwner: true,
      isPublic: false,
      publishedAt: null,
      generationComplete: false,
      source: 'document',
    });
  });

  it('reports a visitor as non-owner', async () => {
    mocks.accessRow!.meta_owner_id = 'someone-else';
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    await expect(response.json()).resolves.toMatchObject({ isOwner: false });
  });

  it('answers 404 for an absent or tombstoned course', async () => {
    mocks.accessRow = {
      meta_owner_id: null,
      meta_is_public: false,
      meta_published_at: null,
      meta_generation_complete: false,
      meta_deleted_at: null,
      document_name: null,
    };
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('gates on the configured runtime', async () => {
    mocks.runtimeConfigured = false;
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/stages/[id]/status', () => {
  it('returns the public state without auth', async () => {
    mocks.accessRow!.meta_is_public = true;
    mocks.accessRow!.meta_published_at = 1_700_000_000_000;
    const response = await getStatus(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/status`),
      params(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      isPublic: true,
      publishedAt: 1_700_000_000_000,
    });
  });

  it('answers 404 for a missing course', async () => {
    mocks.accessRow = {
      meta_owner_id: null,
      meta_is_public: false,
      meta_published_at: null,
      meta_generation_complete: false,
      meta_deleted_at: null,
      document_name: null,
    };
    const response = await getStatus(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/status`),
      params(STAGE_ID),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/stages/[id]/generation-complete', () => {
  it('marks the owner’s course generation-complete', async () => {
    const response = await postGenerationComplete(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/generation-complete`, {
        method: 'POST',
      }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('forbids a visitor', async () => {
    mocks.accessRow!.meta_owner_id = 'someone-else';
    const response = await postGenerationComplete(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/generation-complete`, {
        method: 'POST',
      }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
  });
});

describe('POST /api/stages/[id]/publish and unpublish', () => {
  it('publishes an owner’s private course and returns the timestamp', async () => {
    const response = await postPublish(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/publish`, { method: 'POST' }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; publishedAt: number; name: string };
    expect(body).toMatchObject({ success: true, name: 'Course' });
    expect(typeof body.publishedAt).toBe('number');
  });

  it('unpublishes and clears the timestamp', async () => {
    mocks.accessRow!.meta_is_public = true;
    mocks.accessRow!.meta_published_at = 1_700_000_000_000;
    const response = await postUnpublish(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/unpublish`, { method: 'POST' }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('refuses an anonymous owner with login_required', async () => {
    mocks.resolveRequestOwnerId.mockReturnValue('anon:00000000-0000-4000-8000-000000000000');
    const response = await postPublish(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/publish`, { method: 'POST' }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'login_required' });
  });
});
