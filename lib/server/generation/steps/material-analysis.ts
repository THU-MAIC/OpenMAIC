/**
 * Material analysis: extract the text of one course material (a document, or
 * an audio/video file) for the generation pipeline, through the extractor the
 * document slot or the caller names. The logic of 1.1.x's
 * POST /api/extract-document; a run reads the bytes of an uploaded material.
 *
 * Server-side material extraction for the Pro agent's sessions
 * (`lib/server/material-extraction/extract.ts`) shares the slot services and
 * extractor configuration below but keeps its own selection, which tries every
 * capable extractor in turn and records the result as session materials.
 */
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
import type { DocumentExtractorConfig, DocumentExtractorProvider } from '@/lib/document/types';
import {
  documentSlotGoverns,
  extractorConfigFor,
  slotGovernedRequest,
  slotMediaExtractorConfig,
  type ExtractionServices,
} from '@/lib/server/material-extraction/services';
import { SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import {
  checkClientDocumentExtractorBaseUrl,
  checkClientMediaExtractorBaseUrl,
} from '@/lib/server/client-extractor-endpoint';

import { StepRefusal, type StepContext } from './context';

/**
 * A normalized extraction input, independent of how the bytes arrived: either
 * parsed from a multipart upload or resolved from the server asset store by
 * asset id. Both forms then run the same extractor selection below.
 */
interface MaterialSource {
  fileName: string;
  fileSize: number;
  /** Normalized canonical MIME type (see `normalizeDocumentMimeType`). */
  mimeType: string;
  buffer: Buffer;
}

/** Provider fields a request may still name (deprecated; the document slot decides). */
interface MaterialExtractorRequest {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

/** Why material analysis declined; the message says what to do about it. */
type MaterialAnalysisRefusal =
  /** The named extractor cannot read this media type. */
  | 'provider-cannot-extract'
  /** The named document extractor does not exist. */
  | 'unknown-provider'
  /** No extractor reads this type. */
  | 'unsupported-type'
  /** The extractor endpoint fails the endpoint rule for a user-typed URL. */
  | 'endpoint-refused'
  /** The media produced no transcript, keyframes or synopsis. */
  | 'no-content'
  /** This type needs a document service that is not available. */
  | 'service-required';

export interface MaterialAnalysisInput {
  source: MaterialSource;
  /** The owner's document and speech services (resolveExtractionServices). */
  services: ExtractionServices;
  request: MaterialExtractorRequest;
  /**
   * Keep the messages that would quote caller-controlled text (the file name,
   * the MIME type, an extractor's selection error) generic.
   */
  redactCallerInput: boolean;
  /** Filled in as the extractor resolves, for the caller's failure log. */
  trace?: { resolvedProviderId?: string };
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

/**
 * Operator opt-in for the MinerU Cloud fallback (default OFF). A self-hosted
 * MinerU deployment must never silently hand documents to a third-party cloud;
 * the MinerU Cloud fallback only happens when the operator explicitly enables
 * it with `ALLOW_MINERU_CLOUD_FALLBACK=true`.
 */
function isMinerUCloudFallbackEnabled(): boolean {
  const value = process.env.ALLOW_MINERU_CLOUD_FALLBACK;
  return value === 'true' || value === '1';
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
 * Run extractor selection and extraction over a normalized input. The upload
 * form and the asset-id form of the route share it so the two cannot drift;
 * `redactCallerInput` only switches the handful of messages that must stay
 * generic on the asset-id form (no caller-controlled text echoed).
 */
export async function analyzeMaterial(
  input: MaterialAnalysisInput,
  ctx: StepContext,
): Promise<ParsedPdfContent> {
  const { services, source, redactCallerInput } = input;
  const trace = input.trace ?? {};
  const { fileName, fileSize, mimeType, buffer } = source;
  // A configured or turned-off document slot decides the service; the
  // deprecated request fields may only pick a self-contained extractor.
  const governed = documentSlotGoverns(services);
  const requestConfig = slotGovernedRequest(services, input.request);

  async function extraction(
    extractor: DocumentExtractorProvider,
    extractorConfig: DocumentExtractorConfig,
  ): Promise<ParsedPdfContent> {
    const artifact = await extractor.extract({
      buffer,
      fileName,
      fileSize,
      mimeType,
      // The caller's signal stops the extractor's requests and commands.
      config: ctx.signal ? { ...extractorConfig, signal: ctx.signal } : extractorConfig,
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
        parser: result.metadata?.parser ?? extractor.id,
      },
    };
    return resultWithMetadata;
  }

  // Media (audio/video) takes the media extraction path → MediaArtifact,
  // flattened to the same text shape documents produce. Same route, same
  // downstream generation path.
  if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
    trace.resolvedProviderId = requestConfig.providerId || '';
    // Refuse a document-only provider (e.g. unpdf/mineru) for a media upload
    // clearly instead of forwarding it into the media registry and surfacing
    // an opaque failure.
    const mediaProvider = requestConfig.providerId
      ? getMediaExtractorProvider(requestConfig.providerId)
      : undefined;
    if (
      requestConfig.providerId &&
      (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType))
    ) {
      throw new StepRefusal<MaterialAnalysisRefusal>(
        'provider-cannot-extract',
        `Provider "${requestConfig.providerId}" cannot extract ${mimeType}. Choose a media-capable provider (AliDocMind or local ffmpeg).`,
      );
    }
    // The document slot's media extractor (openmaic.yml or the model
    // settings), else the legacy rules below.
    const slotMedia = slotMediaExtractorConfig(services, requestConfig.providerId);
    const mediaManaged =
      !slotMedia &&
      !governed &&
      requestConfig.providerId !== 'local-ffmpeg' &&
      isServerConfiguredProvider('pdf', 'alidocmind');
    // When managed, resolve the server-owned AK/SK (env OR YAML) explicitly so
    // a YAML-only deployment works — the client-level env fallback reads env
    // vars only. Client-entered creds are used only when unmanaged.
    const mediaManagedCreds = mediaManaged ? resolveManagedAliDocMindCredentials() : undefined;
    let mediaClientBaseUrl =
      mediaManaged || slotMedia ? undefined : requestConfig.baseUrl || undefined;
    // A client-supplied media extractor endpoint must pass the extractor's
    // endpoint rule (see checkClientMediaExtractorBaseUrl).
    if (mediaClientBaseUrl) {
      const checked = checkClientMediaExtractorBaseUrl(mediaClientBaseUrl);
      if (!checked.ok) {
        throw new StepRefusal<MaterialAnalysisRefusal>('endpoint-refused', checked.message);
      }
      mediaClientBaseUrl = checked.baseUrl;
    }
    const mediaArtifact = await extractMedia({
      buffer,
      fileName,
      fileSize,
      mimeType,
      config: slotMedia
        ? { ...slotMedia, providerId: requestConfig.providerId || '', signal: ctx.signal }
        : {
            signal: ctx.signal,
            providerId: requestConfig.providerId || '',
            // Local transcription uses the asr slot's connection.
            ...(services.asr ? { asr: services.asr } : {}),
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
    trace.resolvedProviderId = mediaArtifact.metadata.providerId || requestConfig.providerId || '';

    const mediaText = mediaArtifactToText(mediaArtifact);
    // An artifact with no transcript, keyframes, or synopsis carries no usable
    // content. Returning empty text would silently generate from nothing —
    // refuse instead. A redacted message does not echo the caller-controlled
    // file name.
    if (!mediaText.trim()) {
      throw new StepRefusal<MaterialAnalysisRefusal>(
        'no-content',
        redactCallerInput
          ? 'No transcript, keyframes, or synopsis could be extracted from this course material.'
          : `No transcript, keyframes, or synopsis could be extracted from "${fileName}".`,
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
        parser: mediaArtifact.metadata.providerId ?? trace.resolvedProviderId,
      },
    };
    return mediaResult;
  }

  // The document slot's service (openmaic.yml, the model settings, or the
  // default translated from the legacy provider variables) when the request
  // names no other extractor; a provider the request names keeps the legacy
  // rules below.
  const slotService =
    (services.document?.origin === 'configuration' || services.document?.origin === 'default') &&
    (!requestConfig.providerId || requestConfig.providerId === services.document.providerId)
      ? services.document
      : undefined;
  let provider = requestConfig.providerId
    ? getDocumentExtractorProvider(requestConfig.providerId)
    : slotService
      ? getDocumentExtractorProvider(slotService.providerId)
      : undefined;
  if (requestConfig.providerId && !provider) {
    throw new StepRefusal<MaterialAnalysisRefusal>(
      'unknown-provider',
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
    // With no provider hint and an unrecognized MIME, selection throws the
    // extractor registry's interpolated message (it carries the caller's MIME
    // type). The asset-id form must not echo caller-controlled input, so it
    // answers this catch with a generic static message; multipart keeps the
    // interpolated message byte-for-byte.
    throw new StepRefusal<MaterialAnalysisRefusal>(
      'unsupported-type',
      redactCallerInput
        ? 'The requested document extractor cannot process this course material.'
        : error instanceof Error
          ? error.message
          : `Unsupported course material type "${mimeType}"`,
    );
  }
  trace.resolvedProviderId = provider.id;

  const usesSlotService = slotService?.providerId === provider.id;
  if (governed && provider.requiresServiceConfig && !usesSlotService) {
    throw new StepRefusal<MaterialAnalysisRefusal>(
      'service-required',
      `${requestedTypeLabel(mimeType)} extraction needs a document service, and ${
        services.document ? 'the configured one cannot read this type' : 'none is configured'
      }. Assign one to the document slot in the model settings or openmaic.yml.`,
    );
  }

  if (slotService && usesSlotService) {
    let slotConfig = extractorConfigFor(provider.id, services);
    // A workspace provider's endpoint was typed by a user: the extractor's
    // endpoint rule applies as to a client one.
    if (!slotService.managed && slotConfig.baseUrl) {
      const checked = await checkClientDocumentExtractorBaseUrl(provider.id, slotConfig.baseUrl);
      if (!checked.ok) {
        throw new StepRefusal<MaterialAnalysisRefusal>('endpoint-refused', checked.message);
      }
      slotConfig = { ...slotConfig, baseUrl: checked.baseUrl };
    }
    return extraction(provider, slotConfig);
  }

  let managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
  let clientBaseUrl = managed ? undefined : requestConfig.baseUrl || undefined;
  if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
    const cloudProvider = getDocumentExtractorProvider('mineru-cloud');
    const cloudManaged = isServerConfiguredProvider('pdf', 'mineru-cloud');
    const cloudApiKey = resolvePDFApiKey(
      'mineru-cloud',
      cloudManaged ? undefined : requestConfig.apiKey || undefined,
    );
    const cloudFallbackAvailable =
      cloudProvider && supportsMimeType(cloudProvider, mimeType) && cloudApiKey;
    // A self-hosted extractor must never silently substitute a third-party
    // cloud: the MinerU Cloud fallback happens only under an explicit operator
    // opt-in (ALLOW_MINERU_CLOUD_FALLBACK, default OFF). Otherwise the request
    // fails loudly, naming what was configured (self-hosted MinerU) and what
    // was unavailable (its base URL).
    if (cloudFallbackAvailable && isMinerUCloudFallbackEnabled()) {
      provider = cloudProvider;
      managed = cloudManaged;
      clientBaseUrl = managed ? undefined : requestConfig.baseUrl || undefined;
      trace.resolvedProviderId = provider.id;
    } else {
      throw new StepRefusal<MaterialAnalysisRefusal>(
        'service-required',
        `${requestedTypeLabel(mimeType)} extraction requires a configured MinerU document extractor. ` +
          `Self-hosted MinerU was selected, but no self-hosted MinerU base URL is configured, so it is ` +
          `unavailable. Documents are not sent to MinerU Cloud automatically: configure a self-hosted MinerU ` +
          `base URL in PDF provider settings, or set ALLOW_MINERU_CLOUD_FALLBACK=1 to explicitly allow the ` +
          `MinerU Cloud fallback.`,
      );
    }
  }
  if (clientBaseUrl) {
    const checked = await checkClientDocumentExtractorBaseUrl(provider.id, clientBaseUrl);
    if (!checked.ok) {
      throw new StepRefusal<MaterialAnalysisRefusal>('endpoint-refused', checked.message);
    }
    clientBaseUrl = checked.baseUrl;
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
    managed,
  };

  return extraction(provider, config);
}
