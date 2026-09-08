import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '@/app/api/teacher/students/route';
import { GET as getStudent, PATCH } from '@/app/api/teacher/students/[profileId]/route';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { TEACHER_STUDENT_ROSTER_KIND, validateTeacherRosterEvent } from '@/lib/teacher/students';

const database = vi.hoisted(() => ({ store: undefined as RuntimeStore | undefined }));
const configured = vi.hoisted(() => vi.fn(() => true));
const provider = vi.hoisted(() => vi.fn(async () => ({ runtimeStore: database.store })));

vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: configured }));
vi.mock('@/lib/persistence/server-provider', () => ({ getServerPersistenceProvider: provider }));

const ORIGIN = 'http://localhost:3000';
const COOKIE = 'anonymous_id=13fe7cc0-4fd9-4ad4-8455-105c97352dd5';
const INPUT = {
  requestId: '242c3d7e-9e25-457a-9e56-efca1f924073',
  nickname: 'Fictional HTTP student',
  grade: null,
  examYear: null,
  region: null,
};

function req(
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
  path = '/api/teacher/students',
) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

beforeEach(() => {
  configured.mockReturnValue(true);
  provider.mockReset().mockImplementation(async () => ({ runtimeStore: database.store }));
  database.store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `fictional-student-http-${Math.random()}`,
    payloadValidators: {
      ...APP_RUNTIME_PAYLOAD_VALIDATORS,
      [TEACHER_STUDENT_ROSTER_KIND]: validateTeacherRosterEvent,
    },
  });
});

describe('teacher students HTTP routes', () => {
  it('creates, replays, reloads and edits under the same owner cookie', async () => {
    const response = await POST(req('POST', INPUT));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('set-cookie')).toContain(COOKIE);
    const { student } = await response.json();
    expect(student.profile.grade.status).toBe('unknown');
    const replay = await POST(req('POST', INPUT));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ student });
    expect(await (await GET(req())).json()).toEqual({ students: [student] });
    const context = { params: Promise.resolve({ profileId: student.profile.profileId }) };
    const updated = await PATCH(
      req('PATCH', {
        nickname: 'Fictional edited student',
        grade: 9,
        examYear: null,
        region: null,
        archived: true,
        expectedUpdatedAt: student.profile.updatedAt,
      }),
      context,
    );
    expect(updated.status).toBe(200);
    const updatedStudent = (await updated.json()).student;
    expect(updatedStudent.archived).toBe(true);
    expect(updatedStudent.profile.grade.value).toBe(9);
    expect(await (await getStudent(req(), context)).json()).toEqual({ student: updatedStudent });
  });

  it('returns no student data to a different cookie and does not accept a supplied owner', async () => {
    const { student } = await (await POST(req('POST', INPUT))).json();
    const headers = { cookie: 'anonymous_id=aa583ee3-e74c-4089-8283-65e070cb2c04' };
    expect(await (await GET(req('GET', undefined, headers))).json()).toEqual({ students: [] });
    const denied = await getStudent(req('GET', undefined, headers), {
      params: Promise.resolve({ profileId: student.profile.profileId }),
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ errorCode: 'TEACHER_STUDENT_NOT_FOUND' });
    const injected = await POST(req('POST', { ...INPUT, ownerId: 'injected' }));
    expect(injected.status).toBe(400);
    expect(await injected.json()).toEqual({ errorCode: 'TEACHER_STUDENT_INPUT_INVALID' });
  });

  it.each<Record<string, string>>([
    { origin: 'https://unrelated.invalid' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ])('rejects cross-origin writes before opening storage: %j', async (headers) => {
    const response = await POST(req('POST', INPUT, headers));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ errorCode: 'TEACHER_STUDENT_ORIGIN_REJECTED' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects oversized, non-JSON, malformed and invalid UTF-8 request bodies', async () => {
    const requests = [
      req('POST', { ...INPUT, nickname: 'x'.repeat(8192) }),
      req('POST', INPUT, { 'content-type': 'text/plain' }),
      new NextRequest(`${ORIGIN}/api/teacher/students`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
      new NextRequest(`${ORIGIN}/api/teacher/students`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([0xc3, 0x28]),
      }),
    ];
    for (const request of requests) {
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ errorCode: 'TEACHER_STUDENT_INPUT_INVALID' });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('reports stale edits as 409 with no internal details', async () => {
    const { student } = await (await POST(req('POST', INPUT))).json();
    const response = await PATCH(
      req('PATCH', {
        nickname: INPUT.nickname,
        grade: null,
        examYear: null,
        region: null,
        archived: false,
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
      { params: Promise.resolve({ profileId: student.profile.profileId }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ errorCode: 'TEACHER_STUDENT_CONFLICT' });
  });

  it('returns private 503 responses when disabled or persistence fails without leaking errors', async () => {
    configured.mockReturnValue(false);
    const disabled = await GET(req());
    expect(disabled.status).toBe(503);
    expect(disabled.headers.get('set-cookie')).toContain(COOKIE);
    expect(provider).not.toHaveBeenCalled();
    configured.mockReturnValue(true);
    provider.mockRejectedValueOnce(new Error('fictional internal connection details'));
    const failed = await GET(req());
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('private, no-store');
    expect(await failed.json()).toEqual({ errorCode: 'TEACHER_STUDENT_UNAVAILABLE' });
  });
});
