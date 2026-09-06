import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/classroom must reject an id that would escape the classrooms
// directory before any persistence happens, and must keep accepting generated
// uuids and ordinary allowlisted ids.

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

function postClassroom(stage: Record<string, unknown>, scenes: unknown[] = []) {
  const request = new NextRequest('http://localhost/api/classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, scenes }),
  });
  return request;
}

describe('POST /api/classroom — id validation before persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.persistClassroom.mockReset();
    mocks.readClassroom.mockReset();
    mocks.persistClassroom.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
    }));
  });

  it('returns 400 for a traversal-style stage id and never persists', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({
        id: '../../../../tmp/openmaic-escape',
        title: 'Lesson',
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid classroom id',
    });
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('accepts an omitted stage id and persists with a generated uuid', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom(
        {
          title: 'Lesson',
          type: 'slide',
        },
        [
          {
            id: 'scene-1',
            stageId: 'classroom-1',
            title: 'Scene 1',
            order: 0,
            type: 'slide',
            content: { type: 'slide', canvas: {} },
          },
        ],
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({ success: true });
    expect(typeof json.id).toBe('string');
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);
    const [persisted] = mocks.persistClassroom.mock.calls[0];
    expect(persisted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(persisted.stage.id).toBe(persisted.id);
  });

  it('still persists an ordinary allowlisted id', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom(
        {
          id: 'abc-123_XY',
          title: 'Lesson',
        },
        [
          {
            id: 'scene-1',
            stageId: 'abc-123_XY',
            title: 'Scene 1',
            order: 0,
            type: 'slide',
            content: { type: 'slide', canvas: {} },
          },
        ],
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toMatchObject({ success: true, id: 'abc-123_XY' });
    expect(mocks.persistClassroom).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc-123_XY' }),
      'http://localhost',
    );
  });
});
