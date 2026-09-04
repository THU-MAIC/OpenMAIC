import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { examErrorResponse, examNotFound, isExamSessionId } from '@/lib/server/zhongkao/exam-http';
import {
  defaultExamKnowledgeSuggestionsServiceDeps,
  generateExamKnowledgeSuggestions,
  getExamKnowledgeSuggestions,
} from '@/lib/server/zhongkao/exam-knowledge-suggestions-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KNOWLEDGE_SUGGESTIONS_REQUEST_BODY_MAX_BYTES = 1024;

type Params = { params: Promise<{ examSessionId: string }> };

function privateHeaders(headers = new Headers()): Headers {
  headers.set('Cache-Control', 'private, no-store');
  return headers;
}

async function requireClosedEmptyBody(req: NextRequest): Promise<void> {
  if (!req.body) return;
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ExamError('EXAM_INPUT_INVALID');
  }

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > KNOWLEDGE_SUGGESTIONS_REQUEST_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExamError('EXAM_INPUT_INVALID');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) return;

  let parsed: unknown;
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

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404, headers: privateHeaders() });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const headers = privateHeaders(responseHeaders);
    try {
      const { examSessionId } = await params;
      if (!isExamSessionId(examSessionId)) return examNotFound(headers);
      const knowledgeSuggestions = await getExamKnowledgeSuggestions(
        await defaultExamKnowledgeSuggestionsServiceDeps(ownerId),
        examSessionId,
      );
      return NextResponse.json({ knowledgeSuggestions }, { status: 200, headers });
    } catch (error) {
      return examErrorResponse(error, headers);
    }
  });
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
      await requireClosedEmptyBody(req);
      const result = await generateExamKnowledgeSuggestions(
        await defaultExamKnowledgeSuggestionsServiceDeps(ownerId, req.signal),
        examSessionId,
      );
      return NextResponse.json(
        {
          examSessionId: result.examSessionId,
          knowledgeSuggestions: result.knowledgeSuggestions,
        },
        { status: result.replayed ? 200 : 201, headers },
      );
    } catch (error) {
      return examErrorResponse(error, headers);
    }
  });
}
