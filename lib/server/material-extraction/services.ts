/**
 * The services server-side extraction may use for an owner (RFC #1701):
 * the document slot's service (MinerU, AliDocMind, ...) with its credentials,
 * and the asr slot's connection for media extractors that transcribe. The
 * self-contained extractors need neither and are always available.
 */
import type { ASRModelConfig, ASRProviderId } from '@/lib/audio/types';
import type { DocumentExtractorConfig } from '@/lib/document/types';
import {
  getDocumentExtractorManifestEntry,
  getMediaExtractorManifestEntry,
} from '@/lib/document/extractors/manifest';
import { BROWSER_NATIVE_ASR_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import { createLogger } from '@/lib/logger';
import {
  mediaWorkspaceId,
  resolveMediaSlot,
  serverMediaConnection,
  WorkspaceEndpointError,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import {
  requestProvidersAllowed,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';

const log = createLogger('ExtractionServices');

export interface ExtractionServices {
  /** The document slot's service, or null for self-contained extraction only. */
  document: MediaConnection | null;
  /**
   * How the document slot resolved: configured (openmaic.yml or the model
   * settings), a legacy default, turned off (self-contained extraction only),
   * unassigned (a request may still name a provider the old way), or
   * unassigned inside a locked subtree (`lock: all`): fixed as nothing, so
   * a request names nothing either.
   */
  documentStatus?: 'configured' | 'default' | 'disabled' | 'unassigned' | 'locked';
  /** The asr slot's connection, or undefined when speech recognition is off or unset. */
  asr?: ASRModelConfig;
}

const usable = (connection: MediaConnection | 'off' | 'locked' | null) =>
  connection && connection !== 'off' && connection !== 'locked' ? connection : null;

/** The document slot's connection; 'locked' when a lock fixes it as unassigned. */
async function documentConnection(
  ownerId: string | undefined,
  forward: boolean,
): Promise<MediaConnection | 'off' | 'locked' | null> {
  try {
    return await resolveMediaSlot('document', {
      workspaceId: await mediaWorkspaceId(ownerId, { forward }),
    });
  } catch (error) {
    if (error instanceof SlotDisabledError) return 'off';
    if (error instanceof SlotUnassignedError) return error.locked ? 'locked' : null;
    throw error;
  }
}

/**
 * Resolve the services for `ownerId`: a stored owner of background work, or a
 * request's workspace id, or none for the deployment's configuration alone.
 */
export async function resolveExtractionServices(
  ownerId?: string,
  { forward = true }: { forward?: boolean } = {},
): Promise<ExtractionServices> {
  const [document, asr] = await Promise.all([
    documentConnection(ownerId, forward),
    // Speech only serves media extraction: an asr assignment this workspace
    // may not use leaves transcription unavailable, not every extraction.
    serverMediaConnection('asr', ownerId, { forward }).catch((error: unknown) => {
      if (!(error instanceof WorkspaceEndpointError)) throw error;
      log.warn(`Speech recognition unavailable for extraction: ${error.message}`);
      return null;
    }),
  ]);
  // Speech recognition that runs in the browser cannot transcribe server-side.
  const speech = usable(asr)?.providerId === BROWSER_NATIVE_ASR_PROVIDER_ID ? null : usable(asr);
  return {
    document: usable(document),
    documentStatus:
      document === 'off'
        ? 'disabled'
        : document === 'locked'
          ? 'locked'
          : !document
            ? 'unassigned'
            : document.origin === 'configuration'
              ? 'configured'
              : 'default',
    ...(speech
      ? {
          asr: {
            providerId: speech.providerId as ASRProviderId,
            ...(speech.modelId ? { modelId: speech.modelId } : {}),
            ...(speech.apiKey ? { apiKey: speech.apiKey } : {}),
            ...(speech.baseUrl ? { baseUrl: speech.baseUrl } : {}),
            language: 'auto',
            // The same network policy the transcription route applies.
            managed: speech.managed,
            publicOnly: speech.userEndpoint,
          },
        }
      : {}),
  };
}

/**
 * Whether the extractor `id` runs without a document service (its own code, or
 * the asr slot for speech); an extractor that needs one is registered under
 * the same id as a document extractor requiring service configuration.
 */
export function isSelfContainedExtractor(id: string): boolean {
  if (!getDocumentExtractorManifestEntry(id) && !getMediaExtractorManifestEntry(id)) return false;
  return getDocumentExtractorManifestEntry(id)?.requiresServiceConfig !== true;
}

/** Whether the document slot, not the deprecated request fields, decides the service. */
export function documentSlotGoverns(services: ExtractionServices): boolean {
  return (
    services.documentStatus === 'configured' ||
    services.documentStatus === 'disabled' ||
    services.documentStatus === 'locked'
  );
}

interface RequestedExtraction {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

/**
 * The deprecated request fields that still apply: all of them while the
 * document slot is unassigned (or a legacy default); once it is configured or
 * turned off, or always under `allowUserKeys: false`, only
 * the choice of a self-contained extractor or of the slot's own service, and
 * never request credentials or endpoints.
 */
export function slotGovernedRequest<T extends RequestedExtraction>(
  services: ExtractionServices,
  request: T,
): RequestedExtraction {
  if (!documentSlotGoverns(services) && requestProvidersAllowed()) return request;
  const providerId = request.providerId;
  const keep =
    providerId &&
    (isSelfContainedExtractor(providerId) || providerId === services.document?.providerId);
  return keep ? { providerId } : {};
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
