import { NextResponse, type NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { isSameOriginTeacherRequest } from '@/lib/server/teacher/request-origin';
import { TeacherStudentError } from '@/lib/teacher/students';

const MAX_BODY_BYTES = 8 * 1024;

export async function readTeacherStudentRequest(req: NextRequest): Promise<unknown> {
  if (!isSameOriginTeacherRequest(req)) {
    throw new TeacherStudentError('TEACHER_STUDENT_ORIGIN_REJECTED');
  }
  const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !req.body) {
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
      }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof TeacherStudentError) throw error;
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  } finally {
    reader.releaseLock();
  }
}

export function teacherStudentResponse(
  value: unknown,
  headers: Headers,
  status = 200,
): NextResponse {
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie');
  return NextResponse.json(value, { headers, status });
}

export async function withTeacherStudentRequest(
  req: NextRequest,
  handler: (ownerId: string, headers: Headers) => Promise<Response>,
): Promise<Response> {
  return withRequestOwnerId(req, async (ownerId, headers) => {
    try {
      if (!isAgentRuntimeConfigured()) {
        throw new TeacherStudentError('TEACHER_STUDENT_UNAVAILABLE');
      }
      return await handler(ownerId, headers);
    } catch (error) {
      const safe =
        error instanceof TeacherStudentError
          ? error
          : new TeacherStudentError('TEACHER_STUDENT_UNAVAILABLE');
      return teacherStudentResponse({ errorCode: safe.code }, headers, safe.status);
    }
  });
}
