import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { retrieveKnowledgeSnapshot } from '@/lib/server/knowledge/repository';
import type { RagRetrievalConfig } from '@/lib/types/rag';

const log = createLogger('Knowledge Retrieve API');

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      query?: string;
      config?: Partial<RagRetrievalConfig>;
    };
    const query = body.query?.trim();
    if (!query) return apiError('MISSING_REQUIRED_FIELD', 400, 'Retrieval query is required');

    const snapshot = await retrieveKnowledgeSnapshot(query, body.config);
    if (!snapshot) {
      return apiError(
        'INVALID_REQUEST',
        422,
        'No knowledge excerpts matched the current retrieval settings.',
      );
    }
    return apiSuccess({
      evidence: {
        id: snapshot.id,
        query,
        config: snapshot.config,
        selectionConfirmed: false,
        hits: snapshot.hits,
        sources: snapshot.sources,
      },
    });
  } catch (error) {
    log.error('Failed to retrieve knowledge candidates:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to retrieve knowledge candidates',
    );
  }
}
