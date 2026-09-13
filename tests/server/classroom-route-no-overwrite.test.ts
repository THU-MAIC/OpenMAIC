import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { NextRequest } from 'next/server';
import type { Stage } from '@/lib/types/stage';

// The legacy file store accepted a caller-chosen id and replaced any existing
// file with that id. These tests point the real storage layer at a throwaway
// directory and assert POST can only ever create a new classroom: a request
// that names an incumbent id must not change the incumbent's bytes.

const mocks = vi.hoisted(() => ({
  generateClassroomId: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    generateClassroomId: mocks.generateClassroomId,
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

type StorageModule = typeof import('@/lib/server/classroom-storage');

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{10}$/;

let tmpDir: string;
let storage: StorageModule;

function makeRequest(stage: Record<string, unknown>, scenes: unknown[] = []) {
  return new NextRequest('http://localhost/api/classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, scenes }),
  });
}

function slideScene(stageId: string, title: string) {
  return {
    id: `scene-${title}`,
    stageId,
    title,
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: {} },
  };
}

function storedStage(id: string, name: string): Stage {
  return { id, name, createdAt: 0, updatedAt: 0 } as unknown as Stage;
}

async function readRaw(id: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, `${id}.json`), 'utf-8');
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-classrooms-'));
  process.env.OPENMAIC_CLASSROOMS_DIR = tmpDir;
  vi.resetModules();
  storage = await import('@/lib/server/classroom-storage');
});

afterAll(async () => {
  delete process.env.OPENMAIC_CLASSROOMS_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.generateClassroomId.mockReset();
  mocks.generateClassroomId.mockImplementation(() => nanoid(10));
});

describe('POST /api/classroom — create never overwrites', () => {
  it('leaves the incumbent classroom unchanged when a second POST carries its id', async () => {
    const { POST } = await import('@/app/api/classroom/route');

    const first = await POST(makeRequest({ title: 'Original' }, [slideScene('client-a', 'a')]));
    const firstJson = (await first.json()) as { id: string };
    expect(first.status).toBe(201);
    expect(firstJson.id).toMatch(SERVER_ID_PATTERN);
    const originalBytes = await readRaw(firstJson.id);

    // The second request names the incumbent id, mimicking a visitor who knows
    // the public share URL.
    const second = await POST(
      makeRequest({ id: firstJson.id, title: 'Replacement' }, [slideScene(firstJson.id, 'b')]),
    );
    const secondJson = (await second.json()) as { id: string };

    expect(second.status).toBe(201);
    expect(secondJson.id).toMatch(SERVER_ID_PATTERN);
    expect(secondJson.id).not.toBe(firstJson.id);

    // The incumbent is byte-for-byte unchanged.
    expect(await readRaw(firstJson.id)).toBe(originalBytes);
    expect((JSON.parse(originalBytes) as { stage: { title: string } }).stage.title).toBe(
      'Original',
    );

    // The replacement landed only under its own new id.
    const replacement = JSON.parse(await readRaw(secondJson.id)) as {
      stage: { id: string; title: string };
    };
    expect(replacement.stage.id).toBe(secondJson.id);
    expect(replacement.stage.title).toBe('Replacement');
  });

  it('exclusive persist rejects EEXIST and leaves the original byte-identical with no temp files', async () => {
    const id = 'exclusive01';
    await storage.persistClassroom(
      { id, stage: storedStage(id, 'Original'), scenes: [] },
      'http://localhost',
      { exclusive: true },
    );
    const before = await fs.readFile(path.join(tmpDir, `${id}.json`));

    await expect(
      storage.persistClassroom(
        { id, stage: storedStage(id, 'Replacement'), scenes: [] },
        'http://localhost',
        { exclusive: true },
      ),
    ).rejects.toMatchObject({ name: 'ClassroomAlreadyExistsError', code: 'EEXIST' });

    const after = await fs.readFile(path.join(tmpDir, `${id}.json`));
    expect(after.equals(before)).toBe(true);
    expect((JSON.parse(after.toString()) as { stage: { name: string } }).stage.name).toBe(
      'Original',
    );

    const leftovers = (await fs.readdir(tmpDir)).filter((entry) => entry.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('retries a colliding generated id and succeeds with a fresh one', async () => {
    const collideId = 'collide001';
    await storage.persistClassroom(
      { id: collideId, stage: storedStage(collideId, 'Incumbent'), scenes: [] },
      'http://localhost',
      { exclusive: true },
    );

    mocks.generateClassroomId
      .mockReturnValueOnce(collideId)
      .mockReturnValueOnce(collideId)
      .mockReturnValueOnce('freshid001');

    const { POST } = await import('@/app/api/classroom/route');
    const res = await POST(makeRequest({ title: 'Newcomer' }, [slideScene('client-x', 'x')]));
    const json = (await res.json()) as { id: string };

    expect(res.status).toBe(201);
    expect(json.id).toBe('freshid001');
    expect(mocks.generateClassroomId).toHaveBeenCalledTimes(3);
    expect((JSON.parse(await readRaw(collideId)) as { stage: { name: string } }).stage.name).toBe(
      'Incumbent',
    );
  });

  it('returns 409 after the bounded retries are exhausted', async () => {
    const collideId = 'collide002';
    await storage.persistClassroom(
      { id: collideId, stage: storedStage(collideId, 'Incumbent'), scenes: [] },
      'http://localhost',
      { exclusive: true },
    );
    mocks.generateClassroomId.mockReturnValue(collideId);

    const { POST } = await import('@/app/api/classroom/route');
    const res = await POST(makeRequest({ title: 'Newcomer' }, [slideScene('client-y', 'y')]));
    const json = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ success: false, error: 'Classroom id collision' });
    expect(mocks.generateClassroomId).toHaveBeenCalledTimes(3);
  });
});
