import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { GET as getIdentity, POST as restoreIdentity } from '@/app/api/teacher/identity/route';
import { isSameOriginTeacherRequest } from '@/lib/server/teacher/request-origin';
import { readTeacherStudentRequest } from '@/lib/server/teacher/student-http';

vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => true }));

const AUTHORITY = '127.0.0.1:3000';
const ORIGIN = `http://${AUTHORITY}`;
const REQUEST = {
  requestId: '13fe7cc0-4fd9-4ad4-8455-105c97352dd5',
  nickname: 'Fictional loopback student',
  grade: null,
  examYear: null,
  region: null,
};

function request(headers: Record<string, string> = {}, body: unknown = REQUEST) {
  return new NextRequest(`${ORIGIN}/api/teacher/students`, {
    method: 'POST',
    headers: {
      host: AUTHORITY,
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('teacher browser request origin', () => {
  it('accepts actual Host when Next normalizes the loopback URL to localhost', async () => {
    const req = request();
    expect(req.nextUrl.origin).toBe('http://localhost:3000');
    expect(new URL(req.url).origin).toBe('http://localhost:3000');
    expect(isSameOriginTeacherRequest(req)).toBe(true);
    expect(await readTeacherStudentRequest(req)).toEqual(REQUEST);
  });

  it.each<Record<string, string>>([
    { origin: 'http://localhost:3000' },
    { origin: 'http://127.0.0.1:3001' },
    { origin: 'https://127.0.0.1:3000' },
    { origin: 'https://foreign.example' },
    { origin: 'null' },
    { host: '127.0.0.1:3001' },
    { host: '127.0.0.1:3000/ignored' },
    { host: '127.0.0.1:3000@foreign.example' },
    { host: '127.0.0.1:3000,foreign.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ])('rejects other origins and invalid authority: %j', async (headers) => {
    const req = request(headers);
    expect(isSameOriginTeacherRequest(req)).toBe(false);
    await expect(readTeacherStudentRequest(req)).rejects.toMatchObject({
      code: 'TEACHER_STUDENT_ORIGIN_REJECTED',
    });
  });

  it('ignores forwarded authority and protocol when checking the browser origin', () => {
    expect(
      isSameOriginTeacherRequest(
        request({
          'x-forwarded-host': 'foreign.example',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginTeacherRequest(
        request({
          origin: 'https://foreign.example',
          'x-forwarded-host': 'foreign.example',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(false);
  });

  it('uses Host with an internal URL and supports HTTPS and IPv6 authorities', () => {
    for (const origin of [
      'http://teacher.example:8080',
      'https://teacher.example',
      'http://[::1]:3000',
    ]) {
      const external = new URL(origin);
      const req = new Request(`${external.protocol}//internal.invalid/api/teacher/students`, {
        headers: { host: external.host, origin: external.origin },
      });
      expect(isSameOriginTeacherRequest(req)).toBe(true);
    }
  });

  it('preserves separate identity origin requirements', async () => {
    const sameOriginGet = new NextRequest(`${ORIGIN}/api/teacher/identity`, {
      headers: { host: AUTHORITY, 'sec-fetch-site': 'same-origin' },
    });
    expect((await getIdentity(sameOriginGet)).status).toBe(200);
    expect(
      (
        await getIdentity(
          new NextRequest(`${ORIGIN}/api/teacher/identity`, {
            headers: { host: AUTHORITY, origin: ORIGIN },
          }),
        )
      ).status,
    ).toBe(200);

    const restore = await restoreIdentity(
      request(
        {},
        {
          recoveryCode: 'openmaic-teacher-v1:a652e716-0e2e-47f5-8432-4ee60f6f0977',
        },
      ),
    );
    expect(restore.status).toBe(200);
    expect(await restore.json()).toEqual({ restored: true });
    expect((await restoreIdentity(request({ origin: 'http://127.0.0.1:3001' }))).status).toBe(403);
    expect((await getIdentity(request({ origin: 'https://foreign.example' }))).status).toBe(403);
  });
});
