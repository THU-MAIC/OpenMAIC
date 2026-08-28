/**
 * POST /api/stages/[id]/publish — make a document-backed course public.
 *
 * Owner-only; anonymous owners are refused with the reference's
 * `login_required` (a published course is a durable public artifact, so it
 * needs a real account, not an anonymous cookie partition).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { setStagePublished } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id: stageId } = await params;
    try {
      if (ownerId.startsWith('anon:')) {
        return NextResponse.json(
          { error: 'login_required' },
          { status: 401, headers: responseHeaders },
        );
      }

      const access = await resolveStageAccess(stageId);
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }
      if (access.ownerId !== ownerId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
      }

      if (access.isPublic) {
        return NextResponse.json(
          { success: true, publishedAt: access.publishedAt, name: access.name },
          { status: 200, headers: responseHeaders },
        );
      }

      const publishedAt = Date.now();
      const db = await getStageAccessDb();
      await setStagePublished(db, stageId, true, publishedAt);

      console.info('Stage published', { stageId, ownerId });
      return NextResponse.json(
        { success: true, publishedAt, name: access.name },
        { status: 200, headers: responseHeaders },
      );
    } catch (error) {
      console.error('Failed to publish stage', {
        stageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
