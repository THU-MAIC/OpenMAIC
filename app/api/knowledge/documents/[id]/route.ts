import { apiError, apiSuccess } from '@/lib/server/api-response';
import { deleteKnowledgeDocument } from '@/lib/server/knowledge/repository';
import { createLogger } from '@/lib/logger';

const log = createLogger('Knowledge Document API');

export const runtime = 'nodejs';

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const deleted = await deleteKnowledgeDocument(id);
    if (!deleted) return apiError('INVALID_REQUEST', 404, 'Knowledge document not found');
    return apiSuccess({ deleted: true });
  } catch (error) {
    log.error('Failed to delete knowledge document:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to delete knowledge document',
    );
  }
}
