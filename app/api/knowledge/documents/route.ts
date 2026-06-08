import { NextRequest } from 'next/server';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createKnowledgeDocument, listKnowledgeDocuments } from '@/lib/server/knowledge/repository';
import { createLogger } from '@/lib/logger';

const log = createLogger('Knowledge Documents API');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  try {
    const documents = await listKnowledgeDocuments();
    return apiSuccess({ documents });
  } catch (error) {
    log.error('Failed to list knowledge documents:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to list knowledge documents',
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const pdf = formData.get('pdf');
    if (!(pdf instanceof File)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'PDF file is required');
    }
    if (pdf.type !== 'application/pdf' && !pdf.name.toLowerCase().endsWith('.pdf')) {
      return apiError('INVALID_REQUEST', 400, 'Only PDF documents are supported');
    }
    if (pdf.size > MAX_UPLOAD_BYTES) {
      return apiError('INVALID_REQUEST', 400, 'PDF file must not exceed 50 MB');
    }

    const buffer = Buffer.from(await pdf.arrayBuffer());
    const parsed = await parsePDF({ providerId: 'unpdf' }, buffer);
    const document = await createKnowledgeDocument({
      fileName: pdf.name,
      mimeType: pdf.type || 'application/pdf',
      buffer,
      parsedText: parsed.text,
      pageCount: parsed.metadata?.pageCount,
    });
    return apiSuccess({ document }, 201);
  } catch (error) {
    log.error('Failed to ingest knowledge document:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to ingest knowledge document',
    );
  }
}
