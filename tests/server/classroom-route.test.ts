import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/classroom must choose the storage id itself instead of trusting the
// caller: a client-supplied stage.id is public share-URL material, so echoing
// it would let any visitor name (and previously replace) an existing
// classroom. The endpoint still rejects malformed scenes and returns the
// server-generated id in the response.

const mocks = vi.hoisted(() => ({
  persistClassroom: vi.fn(),
  readClassroom: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    persistClassroom: mocks.persistClassroom,
    readClassroom: mocks.readClassroom,
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{10}$/;

function postClassroom(stage: Record<string, unknown>, scenes: unknown[] = []) {
  const request = new NextRequest('http://localhost/api/classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, scenes }),
  });
  return request;
}

function slideScene(stageId: string) {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene 1',
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: {} },
  };
}

describe('POST /api/classroom — server-generated id', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.persistClassroom.mockReset();
    mocks.readClassroom.mockReset();
    mocks.persistClassroom.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
    }));
  });

  it('ignores a traversal-style stage id and persists under a server-generated id', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({
        id: '../../../../tmp/openmaic-escape',
        title: 'Lesson',
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({ success: true });
    expect(json.id).toMatch(SERVER_ID_PATTERN);
    expect(json.id).not.toBe('../../../../tmp/openmaic-escape');
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);

    const [persisted, baseUrl, options] = mocks.persistClassroom.mock.calls[0];
    expect(persisted.id).toBe(json.id);
    expect(persisted.stage.id).toBe(json.id);
    expect(baseUrl).toBe('http://localhost');
    expect(options).toEqual({ exclusive: true });
  });

  it('accepts an omitted stage id and persists with a generated id', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom(
        {
          title: 'Lesson',
          type: 'slide',
        },
        [slideScene('client-chosen-id')],
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({ success: true });
    expect(json.id).toMatch(SERVER_ID_PATTERN);
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);

    const [persisted] = mocks.persistClassroom.mock.calls[0];
    expect(persisted.id).toBe(json.id);
    expect(persisted.stage.id).toBe(persisted.id);
    // Scenes are re-bound to the id the server chose, keeping the persisted
    // document internally consistent.
    expect(persisted.scenes[0].stageId).toBe(persisted.id);
  });

  it('ignores an ordinary allowlisted client id and mints a different one', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({ id: 'abc-123_XY', title: 'Lesson' }, [slideScene('abc-123_XY')]),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({ success: true });
    expect(json.id).not.toBe('abc-123_XY');
    expect(json.id).toMatch(SERVER_ID_PATTERN);

    const [persisted] = mocks.persistClassroom.mock.calls[0];
    expect(persisted.id).toBe(json.id);
    expect(persisted.stage.id).toBe(json.id);
    expect(persisted.scenes[0].stageId).toBe(json.id);
  });
});
