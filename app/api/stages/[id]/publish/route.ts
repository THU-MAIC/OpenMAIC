/**
 * POST /api/stages/[id]/publish — make a document-backed course public.
 *
 * Owner-only, and only for a principal holding the `course:publish` role. An
 * anonymous owner is refused with the reference's `login_required` (a
 * published course is a durable public artifact, so it needs a real account,
 * not an anonymous cookie partition); any other principal without the role is
 * refused with `forbidden`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { setStagePublished } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { OWNER_ROLES, principalHasRole } from '@/lib/server/identity/types';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async (principal, responseHeaders) => {
    const { id: stageId } = await params;
    const { ownerId } = principal;
    try {
      if (!principalHasRole(principal, OWNER_ROLES.coursePublish)) {
        // An anonymous owner is asked to sign in; any other principal was
        // identified and simply lacks the role.
        return principal.kind === 'anonymous'
          ? NextResponse.json(
              { error: 'login_required' },
              { status: 401, headers: responseHeaders },
            )
          : NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
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
