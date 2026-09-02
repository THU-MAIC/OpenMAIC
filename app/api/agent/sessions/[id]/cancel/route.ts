/**
 * Agent runtime control plane for cancellation.
 *
 * The route makes the request durable. The lease holder observes it and
 * writes the terminal event, keeping the event log single-writer.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

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
    if (meta.status === 'succeeded' || meta.status === 'failed' || meta.status === 'cancelled') {
      return NextResponse.json(
        {
          code: 'SESSION_ALREADY_TERMINAL',
          status: meta.status,
          error: `session is already ${meta.status}`,
        },
        { status: 409, headers: responseHeaders },
      );
    }

    await store.requestCancel(id);
    return NextResponse.json(
      { id, cancelRequested: true },
      { status: 202, headers: responseHeaders },
    );
  });
}
