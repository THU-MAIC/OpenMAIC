import { NextResponse, type NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { isSameOriginTeacherRequest } from '@/lib/server/teacher/request-origin';
import { TeacherAnalysisError } from '@/lib/teacher/analysis';

import { safeTeacherAnalysisError } from './analysis-service';

const MAX_BODY_BYTES = 256 * 1024;

export function teacherAnalysisResponse(value: unknown, headers: Headers, status = 200): Response {
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie');
  return NextResponse.json(value, { headers, status });
}

export async function withTeacherAnalysisRequest(
  req: NextRequest,
  handler: (ownerId: string, headers: Headers) => Promise<Response>,
): Promise<Response> {
  return withRequestOwnerId(req, async (ownerId, headers) => {
    try {
      if (!isAgentRuntimeConfigured()) throw new TeacherAnalysisError('ANALYSIS_UNAVAILABLE');
      if (!isSameOriginTeacherRequest(req)) {
        throw new TeacherAnalysisError('ANALYSIS_ORIGIN_REJECTED');
      }
      return await handler(ownerId, headers);
    } catch (error) {
      const safe = safeTeacherAnalysisError(error);
      return teacherAnalysisResponse({ errorCode: safe.code }, headers, safe.status);
    }
  });
}

export async function readTeacherAnalysisRequest(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !req.body) {
    throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
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
        throw new TeacherAnalysisError('ANALYSIS_INPUT_TOO_LARGE');
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch (error) {
    if (error instanceof TeacherAnalysisError) throw error;
    throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
  } finally {
    reader.releaseLock();
  }
}
