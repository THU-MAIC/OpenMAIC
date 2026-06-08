import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { getRagSnapshotEvidence, selectRagSnapshotHits } from '@/lib/server/knowledge/repository';

const log = createLogger('Knowledge Snapshot API');

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const evidence = await getRagSnapshotEvidence(id);
    if (!evidence) return apiError('INVALID_REQUEST', 404, 'Knowledge snapshot not found');
    return apiSuccess({ evidence });
  } catch (error) {
    log.error('Failed to read knowledge snapshot:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to read knowledge snapshot',
    );
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await req.json()) as {
      selectedHits?: Array<{ documentId: string; chunkIndex: number }>;
    };
    if (!Array.isArray(body.selectedHits) || body.selectedHits.length === 0) {
      return apiError('INVALID_REQUEST', 400, 'Select at least one retrieved excerpt');
    }
    const evidence = await selectRagSnapshotHits(id, body.selectedHits);
    if (!evidence) return apiError('INVALID_REQUEST', 404, 'Knowledge snapshot not found');
    return apiSuccess({ evidence });
  } catch (error) {
    log.error('Failed to select knowledge snapshot excerpts:', error);
    return apiError(
      'INVALID_REQUEST',
      400,
      error instanceof Error ? error.message : 'Failed to select knowledge snapshot excerpts',
    );
  }
}
