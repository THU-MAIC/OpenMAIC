import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/classroom must reject payloads whose scenes are not DSL-shaped
// (400, before persistence) and must sanitize HTML-bearing element content
// before it reaches storage; GET must run the same sanitizer on content that
// was stored before this change.

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

function slideScene(element?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'scene-1',
    stageId: 'abc-123_XY',
    title: 'Scene 1',
    order: 0,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#333333',
          fontName: 'Microsoft YaHei',
        },
        elements: element ? [element] : [],
      },
    },
  };
}

const stage = { id: 'abc-123_XY', name: 'Lesson', createdAt: 0, updatedAt: 0 };

function postClassroom(body: unknown) {
  return new NextRequest('http://localhost/api/classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/classroom — DSL shape validation', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.persistClassroom.mockReset();
    mocks.readClassroom.mockReset();
    mocks.persistClassroom.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
    }));
  });

  it('rejects a body whose scenes is not an array with a 400 and never persists', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(postClassroom({ stage, scenes: 'not-an-array' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid classroom scenes: must be an array',
    });
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('rejects a scene that does not have the shape the DSL declares with a 400', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({
        stage,
        scenes: [{ id: 'scene-1', type: 'slide', content: { type: 'slide' } }],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid classroom scene at index 0',
    });
    expect(typeof json.details).toBe('string');
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('rejects an unknown scene type with a 400', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({
        stage,
        scenes: [
          {
            id: 'scene-1',
            stageId: 'abc-123_XY',
            title: 'Scene 1',
            order: 0,
            type: 'holodeck',
            content: { type: 'holodeck' },
          },
        ],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid classroom scene at index 0',
    });
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });
});

describe('POST /api/classroom — sanitization before persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.persistClassroom.mockReset();
    mocks.readClassroom.mockReset();
    mocks.persistClassroom.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
    }));
  });

  it('persists sanitized element content: no handler survives, markup stays', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const res = await POST(
      postClassroom({
        stage,
        scenes: [
          slideScene({
            type: 'text',
            id: 'el-1',
            content:
              '<p style="color:#ff0000">Keep <strong>this</strong></p><p><img src="x" onerror="alert(1)"><script>alert(2)</script>tail</p>',
            left: 50,
            top: 50,
            width: 900,
            height: 100,
            rotate: 0,
            defaultFontName: 'Microsoft YaHei',
            defaultColor: '#333333',
          }),
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);
    const [persisted] = mocks.persistClassroom.mock.calls[0];
    const scene = persisted.scenes[0] as {
      content: { canvas: { elements: Array<{ content: string }> } };
    };
    const content = scene.content.canvas.elements[0].content;

    expect(content).not.toContain('onerror');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('<img');
    expect(content).toContain('<strong>this</strong>');
    expect(content).toContain('color:#ff0000');
    expect(content).toContain('tail');
  });
});

describe('GET /api/classroom — legacy stored content is cleaned on the way out', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.persistClassroom.mockReset();
    mocks.readClassroom.mockReset();
  });

  it('serves sanitized content for classrooms stored before this change', async () => {
    mocks.readClassroom.mockResolvedValue({
      id: 'abc-123_XY',
      createdAt: '2024-01-01T00:00:00.000Z',
      stage,
      scenes: [
        slideScene({
          type: 'text',
          id: 'el-1',
          content: '<p>legacy <strong>bold</strong></p><p><img src=x onerror="alert(1)">x</p>',
          left: 50,
          top: 50,
          width: 900,
          height: 100,
          rotate: 0,
          defaultFontName: 'Microsoft YaHei',
          defaultColor: '#333333',
        }),
      ],
    });

    const { GET } = await import('@/app/api/classroom/route');
    const request = new NextRequest('http://localhost/api/classroom?id=abc-123_XY');
    const res = await GET(request);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    const classroom = json.classroom as {
      scenes: Array<{ content: { canvas: { elements: Array<{ content: string }> } } }>;
    };
    const content = classroom.scenes[0].content.canvas.elements[0].content;

    expect(content).not.toContain('onerror');
    expect(content).not.toContain('<img');
    expect(content).toContain('<strong>bold</strong>');
    expect(content).toContain('legacy');
  });
});
