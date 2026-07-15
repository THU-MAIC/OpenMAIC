import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import {
  documentArtifactToParsedPdfContent,
  extractMedia,
  getDocumentExtractorProvider,
  getMediaExtractorProvider,
  selectDocumentExtractorProvider,
} from '@/lib/document';
import type { MediaArtifact } from '@/lib/document';
import { normalizeDocumentMimeType, SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('Extract Document');
const MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function isPdfProviderId(providerId: string): providerId is PDFProviderId {
  return providerId in PDF_PROVIDERS;
}

function supportsMimeType(
  provider: { supportedMimeTypes: readonly string[] },
  mimeType: string,
): boolean {
  return provider.supportedMimeTypes.map((type) => type.toLowerCase()).includes(mimeType);
}

function isSelfHostedMinerUProvider(
  providerId: string,
): providerId is Extract<PDFProviderId, 'mineru'> {
  return providerId === 'mineru';
}

function requestedTypeLabel(mimeType: string): string {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'DOCX';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return 'PPTX';
  }
  return mimeType;
}

/**
 * Flatten a MediaArtifact (transcript + keyframes + synopsis) into the
 * text-shaped ParsedPdfContent the generation pipeline consumes. Media takes
 * the same route + downstream path as documents; only the extraction differs.
 */
function mediaArtifactToText(artifact: MediaArtifact): string {
  const parts: string[] = [];

  const synopsis =
    artifact.providerRaw &&
    typeof artifact.providerRaw === 'object' &&
    'synopsis' in artifact.providerRaw
      ? String((artifact.providerRaw as { synopsis?: unknown }).synopsis ?? '')
      : '';
  if (synopsis.trim()) {
    parts.push(`## Synopsis\n\n${synopsis.trim()}`);
  }

  if (artifact.transcript?.length) {
    const lines = artifact.transcript
      .filter((seg) => seg.text?.trim())
      .map((seg) => {
        const ts = formatTimestamp(seg.startMs);
        const speaker = seg.speaker ? `${seg.speaker}: ` : '';
        return `[${ts}] ${speaker}${seg.text.trim()}`;
      });
    if (lines.length) parts.push(`## Transcript\n\n${lines.join('\n')}`);
  }

  if (artifact.keyframes?.length) {
    const lines = artifact.keyframes
      .filter((kf) => (kf.description || kf.ocrText)?.trim())
      .map((kf) => {
        const ts = formatTimestamp(kf.timeMs);
        return `[${ts}] ${(kf.description || kf.ocrText || '').trim()}`;
      });
    if (lines.length) parts.push(`## Keyframes\n\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  // Use HH:MM:SS once past an hour so a 75-minute video reads 01:15:03, not 75:03.
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

export async function POST(req: NextRequest) {
  let fileName: string | undefined;
  let resolvedProviderId: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for document upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data, got "${contentType}"`,
      );
    }

    const formData = await req.formData();
    const documentFile = (formData.get('file') || formData.get('pdf')) as File | null;
    const preferredProviderId = formData.get('providerId') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;
    const accessKeyId = formData.get('accessKeyId') as string | null;
    const accessKeySecret = formData.get('accessKeySecret') as string | null;

    if (!documentFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No course material file provided');
    }

    fileName = documentFile.name;
    const mimeType = normalizeDocumentMimeType({
      mimeType: documentFile.type,
      fileName: documentFile.name,
    });
    if (!mimeType) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Unsupported course material type for "${documentFile.name}"`,
      );
    }
    if (documentFile.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
      return apiError(
        'INVALID_REQUEST',
        413,
        `Course material file is too large. Maximum size is ${Math.floor(
          MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
        )}MB.`,
      );
    }

    // Media (audio/video) takes the media extraction path → MediaArtifact,
    // flattened to the same text shape documents produce. Same route, same
    // downstream generation path.
    if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
      resolvedProviderId = preferredProviderId || 'alidocmind';
      // Reject a document-only provider (e.g. unpdf/mineru) for a media upload
      // with a clear 4xx instead of forwarding it into the media registry and
      // surfacing an opaque 500.
      const mediaProvider = getMediaExtractorProvider(resolvedProviderId);
      if (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType)) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Provider "${resolvedProviderId}" cannot extract ${mimeType}. Choose a media-capable provider (e.g. AliDocMind).`,
        );
      }
      const mediaManaged = isServerConfiguredProvider('pdf', resolvedProviderId);
      // When managed, resolve the server-owned AK/SK (env OR YAML) explicitly so
      // a YAML-only deployment works — the client-level env fallback reads env
      // vars only. Client-entered creds are used only when unmanaged.
      const mediaManagedCreds = mediaManaged ? resolveManagedAliDocMindCredentials() : undefined;
      const mediaClientBaseUrl = mediaManaged ? undefined : baseUrl || undefined;
      // Same SSRF guard the document path applies: a client-supplied endpoint
      // must not let the server connect to internal/metadata hosts.
      if (mediaClientBaseUrl && process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(mediaClientBaseUrl);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }
      const arrayBuffer = await documentFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mediaArtifact = await extractMedia({
        buffer,
        fileName: documentFile.name,
        fileSize: documentFile.size,
        mimeType,
        config: {
          providerId: resolvedProviderId,
          apiKey: mediaManaged ? undefined : apiKey || undefined,
          baseUrl: mediaManaged ? mediaManagedCreds?.baseUrl : mediaClientBaseUrl,
          accessKeyId: mediaManaged ? mediaManagedCreds?.accessKeyId : accessKeyId || undefined,
          accessKeySecret: mediaManaged
            ? mediaManagedCreds?.accessKeySecret
            : accessKeySecret || undefined,
          // Env fallback is a last resort for a managed provider whose creds
          // weren't resolved above (defensive; resolver already covers env+YAML).
          allowEnvFallback: mediaManaged,
        },
      });

      const mediaText = mediaArtifactToText(mediaArtifact);
      // An artifact with no transcript, keyframes, or synopsis carries no usable
      // content. Returning empty text as 200 would silently generate from
      // nothing — surface a parse error instead.
      if (!mediaText.trim()) {
        return apiError(
          'PARSE_FAILED',
          422,
          `No transcript, keyframes, or synopsis could be extracted from "${documentFile.name}".`,
        );
      }
      const mediaResult: ParsedPdfContent = {
        text: mediaText,
        images: [],
        metadata: {
          pageCount: 0,
          fileName: documentFile.name,
          fileSize: documentFile.size,
          mimeType,
          parser: mediaArtifact.metadata.providerId ?? resolvedProviderId,
        },
      };
      return apiSuccess({ data: mediaResult });
    }

    let provider = preferredProviderId
      ? getDocumentExtractorProvider(preferredProviderId)
      : undefined;
    if (preferredProviderId && !provider) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Unknown document extractor provider: ${preferredProviderId}`,
      );
    }

    if (provider && !supportsMimeType(provider, mimeType)) provider = undefined;

    try {
      provider =
        provider ||
        selectDocumentExtractorProvider({
          mimeType,
          requiredCapabilities: { text: true },
        });
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        400,
        error instanceof Error ? error.message : `Unsupported course material type "${mimeType}"`,
      );
    }
    resolvedProviderId = provider.id;

    let managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
    let clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
      const cloudProvider = getDocumentExtractorProvider('mineru-cloud');
      const cloudManaged = isServerConfiguredProvider('pdf', 'mineru-cloud');
      const cloudApiKey = resolvePDFApiKey(
        'mineru-cloud',
        cloudManaged ? undefined : apiKey || undefined,
      );
      if (cloudProvider && supportsMimeType(cloudProvider, mimeType) && cloudApiKey) {
        provider = cloudProvider;
        managed = cloudManaged;
        clientBaseUrl = managed ? undefined : baseUrl || undefined;
        resolvedProviderId = provider.id;
      }
    }
    if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
      return apiError(
        'INVALID_REQUEST',
        422,
        `${requestedTypeLabel(mimeType)} extraction requires a configured MinerU document extractor. Configure a self-hosted MinerU base URL or a MinerU Cloud API key in PDF provider settings.`,
      );
    }
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    // For a managed AliDocMind provider, resolve server-owned AK/SK (env OR
    // YAML) explicitly so a YAML-only deployment extracts successfully — the
    // client-level env fallback reads env vars only.
    const managedAliCreds =
      managed && provider.id === 'alidocmind' ? resolveManagedAliDocMindCredentials() : undefined;
    const config = {
      providerId: provider.id,
      apiKey: isPdfProviderId(provider.id)
        ? resolvePDFApiKey(provider.id, managed ? undefined : apiKey || undefined)
        : apiKey || undefined,
      baseUrl: isPdfProviderId(provider.id)
        ? (managedAliCreds?.baseUrl ?? resolvePDFBaseUrl(provider.id, clientBaseUrl))
        : clientBaseUrl,
      // AliDocMind uses AK/SK: managed → server-owned creds; else client values.
      accessKeyId: managed ? managedAliCreds?.accessKeyId : accessKeyId || undefined,
      accessKeySecret: managed ? managedAliCreds?.accessKeySecret : accessKeySecret || undefined,
      // Env fallback is a last resort for a managed provider (defensive; the
      // resolver already covers env+YAML).
      allowEnvFallback: managed,
    };

    const arrayBuffer = await documentFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const artifact = await provider.extract({
      buffer,
      fileName: documentFile.name,
      fileSize: documentFile.size,
      mimeType,
      config,
    });
    const result = documentArtifactToParsedPdfContent(artifact);

    const resultWithMetadata: ParsedPdfContent = {
      ...result,
      metadata: {
        ...result.metadata,
        pageCount: result.metadata?.pageCount ?? 0,
        fileName: documentFile.name,
        fileSize: documentFile.size,
        mimeType,
        parser: result.metadata?.parser ?? provider.id,
      },
    };

    return apiSuccess({ data: resultWithMetadata });
  } catch (error) {
    log.error(
      `Document extraction failed [provider=${resolvedProviderId ?? 'unknown'}, file="${fileName ?? 'unknown'}"]:`,
      error,
    );
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}
