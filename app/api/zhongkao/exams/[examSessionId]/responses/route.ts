import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { examErrorResponse, examNotFound, isExamSessionId } from '@/lib/server/zhongkao/exam-http';
import { captureExamStudentResponses } from '@/lib/server/zhongkao/exam-response-service';
import { defaultExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';

export const runtime = 'nodejs';
const RESPONSE_REQUEST_BODY_MAX_BYTES = 1024 * 1024;

type Params = { params: Promise<{ examSessionId: string }> };

async function readResponseRequest(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' || !req.body) {
    throw new ExamError('EXAM_RESPONSE_INPUT_INVALID');
  }

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExamError('EXAM_RESPONSE_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExamError('EXAM_RESPONSE_INPUT_INVALID');
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(responseHeaders);
      const input = await readResponseRequest(req);
      const result = await captureExamStudentResponses(
        await defaultExamServiceDeps(ownerId),
        examSessionId,
        input,
      );
      return NextResponse.json(
        { exam: result.exam },
        { status: result.replayed ? 200 : 201, headers: responseHeaders },
      );
    } catch (error) {
      return examErrorResponse(error, responseHeaders);
    }
  });
}
