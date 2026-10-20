/**
 *   GET /api/course-series/:id
 *     A course series' own state: how many parts it has in total and how
 *     many are still waiting to start (`pendingPartCount`). A part's own
 *     course and generation progress are read the ordinary way, through its
 *     `generation_runs` row (`GET /api/generation-runs/:id`, whose snapshot
 *     already carries `series: { seriesId, order }`) or, once generated,
 *     the course's own `stage_meta` mirror of the same two fields -- this
 *     endpoint exists only for what neither of those has: the series' total
 *     part count, needed to render "Part 2 of 5" before part 5 exists as a
 *     run at all.
 *
 * Another owner's series answers the same 404 as an unknown one.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { ownerNotFound, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { getCourseSeriesById } from '@/lib/server/generation/series/orchestrator';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const series = await getCourseSeriesById(ownerId, id);
    if (!series) return ownerNotFound(responseHeaders);
    return withOwnerResponseHeaders(
      apiSuccess({
        series: {
          id: series.id,
          title: series.title,
          partCount: series.partCount,
          pendingPartCount: series.pendingParts.length,
          createdAt: series.createdAt,
        },
      }),
      responseHeaders,
    );
  });
}
