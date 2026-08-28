/**
 * GET /api/stage-meta/[stageId] — the per-viewer facts a document does not carry
 * (the reference's stage-meta sidecar, ported onto this branch's owner model).
 *
 * The document seam returns a DOCUMENT: stage + scenes + outline, and nothing
 * about who is asking. The classroom branches on exactly that — `isOwner`
 * decides read-only vs editable — so the split is explicit: the document
 * carries content, this sidecar carries tenancy, and the client fetches both
 * in parallel.
 *
 * ## Everything here is fail-closed on the tombstone
 *
 * `resolveStageAccess` answers `null` for a deleted course exactly as it does
 * for one that never existed, so a deleted course 404s here too. This endpoint
 * is unauthenticated-friendly (any visitor may ask about any id), so if it
 * leaked `{isPublic: true}` for a tombstoned course it would be a public oracle
 * for "this course used to exist".
 *
 * ## No `ownerId` in the response, ever
 *
 * `isOwner` is a boolean derived server-side. Returning the owner's identity
 * key would hand every visitor a stable cross-course identifier for the author.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

// Per-viewer and mutable on every publish/unpublish/delete: this response must
// never be cached, by Next or by anything in front of it.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { stageId } = await params;
    try {
      const access = await resolveStageAccess(stageId);

      // Absent or tombstoned — indistinguishable, deliberately.
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Identity comparison, and nothing else: this boolean is the client's
      // ONLY owner signal, so a `true` here must mean every write through the
      // owner-bound store will be accepted (the store re-checks the owner
      // scope inside its write transactions).
      const isOwner = access.ownerId === ownerId;

      return NextResponse.json(
        {
          isOwner,
          isPublic: access.isPublic,
          publishedAt: access.publishedAt,
          generationComplete: access.generationComplete,
          // Which layer answered. Diagnostic only — the client must not branch
          // on it.
          source: access.source,
        },
        { status: 200, headers: responseHeaders },
      );
    } catch (error) {
      console.error('Failed to resolve stage meta', {
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
