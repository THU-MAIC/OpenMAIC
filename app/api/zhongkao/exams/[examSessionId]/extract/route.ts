import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { extractExamQuestionCandidates } from '@/lib/server/zhongkao/exam-extraction-service';
import { examErrorResponse, examNotFound, isExamSessionId } from '@/lib/server/zhongkao/exam-http';
import { defaultExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';

export const runtime = 'nodejs';
const EXTRACT_REQUEST_BODY_MAX_BYTES = 1024;

type Params = { params: Promise<{ examSessionId: string }> };

async function requireClosedEmptyBody(req: NextRequest): Promise<void> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!req.body) return;
  if (contentType !== 'application/json') throw new ExamError('EXAM_INPUT_INVALID');

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > EXTRACT_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExamError('EXAM_INPUT_INVALID');
    }
    chunks.push(Buffer.from(value));
  }

  let parsed: unknown;
  if (total === 0) return;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ExamError('EXAM_INPUT_INVALID');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 0
  ) {
    throw new ExamError('EXAM_INPUT_INVALID');
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(responseHeaders);
      await requireClosedEmptyBody(req);
      const result = await extractExamQuestionCandidates(
        await defaultExamServiceDeps(ownerId),
        examSessionId,
      );
      return NextResponse.json({ exam: result.exam }, { status: 200, headers: responseHeaders });
    } catch (error) {
      return examErrorResponse(error, responseHeaders);
    }
  });
}
