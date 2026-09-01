import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { confirmExamAnswerKeyAndGrade } from '@/lib/server/zhongkao/exam-grading-service';
import { examErrorResponse, examNotFound, isExamSessionId } from '@/lib/server/zhongkao/exam-http';
import { defaultExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ANSWER_KEY_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;

type Params = { params: Promise<{ examSessionId: string }> };

function privateHeaders(headers = new Headers()): Headers {
  headers.set('Cache-Control', 'private, no-store');
  return headers;
}

async function readAnswerKeyRequest(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' || !req.body) {
    throw new ExamError('EXAM_ANSWER_KEY_INPUT_INVALID');
  }

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ANSWER_KEY_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExamError('EXAM_ANSWER_KEY_INPUT_INVALID');
    }
    chunks.push(Buffer.from(value));
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExamError('EXAM_ANSWER_KEY_INPUT_INVALID');
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404, headers: privateHeaders() });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const headers = privateHeaders(responseHeaders);
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(headers);
      const input = await readAnswerKeyRequest(req);
      const result = await confirmExamAnswerKeyAndGrade(
        await defaultExamServiceDeps(ownerId),
        examSessionId,
        input,
      );
      return NextResponse.json(
        { examSessionId: result.examSessionId, grading: result.grading },
        { status: result.replayed ? 200 : 201, headers },
      );
    } catch (error) {
      return examErrorResponse(error, headers);
    }
  });
}
