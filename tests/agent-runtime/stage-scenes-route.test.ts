import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { createFakeDocumentStore } from './_fake-document-store';
import { makeDocument, makeSlideScene } from './_stage-fixtures';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));

import { GET, MAX_BATCH_SCENE_IDS } from '@/app/api/stages/[id]/scenes/route';

const STAGE_ID = 'stage-1';

function call(query = '') {
  const req = new NextRequest(`http://localhost/api/stages/${STAGE_ID}/scenes${query}`);
  return GET(req, { params: Promise.resolve({ id: STAGE_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
  mocks.fakeStore.docs.set(
    STAGE_ID,
    makeDocument(STAGE_ID, 'Course', [
      makeSlideScene('scene-1', STAGE_ID, 1, 'Intro'),
      makeSlideScene('scene-2', STAGE_ID, 2, 'Body'),
      makeSlideScene('scene-3', STAGE_ID, 3, 'Quiz'),
    ]),
  );
});

describe('GET /api/stages/[id]/scenes?ids=', () => {
  it('returns exactly the requested scenes in document order', async () => {
    const response = await call('?ids=scene-2,scene-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scenes: [
        expect.objectContaining({ id: 'scene-1', title: 'Intro' }),
        expect.objectContaining({ id: 'scene-2', title: 'Body' }),
      ],
    });
  });

  it('omits requested ids that do not exist', async () => {
    const response = await call('?ids=scene-1,scene-ghost');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scenes.map((scene: { id: string }) => scene.id)).toEqual(['scene-1']);
  });

  it('deduplicates repeated ids', async () => {
    const response = await call('?ids=scene-1,scene-1,scene-2');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scenes.map((scene: { id: string }) => scene.id)).toEqual(['scene-1', 'scene-2']);
  });

  it('rejects an empty ids list', async () => {
    for (const query of ['?ids=', '?ids=,,', '']) {
      const response = await call(query);
      expect(response.status).toBe(400);
    }
  });

  it('rejects more than the batch cap without truncating', async () => {
    const ids = Array.from({ length: MAX_BATCH_SCENE_IDS + 1 }, (_, index) => `scene-${index}`);
    const response = await call(`?ids=${ids.join(',')}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });
  });

  it('answers 404 for a missing or foreign stage', async () => {
    const req = new NextRequest('http://localhost/api/stages/stage-absent/scenes?ids=scene-1');
    const response = await GET(req, { params: Promise.resolve({ id: 'stage-absent' }) });
    expect(response.status).toBe(404);
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call('?ids=scene-1')).status).toBe(404);
  });
});
