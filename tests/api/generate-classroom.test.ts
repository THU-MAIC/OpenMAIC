import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  buildRequestOrigin: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postGenerateClassroom(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new NextRequest('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request);
}

describe('POST /api/generate-classroom', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.after.mockReset();
    mocks.buildRequestOrigin.mockReset();
    mocks.createClassroomGenerationJob.mockReset();
    mocks.runClassroomGenerationJob.mockReset();

    mocks.buildRequestOrigin.mockReturnValue('http://localhost');
    mocks.createClassroomGenerationJob.mockResolvedValue({
      status: 'queued',
      step: 'queued',
      message: 'Classroom generation job queued',
    });
  });

  it('returns 400 when pdfContent is a string instead of the documented object', async () => {
    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent: 'plain text',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Invalid pdfContent: expected { text: string; images: string[] }',
    });
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['missing text', { images: [] }],
    ['non-string text', { text: 123, images: [] }],
    ['missing images', { text: 'parsed text' }],
    ['non-array images', { text: 'parsed text', images: 'image.png' }],
    ['non-string image entries', { text: 'parsed text', images: ['image.png', 123] }],
  ])('returns 400 when pdfContent is %s', async (_label, pdfContent) => {
    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent,
    });

    expect(res.status).toBe(400);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('preserves the normal job submission path for valid pdfContent', async () => {
    const pdfContent = { text: 'parsed text', images: ['image-1.png'] };

    const res = await postGenerateClassroom({
      requirement: 'Generate from this PDF',
      pdfContent,
    });
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual(
      expect.objectContaining({
        success: true,
        status: 'queued',
        step: 'queued',
        pollUrl: expect.stringMatching(/^http:\/\/localhost\/api\/generate-classroom\//),
      }),
    );
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requirement: 'Generate from this PDF',
        pdfContent,
      }),
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });
});
