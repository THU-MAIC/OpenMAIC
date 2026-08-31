import {
  createMaterialId,
  type ClaimedMaterialExtraction,
  type CompleteMaterialExtractionInput,
} from '@openmaic/storage';

import {
  getDocumentExtractorProviders,
  getMediaExtractorProviders,
  selectMediaExtractorProvider,
  type DocumentArtifact,
  type DocumentExtractorProvider,
  type MediaArtifact,
  type MediaExtractorProvider,
} from '@/lib/document';
import {
  getServerPDFProviders,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
  resolveServerMediaExtractorConfig,
} from '@/lib/server/provider-config';
import {
  discardSessionMaterialObjectWrite,
  finalizeSessionMaterialObjectWrite,
  getAgentSessionMaterialStore,
  removeSessionMaterialRawAsset,
  resolveSessionMaterialRawAsset,
  storeSessionMaterialRawAsset,
  type SessionMaterialObjectWrite,
} from '@/lib/server/agent-runtime/session-materials';

import { isTransientExtractionError, MaterialExtractionError } from './errors';

export interface MaterialExtractionExecutionDependencies {
  resolveSource?: (
    sessionId: string,
    assetId: string,
  ) => Promise<{ bytes: Buffer; mime: string } | null>;
  providers?: () => DocumentExtractorProvider[];
  mediaProviders?: () => MediaExtractorProvider[];
  configuredProviderIds?: () => string[];
  putText?: (
    sessionId: string,
    text: Buffer,
    material: {
      id: string;
      kind: 'extraction' | 'transcript';
      derivedFrom: string;
    },
  ) => Promise<StoredSessionMaterialObject>;
  putBytes?: (
    sessionId: string,
    bytes: Buffer,
    mime: string,
    material: { id: string; kind: 'image'; derivedFrom: string },
  ) => Promise<StoredSessionMaterialObject>;
  complete?: (input: CompleteMaterialExtractionInput) => Promise<boolean>;
  removeAsset?: (sessionId: string, assetId: string) => Promise<void>;
  finalizeObjectWrite?: (write: SessionMaterialObjectWrite) => Promise<boolean>;
  discardObjectWrite?: (write: SessionMaterialObjectWrite) => Promise<void>;
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

export type StoredSessionMaterialObject = string | SessionMaterialObjectWrite;

function objectKeyOf(stored: StoredSessionMaterialObject): string {
  return typeof stored === 'string' ? stored : stored.objectKey;
}

async function putTextObject(
  dependencies: MaterialExtractionExecutionDependencies,
  source: ClaimedMaterialExtraction['material'],
  materialId: string,
  kind: 'extraction' | 'transcript',
  text: Buffer,
): Promise<StoredSessionMaterialObject> {
  if (dependencies.putText) {
    return dependencies.putText(source.sessionId, text, {
      id: materialId,
      kind,
      derivedFrom: source.id,
    });
  }
  return storeSessionMaterialRawAsset(source.sessionId, materialId, kind, text, 'text/markdown', {
    derivedFrom: source.id,
    objectSlot: 'text',
  });
}

async function putRawObject(
  dependencies: MaterialExtractionExecutionDependencies,
  source: ClaimedMaterialExtraction['material'],
  materialId: string,
  bytes: Buffer,
  mime: string,
): Promise<StoredSessionMaterialObject> {
  if (dependencies.putBytes) {
    return dependencies.putBytes(source.sessionId, bytes, mime, {
      id: materialId,
      kind: 'image',
      derivedFrom: source.id,
    });
  }
  return storeSessionMaterialRawAsset(source.sessionId, materialId, 'image', bytes, mime, {
    derivedFrom: source.id,
  });
}

async function discardStoredObject(
  stored: StoredSessionMaterialObject,
  sessionId: string,
  dependencies: MaterialExtractionExecutionDependencies,
): Promise<void> {
  if (typeof stored === 'string') {
    await (dependencies.removeAsset ?? removeSessionMaterialRawAsset)(sessionId, stored);
    return;
  }
  await (dependencies.discardObjectWrite ?? discardSessionMaterialObjectWrite)(stored);
}

async function finalizeStoredObjects(
  stored: readonly StoredSessionMaterialObject[],
  dependencies: MaterialExtractionExecutionDependencies,
): Promise<boolean> {
  for (const object of stored) {
    if (
      typeof object !== 'string' &&
      !(await (dependencies.finalizeObjectWrite ?? finalizeSessionMaterialObjectWrite)(object))
    ) {
      return false;
    }
  }
  return true;
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

  const mediaProviders = dependencies.mediaProviders?.() ?? getMediaExtractorProviders();
  const isMedia = mediaProviders.some((provider) =>
    provider.supportedMimeTypes.includes(raw.mime.toLowerCase()),
  );
  if (isMedia) {
    const mediaInput = {
      buffer: raw.bytes,
      fileName: source.title ?? undefined,
      fileSize: raw.bytes.byteLength,
      mimeType: raw.mime,
      config: resolveServerMediaExtractorConfig(),
    };
    let selected: MediaExtractorProvider | undefined;
    let artifact: MediaArtifact;
    try {
      selected = await selectMediaExtractorProvider({
        mimeType: raw.mime,
        input: mediaInput,
        providers: mediaProviders,
      });
      artifact = await selected.extract({
        ...mediaInput,
        config: { ...mediaInput.config, providerId: selected.id },
      });
    } catch (error) {
      throw new MaterialExtractionError(
        error instanceof Error ? error.message : String(error),
        isTransientExtractionError(error),
        {
          cause: error,
          ...(selected ? {} : { publicCode: 'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE' as const }),
        },
      );
    }
    const text = mediaArtifactText(artifact);
    if (!text) {
      throw new MaterialExtractionError(
        'media extraction produced no transcript; configure a working local ASR provider or a cloud media extractor',
        false,
      );
    }
    const transcriptId = createMaterialId();
    const allocatedObjects: StoredSessionMaterialObject[] = [];
    let textAssetId: string;
    const images: Array<{
      id: string;
      kind: 'image';
      title: string;
      rawAssetId: string;
    }> = [];
    try {
      const textObject = await putTextObject(
        dependencies,
        source,
        transcriptId,
        'transcript',
        Buffer.from(text, 'utf8'),
      );
      allocatedObjects.push(textObject);
      textAssetId = objectKeyOf(textObject);
      for (const asset of artifact.assets ?? []) {
        if (asset.type !== 'image' || !asset.data) continue;
        const imageId = createMaterialId();
        const bytes = Buffer.from(asset.data, 'base64');
        const rawObject = await putRawObject(
          dependencies,
          source,
          imageId,
          bytes,
          asset.mimeType ?? 'image/webp',
        );
        allocatedObjects.push(rawObject);
        images.push({
          id: imageId,
          kind: 'image' as const,
          title: asset.description ?? `${source.title ?? 'media'}.${asset.id}.webp`,
          rawAssetId: objectKeyOf(rawObject),
        });
      }
    } catch (error) {
      await Promise.all(
        allocatedObjects.map((stored) =>
          discardStoredObject(stored, source.sessionId, dependencies).catch(() => undefined),
        ),
      );
      throw error;
    }
    const store = dependencies.complete ? undefined : await getAgentSessionMaterialStore();
    const complete = dependencies.complete ?? store!.completeExtraction.bind(store);
    const extractorVersion = `${selected.id}@${selected.version}`;
    const completed = await complete({
      sourceId: source.id,
      workerId: claim.workerId,
      extractorVersion,
      stats: {
        chars: text.length,
        pages: 0,
        imageCount: images.length,
        durationSec: artifact.metadata.durationMs ? artifact.metadata.durationMs / 1000 : undefined,
        asrChunks: artifact.transcript?.length ?? 0,
      },
      derived: [
        {
          id: transcriptId,
          kind: 'transcript',
          title: source.title ? `${source.title}.transcript.md` : 'transcript.md',
          textAssetId,
          textChars: text.length,
        },
        ...images,
      ],
    });
    if (!completed) {
      await Promise.all(
        allocatedObjects.map((stored) =>
          discardStoredObject(stored, source.sessionId, dependencies).catch(() => undefined),
        ),
      );
      throw new Error(`material extraction lease lost for ${source.id}`);
    }
    if (!(await finalizeStoredObjects(allocatedObjects, dependencies))) {
      throw new Error(`material extraction session deleted for ${source.id}`);
    }
    return { materialId: transcriptId, text, extractorVersion };
  }

  const providers = dependencies.providers?.() ?? getDocumentExtractorProviders();
  const configuredIds =
    dependencies.configuredProviderIds?.() ?? Object.keys(getServerPDFProviders());
  const candidates = extractorCandidates(raw.mime, providers, configuredIds);
  if (candidates.length === 0) {
    throw new MaterialExtractionError(`no document extractor supports ${raw.mime}`, false, {
      publicCode: 'MATERIAL_EXTRACTION_UNSUPPORTED',
    });
  }

  const errors: string[] = [];
  const failures: unknown[] = [];
  let artifact: DocumentArtifact | undefined;
  let selected: DocumentExtractorProvider | undefined;
  for (const provider of candidates) {
    try {
      artifact = await provider.extract({
        buffer: raw.bytes,
        fileName: source.title ?? undefined,
        fileSize: raw.bytes.byteLength,
        mimeType: raw.mime,
        config: {
          providerId: provider.id,
          apiKey: resolvePDFApiKey(provider.id) || undefined,
          baseUrl: resolvePDFBaseUrl(provider.id),
          allowEnvFallback: true,
        },
      });
      selected = provider;
      break;
    } catch (error) {
      errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      failures.push(error);
    }
  }
  if (!artifact || !selected) {
    throw new MaterialExtractionError(
      `document extraction failed (${errors.join('; ')})`,
      failures.some(isTransientExtractionError),
    );
  }

  const text = artifactText(artifact);
  const bytes = Buffer.from(text, 'utf8');
  const derivativeId = createMaterialId();
  const textObject = await putTextObject(dependencies, source, derivativeId, 'extraction', bytes);
  const textAssetId = objectKeyOf(textObject);
  const store = dependencies.complete ? undefined : await getAgentSessionMaterialStore();
  const complete = dependencies.complete ?? store!.completeExtraction.bind(store);
  const extractorVersion = `${selected.id}@${selected.version}`;
  const completed = await complete({
    sourceId: source.id,
    workerId: claim.workerId,
    extractorVersion,
    stats: {
      chars: text.length,
      pages: artifact.metadata.pageCount ?? 0,
      imageCount: artifact.assets.filter((asset) => asset.type === 'image').length,
    },
    derived: {
      id: derivativeId,
      kind: 'extraction',
      title: source.title ? `${source.title}.extracted.md` : 'extracted.md',
      textAssetId,
      textChars: text.length,
    },
  });
  if (!completed) {
    await discardStoredObject(textObject, source.sessionId, dependencies).catch(() => undefined);
    throw new Error(`material extraction lease lost for ${source.id}`);
  }
  if (!(await finalizeStoredObjects([textObject], dependencies))) {
    throw new Error(`material extraction session deleted for ${source.id}`);
  }
  return { materialId: derivativeId, text, extractorVersion };
}
