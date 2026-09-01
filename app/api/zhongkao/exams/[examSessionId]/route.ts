import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { examErrorResponse, examNotFound, isExamSessionId } from '@/lib/server/zhongkao/exam-http';
import { defaultExamServiceDeps, deleteExam, getExam } from '@/lib/server/zhongkao/exam-service';

export const runtime = 'nodejs';

type Params = { params: Promise<{ examSessionId: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(responseHeaders);
      const exam = await getExam(await defaultExamServiceDeps(ownerId), examSessionId);
      return NextResponse.json({ exam }, { status: 200, headers: responseHeaders });
    } catch (error) {
      return examErrorResponse(error, responseHeaders);
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(responseHeaders);
      await deleteExam(await defaultExamServiceDeps(ownerId), examSessionId);
      return new NextResponse(null, { status: 204, headers: responseHeaders });
    } catch (error) {
      return examErrorResponse(error, responseHeaders);
    }
  });
}
