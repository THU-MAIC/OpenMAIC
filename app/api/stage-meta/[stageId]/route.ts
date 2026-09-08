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
 * ## Tombstone Handling (410 Gone)
 *
 * A deleted course answers 410 Gone with `deleted_at` so the client can
 * immediately terminate availability polling instead of retrying indefinitely
 * under server-backed persistence (#1396). While this distinguishes a deleted
 * course from a never-existed ID (which 404s), live course existence is already
 * observable, and fast-failing tombstoned courses avoids infinite loading loops.
 *
 * ## No `ownerId` in the response, ever
 *
 * `isOwner` is a boolean derived server-side. Returning the owner's identity
 * key would hand every visitor a stable cross-course identifier for the author.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { readStageAccessIncludingDeleted } from '@/lib/server/stage-access';
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
      const access = await readStageAccessIncludingDeleted(stageId);

      // Absent — never existed.
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Tombstoned — existed and was deleted.
      if (access.deletedAt !== null) {
        return NextResponse.json(
          { error: 'gone', deleted_at: access.deletedAt.toISOString() },
          { status: 410, headers: responseHeaders },
        );
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
