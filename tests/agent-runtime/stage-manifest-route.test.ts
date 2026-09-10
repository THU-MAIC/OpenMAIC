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

import { GET } from '@/app/api/stages/[id]/manifest/route';

const STAGE_ID = 'stage-1';

function call(id = STAGE_ID) {
  const req = new NextRequest(`http://localhost/api/stages/${id}/manifest`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
});

describe('GET /api/stages/[id]/manifest', () => {
  it('returns the per-stage and per-scene revisions', async () => {
    mocks.fakeStore!.docs.set(
      STAGE_ID,
      makeDocument(STAGE_ID, 'Course', [
        makeSlideScene('scene-1', STAGE_ID, 1),
        makeSlideScene('scene-2', STAGE_ID, 2),
      ]),
    );
    mocks.fakeStore!.stageRevs.set(STAGE_ID, 7);
    mocks.fakeStore!.sceneRevs.set(
      STAGE_ID,
      new Map([
        ['scene-1', 3],
        ['scene-2', 5],
      ]),
    );

    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rev: 7,
      scenes: [
        { id: 'scene-1', order: 1, rev: 3 },
        { id: 'scene-2', order: 2, rev: 5 },
      ],
    });
  });

  it('serves per-scene revisions independently of the stage revision', async () => {
    const document = makeDocument(STAGE_ID, 'Course', [
      makeSlideScene('scene-1', STAGE_ID, 1),
      makeSlideScene('scene-2', STAGE_ID, 2),
    ]);
    mocks.fakeStore!.docs.set(STAGE_ID, document);
    mocks.fakeStore!.stageRevs.set(STAGE_ID, 10);
    mocks.fakeStore!.sceneRevs.set(
      STAGE_ID,
      new Map([
        ['scene-1', 2],
        ['scene-2', 9],
      ]),
    );

    const body = await (await call()).json();
    expect(body.rev).toBe(10);
    expect(body.scenes).toEqual([
      { id: 'scene-1', order: 1, rev: 2 },
      { id: 'scene-2', order: 2, rev: 9 },
    ]);
  });

  it('answers 404 for a missing or foreign stage', async () => {
    const response = await call('stage-absent');
    expect(response.status).toBe(404);
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call()).status).toBe(404);
  });
});
