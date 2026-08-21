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
import { resolveServerAsset } from '@/lib/persistence/resolve-server-asset';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

// The asset-id path resolves bytes from the server asset store, which lives in
// the PostgreSQL persistence backend; it needs the Node runtime, not the edge.
export const runtime = 'nodejs';

const log = createLogger('Extract Document');
const MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * A normalized extraction input, independent of how the bytes arrived: either
 * parsed from a multipart upload or resolved from the server asset store by
 * asset id. Both forms then run the same extractor selection below.
 */
interface ExtractSource {
  fileName: string;
  fileSize: number;
  /** Normalized canonical MIME type (see `normalizeDocumentMimeType`). */
  mimeType: string;
  buffer: Buffer;
}

/** Provider configuration fields the client already sends on both forms. */
interface ExtractRequestConfig {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

/** JSON body for the asset-id form: an asset id plus the same provider config. */
interface AssetIdExtractRequest extends ExtractRequestConfig {
  assetId?: string;
  fileName?: string;
  mimeType?: string;
}

/** Mutable logging context shared with the shared extraction helper. */
interface ExtractLogState {
  fileName?: string;
  resolvedProviderId?: string;
}

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

/**
 * Run extractor selection and extraction over a normalized input. Shared by
 * the multipart byte form and the asset-id form so the two paths cannot drift.
 */
async function runExtraction(
  source: ExtractSource,
  requestConfig: ExtractRequestConfig,
  logState: ExtractLogState,
) {
  const { fileName, fileSize, mimeType, buffer } = source;

  // Media (audio/video) takes the media extraction path → MediaArtifact,
  // flattened to the same text shape documents produce. Same route, same
  // downstream generation path.
  if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
    logState.resolvedProviderId = requestConfig.providerId || 'alidocmind';
    // Reject a document-only provider (e.g. unpdf/mineru) for a media upload
    // with a clear 4xx instead of forwarding it into the media registry and
    // surfacing an opaque 500.
    const mediaProvider = getMediaExtractorProvider(logState.resolvedProviderId);
    if (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Provider "${logState.resolvedProviderId}" cannot extract ${mimeType}. Choose a media-capable provider (e.g. AliDocMind).`,
      );
    }
    const mediaManaged = isServerConfiguredProvider('pdf', logState.resolvedProviderId);
    // When managed, resolve the server-owned AK/SK (env OR YAML) explicitly so
    // a YAML-only deployment works — the client-level env fallback reads env
    // vars only. Client-entered creds are used only when unmanaged.
    const mediaManagedCreds = mediaManaged ? resolveManagedAliDocMindCredentials() : undefined;
    const mediaClientBaseUrl = mediaManaged ? undefined : requestConfig.baseUrl || undefined;
    // Same SSRF guard the document path applies: a client-supplied endpoint
    // must not let the server connect to internal/metadata hosts.
    if (mediaClientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(mediaClientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }
    const mediaArtifact = await extractMedia({
      buffer,
      fileName,
      fileSize,
      mimeType,
      config: {
        providerId: logState.resolvedProviderId,
        apiKey: mediaManaged ? undefined : requestConfig.apiKey || undefined,
        baseUrl: mediaManaged ? mediaManagedCreds?.baseUrl : mediaClientBaseUrl,
        accessKeyId: mediaManaged
          ? mediaManagedCreds?.accessKeyId
          : requestConfig.accessKeyId || undefined,
        accessKeySecret: mediaManaged
          ? mediaManagedCreds?.accessKeySecret
          : requestConfig.accessKeySecret || undefined,
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
        `No transcript, keyframes, or synopsis could be extracted from "${fileName}".`,
      );
    }
    const mediaResult: ParsedPdfContent = {
      text: mediaText,
      images: [],
      metadata: {
        pageCount: 0,
        fileName,
        fileSize,
        mimeType,
        parser: mediaArtifact.metadata.providerId ?? logState.resolvedProviderId,
      },
    };
    return apiSuccess({ data: mediaResult });
  }

  let provider = requestConfig.providerId
    ? getDocumentExtractorProvider(requestConfig.providerId)
    : undefined;
  if (requestConfig.providerId && !provider) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `Unknown document extractor provider: ${requestConfig.providerId}`,
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
  logState.resolvedProviderId = provider.id;

  let managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
  let clientBaseUrl = managed ? undefined : requestConfig.baseUrl || undefined;
  if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
    const cloudProvider = getDocumentExtractorProvider('mineru-cloud');
    const cloudManaged = isServerConfiguredProvider('pdf', 'mineru-cloud');
    const cloudApiKey = resolvePDFApiKey(
      'mineru-cloud',
      cloudManaged ? undefined : requestConfig.apiKey || undefined,
    );
    if (cloudProvider && supportsMimeType(cloudProvider, mimeType) && cloudApiKey) {
      provider = cloudProvider;
      managed = cloudManaged;
      clientBaseUrl = managed ? undefined : requestConfig.baseUrl || undefined;
      logState.resolvedProviderId = provider.id;
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
      ? resolvePDFApiKey(provider.id, managed ? undefined : requestConfig.apiKey || undefined)
      : requestConfig.apiKey || undefined,
    baseUrl: isPdfProviderId(provider.id)
      ? (managedAliCreds?.baseUrl ?? resolvePDFBaseUrl(provider.id, clientBaseUrl))
      : clientBaseUrl,
    // AliDocMind uses AK/SK: managed → server-owned creds; else client values.
    accessKeyId: managed ? managedAliCreds?.accessKeyId : requestConfig.accessKeyId || undefined,
    accessKeySecret: managed
      ? managedAliCreds?.accessKeySecret
      : requestConfig.accessKeySecret || undefined,
    // Env fallback is a last resort for a managed provider (defensive; the
    // resolver already covers env+YAML).
    allowEnvFallback: managed,
  };

  const artifact = await provider.extract({
    buffer,
    fileName,
    fileSize,
    mimeType,
    config,
  });
  const result = documentArtifactToParsedPdfContent(artifact);

  const resultWithMetadata: ParsedPdfContent = {
    ...result,
    metadata: {
      ...result.metadata,
      pageCount: result.metadata?.pageCount ?? 0,
      fileName,
      fileSize,
      mimeType,
      parser: result.metadata?.parser ?? provider.id,
    },
  };

  return apiSuccess({ data: resultWithMetadata });
}

export async function POST(req: NextRequest) {
  const logState: ExtractLogState = {};
  try {
    const contentType = req.headers.get('content-type') || '';
    let source: ExtractSource;
    let requestConfig: ExtractRequestConfig;

    if (contentType.includes('multipart/form-data')) {
      // Legacy byte form: the client uploads the original bytes, used by
      // browser-backed (self-deploy) pools where the server cannot resolve a
      // browser-side asset.
      const formData = await req.formData();
      const documentFile = (formData.get('file') || formData.get('pdf')) as File | null;
      requestConfig = {
        providerId: (formData.get('providerId') as string | null) ?? undefined,
        apiKey: (formData.get('apiKey') as string | null) ?? undefined,
        baseUrl: (formData.get('baseUrl') as string | null) ?? undefined,
        accessKeyId: (formData.get('accessKeyId') as string | null) ?? undefined,
        accessKeySecret: (formData.get('accessKeySecret') as string | null) ?? undefined,
      };

      if (!documentFile) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No course material file provided');
      }

      logState.fileName = documentFile.name;
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

      source = {
        fileName: documentFile.name,
        fileSize: documentFile.size,
        mimeType,
        buffer: Buffer.from(await documentFile.arrayBuffer()),
      };
    } else if (contentType.includes('application/json')) {
      // Asset-id form: the client names the pool asset allocated at upload and
      // the server resolves the bytes from the server asset store. Only used
      // when the deployment's pool is server-backed; the browser-backed
      // client never sends this shape.
      let body: AssetIdExtractRequest;
      try {
        body = (await req.json()) as AssetIdExtractRequest;
      } catch {
        return apiError('INVALID_REQUEST', 400, 'Invalid JSON body for asset-id extraction.');
      }

      if (!body.assetId) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No asset id provided');
      }

      const resolution = await resolveServerAsset(body.assetId, req.headers);
      if (resolution.status === 'unconfigured') {
        return apiError(
          'INVALID_REQUEST',
          503,
          'Server persistence is not configured; asset-id extraction requires a server-backed asset pool.',
        );
      }
      if (resolution.status === 'unauthenticated') {
        return apiError(
          'UNAUTHENTICATED',
          401,
          'Asset-id extraction requires server persistence credentials.',
        );
      }
      if (resolution.status === 'missing') {
        return apiError(
          'ASSET_NOT_FOUND',
          404,
          `No course material asset found for asset id "${body.assetId}".`,
        );
      }

      // The client carries the original display name and normalized MIME type
      // in the session; the asset store records only the blob MIME type, so
      // the request values win and the recorded type is the fallback.
      const fileName = body.fileName || 'document';
      logState.fileName = fileName;
      const mimeType = normalizeDocumentMimeType({
        mimeType: body.mimeType ?? resolution.mimeType,
        fileName,
      });
      if (!mimeType) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Unsupported course material type for "${fileName}"`,
        );
      }
      if (resolution.buffer.length > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      source = {
        fileName,
        fileSize: resolution.buffer.length,
        mimeType,
        buffer: resolution.buffer,
      };
      requestConfig = {
        providerId: body.providerId,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
      };
    } else {
      log.error('Invalid Content-Type for document upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data or application/json, got "${contentType}"`,
      );
    }

    return await runExtraction(source, requestConfig, logState);
  } catch (error) {
    log.error(
      `Document extraction failed [provider=${logState.resolvedProviderId ?? 'unknown'}, file="${logState.fileName ?? 'unknown'}"]:`,
      error,
    );
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}
