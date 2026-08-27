/** Agent runtime control plane for durable follow-up messages. */
import { AgentSessionAccessError } from '@openmaic/storage';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { decodeElementRefs } from '@/lib/workbench/element-refs';
import { decodeCourseRefs } from '@/lib/workbench/course-refs';
import {
  bindOwnerMaterialsToSession,
  SessionMaterialBindingError,
} from '@/lib/server/agent-runtime/session-materials';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const store = await getAgentSessionStore();
    const meta = await store.getSession(id);
    if (!meta || meta.ownerId !== ownerId) {
      return new Response('Not found', { status: 404, headers: responseHeaders });
    }

    let body: {
      text?: string;
      materialIds?: unknown;
      elementRefs?: unknown;
      courseRefs?: unknown;
    } = {};
    try {
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      const response = apiError('INVALID_REQUEST', 400, 'invalid JSON body');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }

    const text = (body.text ?? '').toString().trim();
    if (
      body.materialIds !== undefined &&
      (!Array.isArray(body.materialIds) || body.materialIds.some((id) => typeof id !== 'string'))
    ) {
      const response = apiError('INVALID_REQUEST', 400, 'materialIds must be an array of strings');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    const materialIds = [...new Set((body.materialIds ?? []).map((id: string) => id.trim()))];
    if (materialIds.length > 20 || materialIds.some((id) => !id)) {
      const response = apiError('INVALID_REQUEST', 400, 'materialIds are invalid');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    const decodedElementRefs = decodeElementRefs(body.elementRefs ?? []);
    if (!decodedElementRefs.ok) {
      const response = apiError('INVALID_REQUEST', 400, decodedElementRefs.error);
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    const decodedCourseRefs = decodeCourseRefs(body.courseRefs ?? []);
    if (!decodedCourseRefs.ok) {
      const response = apiError('INVALID_REQUEST', 400, decodedCourseRefs.error);
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    if (!text && materialIds.length === 0) {
      const response = apiError('MISSING_REQUIRED_FIELD', 400, 'text is required');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    if (text.length > MAX_SESSION_TEXT_LENGTH) {
      const response = apiError(
        'INVALID_REQUEST',
        400,
        `text exceeds the ${MAX_SESSION_TEXT_LENGTH} character limit`,
      );
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }

    try {
      const materials = materialIds.length
        ? await bindOwnerMaterialsToSession(id, ownerId, materialIds)
        : [];
      const posted = await store.postUserMessage(
        id,
        {
          text,
          ...(materials.length ? { materials } : {}),
          ...(decodedElementRefs.refs.length ? { elementRefs: decodedElementRefs.refs } : {}),
          ...(decodedCourseRefs.refs.length ? { courseRefs: decodedCourseRefs.refs } : {}),
        },
        { expectedOwnerId: ownerId },
      );
      return NextResponse.json(
        {
          id,
          message: { seq: posted.seq, text, delivery: posted.delivery },
          elementRefsAccepted: decodedElementRefs.refs.length > 0,
          courseRefsAccepted: decodedCourseRefs.refs.length > 0,
        },
        { status: 202, headers: responseHeaders },
      );
    } catch (error) {
      if (error instanceof SessionMaterialBindingError) {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      if (error instanceof AgentSessionAccessError) {
        return new Response('Forbidden', { status: 403, headers: responseHeaders });
      }
      throw error;
    }
  });
}
