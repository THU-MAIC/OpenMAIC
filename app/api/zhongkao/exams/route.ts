import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { examErrorResponse } from '@/lib/server/zhongkao/exam-http';
import { createExam, defaultExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';

export const runtime = 'nodejs';
const EXAM_REQUEST_BODY_MAX_BYTES = 32 * 1024;

async function readExamRequest(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' || !req.body) {
    throw new ExamError('EXAM_INPUT_INVALID');
  }

  const chunks: Buffer[] = [];
  const reader = req.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > EXAM_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExamError('EXAM_INPUT_INVALID');
    }
    chunks.push(Buffer.from(value));
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExamError('EXAM_INPUT_INVALID');
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const input = await readExamRequest(req);
      const result = await createExam(await defaultExamServiceDeps(ownerId), input);
      return NextResponse.json(
        { exam: result.exam },
        { status: result.replayed ? 200 : 201, headers: responseHeaders },
      );
    } catch (error) {
      return examErrorResponse(error, responseHeaders);
    }
  });
}
