/**
 * GET /api/stages/[id]/status
 *
 * Returns the public-state metadata for a stage. Used by the Share menu CTA
 * to know whether to show "Publish" or "Already published · Unpublish".
 *
 * No auth required — any caller who has the stage ID can read its public flag.
 *
 * Convention: snake_case error codes (e.g. `not_found`, `internal_error`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { resolveStageAccess } from '@/lib/server/stage-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const { id } = await params;
  try {
    const access = await resolveStageAccess(id);

    // Tombstoned and never-existed must be indistinguishable: this endpoint is
    // unauthenticated, so an answer other than plain 404 would let anyone
    // confirm that a given id used to be a real course.
    if (!access) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Field names are the wire contract; they stay `isPublic` / `publishedAt`
    // regardless of which layer answered.
    return NextResponse.json({ isPublic: access.isPublic, publishedAt: access.publishedAt });
  } catch (error) {
    console.error('Failed to fetch stage status', {
      stageId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
