/** Agent runtime control plane for reading and updating an owned session title. */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { normalizeSessionTitleOverride } from '@/lib/workbench/session-title';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    return NextResponse.json(meta, { headers: responseHeaders });
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const store = await getAgentSessionStore();

    let body: { title?: unknown } | null;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      const response = apiError('INVALID_REQUEST', 400, 'invalid JSON body');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'title')) {
      const response = apiError('MISSING_REQUIRED_FIELD', 400, 'title is required');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    if (body.title !== null && typeof body.title !== 'string') {
      const response = apiError('INVALID_REQUEST', 400, 'title must be a string or null');
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }
    const title = normalizeSessionTitleOverride(body.title);
    const meta = await store.setManualSessionTitle(id, ownerId, title);
    if (!meta) {
      return new Response('Not found', { status: 404, headers: responseHeaders });
    }
    return NextResponse.json({ title: meta.title ?? null }, { headers: responseHeaders });
  });
}
