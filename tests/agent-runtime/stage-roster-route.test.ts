import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { createFakeDocumentStore } from './_fake-document-store';
import { makeDocument, makeSlideScene } from './_stage-fixtures';

const mocks = vi.hoisted(() => ({
  persistenceConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => mocks.persistenceConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));

import { GET } from '@/app/api/stages/[id]/roster/route';

const STAGE_ID = 'stage-1';

function call(id = STAGE_ID) {
  const req = new NextRequest(`http://localhost/api/stages/${id}/roster`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persistenceConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
});

describe('GET /api/stages/[id]/roster', () => {
  it('returns the roster and nothing else of the course', async () => {
    const document = makeDocument(STAGE_ID, 'Course', [makeSlideScene('scene-1', STAGE_ID, 1)]);
    const generatedAgentConfigs = [
      {
        id: 'gen-t',
        name: 'Teacher Chen',
        role: 'teacher',
        persona: 'Patient.',
        avatar: '/avatars/teacher.png',
        color: '#000000',
        priority: 10,
      },
    ];
    document.stage = { ...document.stage, agentIds: ['gen-t'], generatedAgentConfigs };
    mocks.fakeStore!.docs.set(STAGE_ID, document);

    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentIds: ['gen-t'],
      generatedAgentConfigs,
    });
  });

  it('answers an empty roster for a course that never stored one', async () => {
    mocks.fakeStore!.docs.set(STAGE_ID, makeDocument(STAGE_ID, 'Course'));
    await expect((await call()).json()).resolves.toEqual({});
  });

  it('answers 404 for a missing or foreign stage', async () => {
    expect((await call('stage-absent')).status).toBe(404);
  });

  it('answers 404 when server persistence is not configured', async () => {
    mocks.persistenceConfigured = false;
    expect((await call()).status).toBe(404);
  });
});
