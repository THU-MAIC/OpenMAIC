/**
 * The services server-side extraction may use for an owner (RFC #1701):
 * the document slot's service (MinerU, AliDocMind, ...) with its credentials,
 * and the asr slot's connection for media extractors that transcribe. The
 * self-contained extractors need neither and are always available.
 */
import type { ASRModelConfig, ASRProviderId } from '@/lib/audio/types';
import type { DocumentExtractorConfig } from '@/lib/document/types';
import { serverMediaConnection, type MediaConnection } from '@/lib/server/model-config/media';

export interface ExtractionServices {
  /** The document slot's service, or null for self-contained extraction only. */
  document: MediaConnection | null;
  /** The asr slot's connection, or undefined when speech recognition is off or unset. */
  asr?: ASRModelConfig;
}

const usable = (connection: MediaConnection | 'off' | null) =>
  connection && connection !== 'off' ? connection : null;

/**
 * Resolve the services for `ownerId`: a stored owner of background work, or a
 * request's workspace id, or none for the deployment's configuration alone.
 */
export async function resolveExtractionServices(ownerId?: string): Promise<ExtractionServices> {
  const [document, asr] = await Promise.all([
    serverMediaConnection('document', ownerId),
    serverMediaConnection('asr', ownerId),
  ]);
  const speech = usable(asr);
  return {
    document: usable(document),
    ...(speech
      ? {
          asr: {
            providerId: speech.providerId as ASRProviderId,
            ...(speech.modelId ? { modelId: speech.modelId } : {}),
            ...(speech.apiKey ? { apiKey: speech.apiKey } : {}),
            ...(speech.baseUrl ? { baseUrl: speech.baseUrl } : {}),
            language: 'auto',
          },
        }
      : {}),
  };
}

/** The extractor config for `providerId`: the document service's credentials when it is the one. */
export function extractorConfigFor(
  providerId: string,
  services: ExtractionServices,
): DocumentExtractorConfig {
  const service = services.document?.providerId === providerId ? services.document : undefined;
  return {
    providerId: providerId as DocumentExtractorConfig['providerId'],
    ...(service?.apiKey ? { apiKey: service.apiKey } : {}),
    ...(service?.baseUrl ? { baseUrl: service.baseUrl } : {}),
    ...(service?.credentials?.accessKeyId
      ? {
          accessKeyId: service.credentials.accessKeyId,
          accessKeySecret: service.credentials.accessKeySecret,
        }
      : {}),
    // Keys come from the configuration, never from the process environment.
    allowEnvFallback: false,
    managed: service ? service.managed : true,
    ...(services.asr ? { asr: services.asr } : {}),
  };
}

/** The media extractor config: the document service's key pair if it is AliDocMind. */
export function mediaExtractorConfig(services: ExtractionServices): DocumentExtractorConfig {
  const alidocmind = services.document?.providerId === 'alidocmind' ? services.document : undefined;
  return {
    ...extractorConfigFor(alidocmind ? 'alidocmind' : '', services),
    providerId: '' as DocumentExtractorConfig['providerId'],
  };
}

/**
 * The media extractor config of the document slot's service, when that service
 * extracts media (AliDocMind) and the request does not ask for local
 * extraction; undefined otherwise.
 */
export function slotMediaExtractorConfig(
  services: ExtractionServices,
  requestedProviderId: string | undefined,
): DocumentExtractorConfig | undefined {
  const service = services.document;
  if (
    requestedProviderId === 'local-ffmpeg' ||
    service?.origin !== 'configuration' ||
    service.providerId !== 'alidocmind'
  ) {
    return undefined;
  }
  return mediaExtractorConfig(services);
}
