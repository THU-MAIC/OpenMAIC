import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DocumentNotFoundError, DocumentVersionError } from '@openmaic/storage';

import { createFakeDocumentStore } from './_fake-document-store';
import { FIXED_NOW, makeDocument, makeSlideScene } from './_stage-fixtures';

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

import { DELETE, GET, PATCH, PUT } from '@/app/api/stages/[id]/route';

const STAGE_ID = 'stage-1';

/** NextRequest's own init type, so `signal: null` (DOM RequestInit) is not required. */
type NextInit = ConstructorParameters<typeof NextRequest>[1];

function call(handler: unknown, init: NextInit = {}, id = STAGE_ID) {
  const req = new NextRequest(`http://localhost/api/stages/${id}`, init);
  return (
    handler as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  )(req, { params: Promise.resolve({ id }) });
}

function jsonInit(method: string, body: unknown): NextInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
  mocks.fakeStore.docs.set(
    STAGE_ID,
    makeDocument(STAGE_ID, 'Original Name', [
      makeSlideScene('scene-1', STAGE_ID, 1),
      makeSlideScene('scene-2', STAGE_ID, 2),
    ]),
  );
});

describe('GET /api/stages/[id]', () => {
  it('returns the whole document', async () => {
    const response = await call(GET);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.stage).toMatchObject({ id: STAGE_ID, name: 'Original Name' });
    expect(body.scenes.map((scene: { id: string }) => scene.id)).toEqual(['scene-1', 'scene-2']);
  });

  it('answers 404 for a missing stage', async () => {
    const response = await call(GET, {}, 'stage-absent');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call(GET)).status).toBe(404);
  });
});

describe('PATCH /api/stages/[id]', () => {
  it('renames an owned course and returns the new name', async () => {
    const response = await call(PATCH, jsonInit('PATCH', { name: '  New Name  ' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, name: 'New Name' });

    expect(mocks.fakeStore!.saveCalls).toHaveLength(1);
    const saved = mocks.fakeStore!.saveCalls[0]!;
    expect(saved.stage.name).toBe('New Name');
    expect(saved.stage.updatedAt).toBeGreaterThan(FIXED_NOW);
    // Scenes and outline survive a rename untouched.
    expect(saved.scenes.map((scene) => scene.id)).toEqual(['scene-1', 'scene-2']);
  });

  it.each([
    [
      'non-JSON body',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain' },
        body: 'nope',
      } as NextInit,
    ],
    ['non-string name', jsonInit('PATCH', { name: 42 })],
    ['empty name', jsonInit('PATCH', { name: '   ' })],
    ['missing name', jsonInit('PATCH', {})],
  ])('rejects %s with 400', async (_label, init) => {
    const response = await call(PATCH, init);
    expect(response.status).toBe(400);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it('rejects a name over the 120-char cap', async () => {
    const response = await call(PATCH, jsonInit('PATCH', { name: 'x'.repeat(121) }));
    expect(response.status).toBe(400);
  });

  it('accepts a name at exactly the 120-char cap', async () => {
    const response = await call(PATCH, jsonInit('PATCH', { name: 'x'.repeat(120) }));
    expect(response.status).toBe(200);
  });

  it('answers 404 for a missing or foreign stage (no existence oracle)', async () => {
    const response = await call(PATCH, jsonInit('PATCH', { name: 'X' }), 'stage-absent');
    expect(response.status).toBe(404);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it('answers 404 when the write is refused by the owner scope', async () => {
    mocks.fakeStore!.failNextSaveWith(
      new DocumentNotFoundError(STAGE_ID, 'belongs to another scope'),
    );
    const response = await call(PATCH, jsonInit('PATCH', { name: 'X' }));
    expect(response.status).toBe(404);
  });

  it('answers 400 with the store message when the saved document is invalid', async () => {
    mocks.fakeStore!.failNextSaveWith(new Error('@openmaic/storage: invalid stage: /name: x'));
    const response = await call(PATCH, jsonInit('PATCH', { name: 'X' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errorCode).toBe('INVALID_REQUEST');
    expect(body.details).toContain('@openmaic/storage: invalid stage');
  });

  it('answers 400 for a future-version document', async () => {
    mocks.fakeStore!.failNextSaveWith(
      new DocumentVersionError(STAGE_ID, 'future', '99.0.0', 'written at DSL version 99.0.0'),
    );
    const response = await call(PATCH, jsonInit('PATCH', { name: 'X' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });
  });

  it('answers 500 when the store throws unexpectedly', async () => {
    mocks.fakeStore!.failNextSaveWith(new Error('connection reset'));
    const response = await call(PATCH, jsonInit('PATCH', { name: 'X' }));
    expect(response.status).toBe(500);
  });
});

describe('PUT /api/stages/[id]', () => {
  it('saves a whole document and bumps updatedAt server-side', async () => {
    const document = makeDocument(STAGE_ID, 'Edited', [
      makeSlideScene('scene-1', STAGE_ID, 1),
      makeSlideScene('scene-2', STAGE_ID, 2),
    ]);
    const response = await call(PUT, jsonInit('PUT', document));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    expect(mocks.fakeStore!.saveCalls).toHaveLength(1);
    const saved = mocks.fakeStore!.saveCalls[0]!;
    expect(saved.stage.name).toBe('Edited');
    expect(saved.stage.updatedAt).toBeGreaterThan(FIXED_NOW);
    expect(saved.scenes.map((scene) => scene.id)).toEqual(['scene-1', 'scene-2']);
  });

  it('rejects a body whose stage id does not match the path', async () => {
    const document = makeDocument('stage-other', 'Other');
    const response = await call(PUT, jsonInit('PUT', document));
    expect(response.status).toBe(400);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it.each([
    ['non-object', 42],
    ['missing stage', { scenes: [] }],
    ['missing scenes', { stage: { id: STAGE_ID } }],
    ['non-string stage id', { stage: { id: 7 }, scenes: [] }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await call(PUT, jsonInit('PUT', body));
    expect(response.status).toBe(400);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it('answers 404 for a missing or foreign stage', async () => {
    const document = makeDocument('stage-absent', 'X');
    const response = await call(PUT, jsonInit('PUT', document), 'stage-absent');
    expect(response.status).toBe(404);
  });

  it('answers 404 when the owner scope refuses the write', async () => {
    mocks.fakeStore!.failNextSaveWith(
      new DocumentNotFoundError(STAGE_ID, 'belongs to another scope'),
    );
    const response = await call(PUT, jsonInit('PUT', makeDocument(STAGE_ID, 'X')));
    expect(response.status).toBe(404);
  });

  it('answers 400 when the document fails store validation', async () => {
    mocks.fakeStore!.failNextSaveWith(new Error('@openmaic/storage: invalid scene: /id'));
    const response = await call(PUT, jsonInit('PUT', makeDocument(STAGE_ID, 'X')));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });
  });

  it('rides the owner cookie on success', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce((_req, responseHeaders: Headers) => {
      responseHeaders.set('Set-Cookie', 'anonymous_id=anon-2; Path=/');
      return 'anon:anon-2';
    });
    const response = await call(PUT, jsonInit('PUT', makeDocument(STAGE_ID, 'X')));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=anon-2');
  });
});

describe('DELETE /api/stages/[id]', () => {
  it('removes the course and answers ok', async () => {
    const response = await call(DELETE);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.fakeStore!.docs.has(STAGE_ID)).toBe(false);
  });

  it('is idempotent for an already-absent stage', async () => {
    const response = await call(DELETE, {}, 'stage-absent');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
