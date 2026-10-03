import {
  createMaterialId,
  type ClaimedMaterialExtraction,
  type CompleteMaterialExtractionInput,
  type MaterialExtractionStats,
} from '@openmaic/storage';

import {
  getDocumentExtractorProviders,
  getMediaExtractorProviders,
  selectMediaExtractorProvider,
  type DocumentArtifact,
  type DocumentExtractorInput,
  type DocumentExtractorProvider,
  type MediaArtifact,
  type MediaExtractorInput,
  type MediaExtractorProvider,
} from '@/lib/document';
import {
  getServerPDFProviders,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
  resolveServerMediaExtractorConfig,
} from '@/lib/server/provider-config';
import {
  getAgentSessionMaterialStore,
  resolveSessionMaterialRawAsset,
  storeSessionMaterialRawAsset,
} from '@/lib/server/agent-runtime/session-materials';

import { isTransientExtractionError, MaterialExtractionError } from './errors';

/** Which extractors a source's bytes go to: the registry seams both extraction paths share. */
export interface ExtractorRegistryDependencies {
  providers?: () => DocumentExtractorProvider[];
  mediaProviders?: () => MediaExtractorProvider[];
  configuredProviderIds?: () => string[];
}

export interface MaterialExtractionExecutionDependencies extends ExtractorRegistryDependencies {
  resolveSource?: (
    sessionId: string,
    assetId: string,
  ) => Promise<{ bytes: Buffer; mime: string } | null>;
  putText?: (sessionId: string, text: Buffer) => Promise<string>;
  putBytes?: (sessionId: string, bytes: Buffer, mime: string) => Promise<string>;
  complete?: (input: CompleteMaterialExtractionInput) => Promise<boolean>;
}

function artifactText(artifact: DocumentArtifact): string {
  return artifact.blocks
    .filter((block) => block.type === 'text' || block.type === 'markdown')
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
}

function markerTime(timeMs: number): string {
  const totalSeconds = Math.max(0, timeMs) / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(3).padStart(6, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

export function decodeMediaAssetData(data: string): Buffer {
  const value = data.trim();
  const dataUrl = /^data:([^,]*),([\s\S]*)$/i.exec(value);
  if (!dataUrl) {
    // Node's base64 decoder skips non-alphabet characters, so a malformed data
    // URL falling through here would decode to garbage bytes instead of failing.
    if (/^data:/i.test(value)) throw new Error('Malformed media asset data URL');
    return Buffer.from(value, 'base64');
  }
  if (!/;base64$/i.test(dataUrl[1])) {
    throw new Error('Unsupported media asset data URL encoding');
  }
  const bytes = Buffer.from(dataUrl[2], 'base64');
  if (bytes.byteLength === 0) throw new Error('Empty media asset data URL payload');
  return bytes;
}

export function mediaArtifactText(artifact: MediaArtifact): string {
  return (artifact.transcript ?? [])
    .filter((segment) => segment.text.trim())
    .map(
      (segment) =>
        `[${markerTime(segment.startMs)} - ${markerTime(segment.endMs)}] ${segment.text.trim()}`,
    )
    .join('\n\n');
}

function extractorCandidates(
  mime: string,
  providers: DocumentExtractorProvider[],
  configuredIds: string[],
): DocumentExtractorProvider[] {
  const supported = providers.filter((provider) =>
    provider.supportedMimeTypes.includes(mime.toLowerCase()),
  );
  const configured = new Set(configuredIds);
  return supported.toSorted(
    (left, right) => Number(configured.has(right.id)) - Number(configured.has(left.id)),
  );
}

async function defaultResolveSource(sessionId: string, objectKey: string) {
  return resolveSessionMaterialRawAsset(sessionId, objectKey);
}

async function defaultPutText(sessionId: string, text: Buffer): Promise<string> {
  const key = await storeSessionMaterialRawAsset(sessionId, text, 'text/markdown');
  return key;
}

async function defaultPutBytes(sessionId: string, bytes: Buffer, mime: string): Promise<string> {
  return storeSessionMaterialRawAsset(sessionId, bytes, mime);
}

/**
 * The extractor a source will go to, chosen before anything runs: one media
 * provider, or the document providers in the order they are tried.
 */
export type SourceExtractionPlan =
  | { kind: 'media'; provider: MediaExtractorProvider; input: MediaExtractorInput }
  | {
      kind: 'document';
      candidates: DocumentExtractorProvider[];
      input: Omit<DocumentExtractorInput, 'config'>;
    };

/** An image the extractor returned, not yet decoded or stored. */
export interface ExtractedSourceImage {
  /** Base64 or data-URL bytes, as the provider returned them (see {@link decodeMediaAssetData}). */
  data: string;
  mimeType: string;
  title: string;
  pageNumber?: number;
  timeMs?: number;
  /** What the extracted text calls this image (`openmaic-derivative:<key>`), if it names it. */
  key?: string;
}

/** What one extraction produced, before any of it is stored. */
export interface SourceExtractionOutcome {
  text: string;
  images: ExtractedSourceImage[];
  /** The provider that actually produced the result (after any fallback). */
  extractor: { id: string; version: string };
  stats: MaterialExtractionStats;
}

function wrapProviderError(error: unknown): MaterialExtractionError {
  return new MaterialExtractionError(
    error instanceof Error ? error.message : String(error),
    isTransientExtractionError(error),
    { cause: error },
  );
}

/** Choose the extractor for a source's bytes without running it. */
export async function planSourceExtraction(
  raw: { bytes: Buffer; mime: string },
  title: string | null,
  dependencies: ExtractorRegistryDependencies = {},
): Promise<SourceExtractionPlan> {
  const mediaProviders = dependencies.mediaProviders?.() ?? getMediaExtractorProviders();
  const isMedia = mediaProviders.some((provider) =>
    provider.supportedMimeTypes.includes(raw.mime.toLowerCase()),
  );
  if (isMedia) {
    const input = {
      buffer: raw.bytes,
      fileName: title ?? undefined,
      fileSize: raw.bytes.byteLength,
      mimeType: raw.mime,
      config: resolveServerMediaExtractorConfig(),
    };
    let provider: MediaExtractorProvider;
    try {
      provider = await selectMediaExtractorProvider({
        mimeType: raw.mime,
        input,
        providers: mediaProviders,
      });
    } catch (error) {
      throw wrapProviderError(error);
    }
    return { kind: 'media', provider, input };
  }

  const providers = dependencies.providers?.() ?? getDocumentExtractorProviders();
  const configuredIds =
    dependencies.configuredProviderIds?.() ?? Object.keys(getServerPDFProviders());
  const candidates = extractorCandidates(raw.mime, providers, configuredIds);
  if (candidates.length === 0) throw new Error(`no document extractor supports ${raw.mime}`);
  return {
    kind: 'document',
    candidates,
    input: {
      buffer: raw.bytes,
      fileName: title ?? undefined,
      fileSize: raw.bytes.byteLength,
      mimeType: raw.mime,
    },
  };
}

/** The extractor a plan tries first: the one that runs unless it fails. */
export function plannedExtractor(plan: SourceExtractionPlan): { id: string; version: string } {
  const provider = plan.kind === 'media' ? plan.provider : plan.candidates[0];
  return { id: provider.id, version: provider.version };
}

/** Run a plan's extractor (falling back across document providers) and return its output. */
export async function runSourceExtraction(
  plan: SourceExtractionPlan,
  title: string | null,
): Promise<SourceExtractionOutcome> {
  if (plan.kind === 'media') {
    let artifact: MediaArtifact;
    try {
      artifact = await plan.provider.extract({
        ...plan.input,
        config: { ...plan.input.config, providerId: plan.provider.id },
      });
    } catch (error) {
      throw wrapProviderError(error);
    }
    const text = mediaArtifactText(artifact);
    if (!text) {
      throw new MaterialExtractionError(
        'media extraction produced no transcript; configure a working local ASR provider or a cloud media extractor',
        false,
      );
    }
    const images: ExtractedSourceImage[] = [];
    for (const asset of artifact.assets ?? []) {
      if (asset.type !== 'image' || !asset.data) continue;
      const timeMs = asset.metadata?.timeMs;
      images.push({
        data: asset.data,
        mimeType: asset.mimeType ?? 'image/webp',
        title: asset.description ?? `${title ?? 'media'}.${asset.id}.webp`,
        ...(asset.pageNumber === undefined ? {} : { pageNumber: asset.pageNumber }),
        ...(typeof timeMs === 'number' ? { timeMs } : {}),
      });
    }
    return {
      text,
      images,
      extractor: { id: plan.provider.id, version: plan.provider.version },
      stats: {
        chars: text.length,
        pages: 0,
        imageCount: images.length,
        durationSec: artifact.metadata.durationMs ? artifact.metadata.durationMs / 1000 : undefined,
        asrChunks: artifact.transcript?.length ?? 0,
        ...(artifact.diagnostics?.length
          ? { diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic.message) }
          : {}),
      },
    };
  }

  const errors: string[] = [];
  const failures: unknown[] = [];
  for (const provider of plan.candidates) {
    let artifact: DocumentArtifact;
    try {
      artifact = await extractWithDocumentProvider(provider, plan.input);
    } catch (error) {
      errors.push(documentFailureLine(provider, error));
      failures.push(error);
      continue;
    }
    return documentOutcome(artifact, provider);
  }
  throw documentExtractionFailure(errors, failures);
}

/** Run one document provider on a planned input; a failure is the provider's own error. */
export function extractWithDocumentProvider(
  provider: DocumentExtractorProvider,
  input: Extract<SourceExtractionPlan, { kind: 'document' }>['input'],
): Promise<DocumentArtifact> {
  return provider.extract({
    ...input,
    config: {
      providerId: provider.id,
      apiKey: resolvePDFApiKey(provider.id) || undefined,
      baseUrl: resolvePDFBaseUrl(provider.id),
      allowEnvFallback: true,
      managed: true,
    },
  });
}

/** One line of the combined failure message, for a provider that failed. */
export function documentFailureLine(provider: DocumentExtractorProvider, error: unknown): string {
  return `${provider.id}: ${error instanceof Error ? error.message : String(error)}`;
}

/** The failure once every document provider failed: retryable if any failure was transient. */
export function documentExtractionFailure(
  errors: string[],
  failures: unknown[],
): MaterialExtractionError {
  return new MaterialExtractionError(
    `document extraction failed (${errors.join('; ')})`,
    failures.some(isTransientExtractionError),
  );
}

/** What a document provider's artifact is kept as. */
export function documentOutcome(
  artifact: DocumentArtifact,
  provider: DocumentExtractorProvider,
): SourceExtractionOutcome {
  const text = artifactText(artifact);
  return {
    text,
    // Document images are not kept: the text is stored as the provider
    // returned it, the same output the session chain has always published.
    images: [],
    extractor: { id: provider.id, version: provider.version },
    stats: {
      chars: text.length,
      pages: artifact.metadata.pageCount ?? 0,
      imageCount: artifact.assets.filter((asset) => asset.type === 'image').length,
      ...(artifact.diagnostics?.length
        ? { diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic.message) }
        : {}),
    },
  };
}

/** Extract one lease-fenced source through the upstream extractor registry. */
export async function extractClaimedSessionMaterial(
  claim: ClaimedMaterialExtraction,
  dependencies: MaterialExtractionExecutionDependencies = {},
): Promise<{ materialId: string; text: string; extractorVersion: string }> {
  const source = claim.material;
  if (!source.rawAssetId) throw new Error(`source material ${source.id} has no raw asset`);
  const resolveSource = dependencies.resolveSource ?? defaultResolveSource;
  const raw = await resolveSource(source.sessionId, source.rawAssetId);
  if (!raw) throw new Error(`source bytes are unavailable for material ${source.id}`);

  const plan = await planSourceExtraction(raw, source.title, dependencies);
  const outcome = await runSourceExtraction(plan, source.title);
  const { text } = outcome;
  const textAssetId = await (dependencies.putText ?? defaultPutText)(
    source.sessionId,
    Buffer.from(text, 'utf8'),
  );
  const putBytes = dependencies.putBytes ?? defaultPutBytes;
  const images = [];
  for (const image of outcome.images) {
    const bytes = decodeMediaAssetData(image.data);
    const rawAssetId = await putBytes(source.sessionId, bytes, image.mimeType);
    images.push({
      id: createMaterialId(),
      kind: 'image' as const,
      title: image.title,
      rawAssetId,
    });
  }
  const store = dependencies.complete ? undefined : await getAgentSessionMaterialStore();
  const complete = dependencies.complete ?? store!.completeExtraction.bind(store);
  const extractorVersion = `${outcome.extractor.id}@${outcome.extractor.version}`;
  const derivativeId = createMaterialId();
  const completed = await complete({
    sourceId: source.id,
    workerId: claim.workerId,
    extractorVersion,
    stats: outcome.stats,
    derived:
      plan.kind === 'media'
        ? [
            {
              id: derivativeId,
              kind: 'transcript',
              title: source.title ? `${source.title}.transcript.md` : 'transcript.md',
              textAssetId,
              textChars: text.length,
            },
            ...images,
          ]
        : {
            id: derivativeId,
            kind: 'extraction',
            title: source.title ? `${source.title}.extracted.md` : 'extracted.md',
            textAssetId,
            textChars: text.length,
          },
  });
  if (!completed) throw new Error(`material extraction lease lost for ${source.id}`);
  return { materialId: derivativeId, text, extractorVersion };
}
