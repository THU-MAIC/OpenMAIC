import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import { createFakeDocumentStore } from './_fake-document-store';

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

import { GET, POST } from '@/app/api/stages/route';

const now = 1_700_000_000_000;

function makeDocument(
  id: string,
  name: string,
): {
  stage: { id: string; name: string; createdAt: number; updatedAt: number };
  scenes: AppScene[];
  outline: AppDocumentOutline;
} {
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
});

describe('GET /api/stages', () => {
  it('lists every stage document owned by the caller as summaries', async () => {
    mocks.fakeStore!.docs.set('stage-aaa', makeDocument('stage-aaa', 'Day 1'));
    mocks.fakeStore!.docs.set('stage-bbb', makeDocument('stage-bbb', 'Day 2'));

    const response = await GET(new NextRequest('http://localhost/api/stages'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stages: [
        {
          id: 'stage-aaa',
          name: 'Day 1',
          createdAt: now,
          updatedAt: now,
          sceneCount: 0,
        },
        {
          id: 'stage-bbb',
          name: 'Day 2',
          createdAt: now,
          updatedAt: now,
          sceneCount: 0,
        },
      ],
    });
    expect(mocks.resolveRequestOwnerId).toHaveBeenCalledOnce();
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    const response = await GET(new NextRequest('http://localhost/api/stages'));
    expect(response.status).toBe(404);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it('rides the owner cookie minted for the request', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce((_req, responseHeaders: Headers) => {
      responseHeaders.set('Set-Cookie', 'anonymous_id=anon-2; Path=/');
      return 'anon:anon-2';
    });
    const response = await GET(new NextRequest('http://localhost/api/stages'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=anon-2');
  });
});

describe('POST /api/stages', () => {
  it('creates an empty stage shell and returns its summary', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  Day 1 — Python  ' }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.stage.id).toMatch(/^stage-[A-Za-z0-9_-]{10,}$/);
    expect(body.stage).toMatchObject({
      name: 'Day 1 — Python',
      sceneCount: 0,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    expect(mocks.fakeStore!.saveCalls).toHaveLength(1);
    const saved = mocks.fakeStore!.saveCalls[0]!;
    expect(saved.stage.id).toBe(body.stage.id);
    expect(saved.stage.name).toBe('Day 1 — Python');
    expect(saved.scenes).toEqual([]);
    expect(saved.outline).toMatchObject({
      outlines: [],
      requirement: 'Day 1 — Python',
      generationComplete: false,
    });
  });

  it('stores an optional description trimmed of surrounding whitespace', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Day 1', description: '  first unit  ' }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).stage.description).toBe('first unit');
    expect(mocks.fakeStore!.saveCalls[0]!.stage.description).toBe('first unit');
  });

  it.each([
    ['missing name', { description: 'x' }],
    ['empty name', { name: '   ' }],
    ['non-string name', { name: 42 }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it('rejects a name over the 120-char cap', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(121) }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.fakeStore!.saveCalls).toHaveLength(0);
  });

  it('accepts a name at exactly the 120-char cap', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(120) }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it('rejects a non-string description', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Day 1', description: 7 }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a non-JSON body without touching the owner seam', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    const response = await POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Day 1' }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
