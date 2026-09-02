import { EventEmitter } from 'events';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: { realpath: mocks.realpath, stat: mocks.stat },
  createReadStream: mocks.createReadStream,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GET } from '@/app/api/classroom-media/[classroomId]/[...path]/route';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';

const CLASSROOM_ID = 'classroom-1';
const FILE_SIZE = 100;

function fakeReadStream(chunks: string[]) {
  const emitter = new EventEmitter() as EventEmitter & { destroy: () => void };
  emitter.destroy = vi.fn();
  queueMicrotask(() => {
    for (const chunk of chunks) emitter.emit('data', Buffer.from(chunk));
    emitter.emit('end');
  });
  return emitter;
}

function get(range?: string) {
  const req = new Request('http://localhost/api/classroom-media/classroom-1/media/clip.mp4', {
    headers: range ? { Range: range } : {},
  });
  return GET(req as unknown as NextRequest, {
    params: Promise.resolve({ classroomId: CLASSROOM_ID, path: ['media', 'clip.mp4'] }),
  });
}

describe('GET /api/classroom-media range support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.realpath.mockResolvedValue(path.join(CLASSROOMS_DIR, CLASSROOM_ID, 'media', 'clip.mp4'));
    mocks.stat.mockResolvedValue({ isFile: () => true, size: FILE_SIZE });
    mocks.createReadStream.mockImplementation((_file: string, options?: { start?: number }) =>
      fakeReadStream(['x'.repeat(options?.start === undefined ? FILE_SIZE : 10)]),
    );
  });

  it('serves the full body with 200 and advertises range support when no Range is sent', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(FILE_SIZE));
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.any(String));
    expect(await res.text()).toBe('x'.repeat(FILE_SIZE));
  });

  it('answers a byte range with 206, Content-Range, and a bounded read stream', async () => {
    const res = await get('bytes=10-19');

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 10-19/${FILE_SIZE}`);
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.any(String), {
      start: 10,
      end: 19,
    });
    expect(await res.text()).toBe('x'.repeat(10));
  });

  it('supports suffix ranges (last N bytes)', async () => {
    const res = await get('bytes=-10');

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 90-99/${FILE_SIZE}`);
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.any(String), {
      start: 90,
      end: 99,
    });
  });

  it('clamps an over-long range to the representation size', async () => {
    const res = await get('bytes=90-999');

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 90-99/${FILE_SIZE}`);
    expect(res.headers.get('Content-Length')).toBe('10');
  });

  it('answers 416 with the full size when the range is unsatisfiable', async () => {
    const res = await get('bytes=200-');

    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${FILE_SIZE}`);
    // A cached 416 would poison the media URL for later valid requests.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.createReadStream).not.toHaveBeenCalled();
  });

  it('ignores unsupported range units and serves the full body', async () => {
    const res = await get('items=0-9');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(FILE_SIZE));
  });
});
