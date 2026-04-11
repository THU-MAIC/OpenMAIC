import { NextRequest } from 'next/server';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Parse PDF');

export async function POST(req: NextRequest) {
  let pdfFileName: string | undefined;
  let resolvedProviderId: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for PDF upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data, got "${contentType}"`,
      );
    }

    const formData = await req.formData();
    const pdfFile = formData.get('pdf') as File | null;
    const providerId = formData.get('providerId') as PDFProviderId | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!pdfFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No PDF file provided');
    }

    // providerId is required from the client — no server-side store to fall back to
    const effectiveProviderId = providerId || ('unpdf' as PDFProviderId);
    pdfFileName = pdfFile?.name;
    resolvedProviderId = effectiveProviderId;

    const clientBaseUrl = baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      apiKey: clientBaseUrl
        ? apiKey || ''
        : resolvePDFApiKey(effectiveProviderId, apiKey || undefined),
      baseUrl: clientBaseUrl
        ? clientBaseUrl
        : resolvePDFBaseUrl(effectiveProviderId, baseUrl || undefined),
    };

    // Convert PDF to buffer
    const arrayBuffer = await pdfFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse PDF using the provider system
    const result = await parsePDF(config, buffer);

    // Add file metadata
    const resultWithMetadata: ParsedPdfContent = {
      ...result,
      metadata: {
        ...result.metadata,
        pageCount: result.metadata?.pageCount ?? 0, // Ensure pageCount is always a number
        fileName: pdfFile.name,
        fileSize: pdfFile.size,
      },
    };

    return apiSuccess({ data: resultWithMetadata });
  } catch (error) {
    log.error(
      `PDF parsing failed [provider=${resolvedProviderId ?? 'unknown'}, file="${pdfFileName ?? 'unknown'}"]:`,
      error,
    );
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}
