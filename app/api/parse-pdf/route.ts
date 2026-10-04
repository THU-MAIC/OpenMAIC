import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { documentArtifactToParsedPdfContent, extractDocument } from '@/lib/document';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isSelfContainedExtractor } from '@/lib/server/material-extraction/services';
import { checkClientDocumentExtractorBaseUrl } from '@/lib/server/client-extractor-endpoint';
import {
  mediaResolutionResponse,
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import {
  requestWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
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

    pdfFileName = pdfFile?.name;
    // The document slot's service; the provider a request names (deprecated)
    // only when it is unassigned; the local parser when there is none.
    // An explicit self-contained extractor (local parsing) needs no service
    // and sends the file nowhere, whatever the slot names.
    const selfContained = providerId && isSelfContainedExtractor(providerId) ? providerId : null;
    let service: MediaConnection | undefined;
    try {
      if (!selfContained)
        service = await resolveMediaSlot('document', {
          workspaceId: await requestWorkspaceId(req),
          legacyRequest: async () =>
            providerId ? requestedDocumentProvider(providerId, apiKey, baseUrl) : undefined,
        });
    } catch (error) {
      if (!(error instanceof SlotDisabledError || error instanceof SlotUnassignedError)) {
        const refused = mediaResolutionResponse(error, 'Document parsing');
        if (refused) return refused;
        throw error;
      }
    }
    if (service && !service.managed && service.baseUrl && service.origin === 'configuration') {
      const checked = await checkClientDocumentExtractorBaseUrl(
        service.providerId as PDFProviderId,
        service.baseUrl,
      );
      if (!checked.ok) return apiError('INVALID_URL', 403, checked.message);
      service = { ...service, baseUrl: checked.baseUrl };
    }
    resolvedProviderId = selfContained ?? service?.providerId ?? 'unpdf';
    const config = {
      providerId: resolvedProviderId as PDFProviderId,
      ...(service?.apiKey ? { apiKey: service.apiKey } : {}),
      ...(service?.baseUrl ? { baseUrl: service.baseUrl } : {}),
      ...(service?.credentials?.accessKeyId
        ? {
            accessKeyId: service.credentials.accessKeyId,
            accessKeySecret: service.credentials.accessKeySecret,
          }
        : {}),
      managed: service ? service.managed : true,
    };

    // Convert PDF to buffer
    const arrayBuffer = await pdfFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Route the existing PDF API through the document extraction boundary.
    const artifact = await extractDocument({
      buffer,
      fileName: pdfFile.name,
      fileSize: pdfFile.size,
      mimeType: 'application/pdf',
      config,
    });
    const result = documentArtifactToParsedPdfContent(artifact);

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

/** The document provider a request names in its form (deprecated). */
async function requestedDocumentProvider(
  providerId: PDFProviderId,
  clientApiKey: string | null,
  clientBaseUrl: string | null,
): Promise<MediaConnection> {
  // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
  const managed = isServerConfiguredProvider('pdf', providerId);
  let baseUrlFromClient = managed ? undefined : clientBaseUrl || undefined;
  if (baseUrlFromClient) {
    const checked = await checkClientDocumentExtractorBaseUrl(providerId, baseUrlFromClient);
    if (!checked.ok) {
      throw new RequestedProviderRefusedError(apiError('INVALID_URL', 403, checked.message));
    }
    baseUrlFromClient = checked.baseUrl;
  }
  const apiKey = resolvePDFApiKey(providerId, managed ? undefined : clientApiKey || undefined);
  const baseUrl = resolvePDFBaseUrl(providerId, baseUrlFromClient);
  return {
    providerId,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    managed,
    userEndpoint: Boolean(baseUrlFromClient),
    origin: 'request',
  };
}
