import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssetStore } from '@openmaic/storage';
import { Type, type Static } from 'typebox';

import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { managedMediaProviderFetch, mediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { serverMediaConnection } from '@/lib/server/model-config/media';
import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
  ImageProviderId,
} from '@/lib/media/types';
import { enabledProviderIds, isServerProviderDisabled } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { resolveImageSize } from '@/lib/server/image-sizing';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import {
  AssetStorageFullError,
  storeGeneratedAssetOrThrow,
} from '@/lib/server/store-generated-asset';
import type { CourseToolDeps } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { errorResult, MEDIA_TOOL_ERROR_REASONS } from './media-tool-result';

const log = createLogger('AgentGenerateImage');

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const GENERATE_IMAGE_TIMEOUT_MS = 300_000;

export const GenerateImageParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  prompt: Type.String({
    minLength: 1,
    description: 'A concrete visual description of the image to create.',
  }),
  aspectRatio: Type.Optional(
    Type.Union([Type.Literal('16:9'), Type.Literal('1:1'), Type.Literal('4:3')], {
      description: 'Output aspect ratio. Defaults to 16:9.',
    }),
  ),
  styleHint: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Optional art-direction hint, such as watercolor, editorial photo or flat vector.',
    }),
  ),
});

type GenerateConfiguredImage = (
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
) => Promise<ImageGenerationResult>;

interface PersistImageInput {
  result: ImageGenerationResult;
  stageId: string;
  signal: AbortSignal;
  /** The run's owner; the bytes are allocated in its asset partition. */
  ownerId?: string;
}

type PersistGeneratedImage = (input: PersistImageInput) => Promise<string>;

export interface GenerateImageToolDeps extends Pick<
  CourseToolDeps,
  'sessionId' | 'abortSignal' | 'ownerId'
> {
  /** The providers to pick from; by default, the one the image slot resolves to. */
  getConfiguredProviders?: () => ImageProviderListing | Promise<ImageProviderListing>;
  resolveProviderConfig?: (
    providerId: ImageProviderId,
  ) => ImageGenerationConfig | Promise<ImageGenerationConfig>;
  generateConfiguredImage?: GenerateConfiguredImage;
  persistGeneratedImage?: PersistGeneratedImage;
  timeoutMs?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function combineSignals(primary: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return primary ? AbortSignal.any([primary, timeout]) : timeout;
}

function isTimeout(signal: AbortSignal): boolean {
  return (
    signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
  );
}

async function imageBytes(
  result: ImageGenerationResult,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  if (result.base64) {
    const bytes = Buffer.from(result.base64, 'base64');
    if (!bytes.length) throw new Error('Image provider returned empty base64 data');
    if (bytes.length > MAX_REMOTE_IMAGE_BYTES) {
      throw new Error(`Generated image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
    }
    // Inline bytes have no `Content-Type` to read, so the adapter that received
    // them is the one that knows their type. PNG stays the fallback for an
    // adapter that does not report one.
    return { bytes, mime: result.mimeType ?? 'image/png' };
  }
  if (!result.url) throw new Error('Image provider returned neither URL nor image bytes');

  const response = await fetchProviderResultUrl(result.url, {
    signal,
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
  });
  if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  if (!mime.startsWith('image/')) {
    throw new Error(`Generated image download returned unexpected content type: ${mime}`);
  }
  const bytes = await readResponseBodyWithLimit(response, {
    maxBytes: MAX_REMOTE_IMAGE_BYTES,
    aggregateBudget: new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES),
  });
  throwIfAborted(signal);
  return { bytes, mime };
}

/**
 * Store the generated bytes in the asset pool and return the id it allocated.
 *
 * The returned value is an `ast_` id, not a URL: the model puts it on an image
 * element through `patch_stage`, and that document write is what commits the
 * allocation and records the reference (#1473). Until it happens the entry is
 * pending and the collector will reclaim it, which is exactly the behaviour a
 * generation the agent never used should have.
 *
 * `assetStore` is a test seam — the historical shape of this function before
 * #1242 replaced the pool with a local file. Production calls pass nothing and
 * get this deployment's PostgreSQL store.
 */
export async function defaultPersistGeneratedImage(
  { result, stageId, signal, ownerId }: PersistImageInput,
  assetStore?: AssetStore,
): Promise<string> {
  if (!ownerId) throw new Error('Generated media cannot be stored without the run owner');
  const { bytes, mime } = await imageBytes(result, signal);
  throwIfAborted(signal);
  const assetId = await storeGeneratedAssetOrThrow({
    ownerId,
    stageId,
    bytes,
    mimeType: mime,
    kind: 'image',
    assetStore,
  });
  throwIfAborted(signal);
  return assetId;
}

type ImageProviderListing = Record<string, { models?: string[]; disabled?: boolean }>;

/**
 * Pick the image provider for this call: the first enabled one listed. The
 * default listing is the image slot's single provider. Resolution goes through
 * {@link enabledProviderIds}, so a force-disabled provider is never selected
 * (#665).
 */
function selectProvider(configured: ImageProviderListing): ImageProviderId | null {
  return (enabledProviderIds(configured)[0] as ImageProviderId | undefined) ?? null;
}

/**
 * The image slot for the run's owner as a one-provider listing and its
 * connection. Resolved once per call.
 */
function slotImageProvider(ownerId: string | undefined) {
  let pending: ReturnType<typeof serverMediaConnection> | undefined;
  const connection = () => (pending ??= serverMediaConnection('image', ownerId));
  return {
    listing: async (): Promise<ImageProviderListing> => {
      const resolved = await connection();
      return resolved && resolved !== 'off' ? { [resolved.providerId]: {} } : {};
    },
    config: async (providerId: ImageProviderId): Promise<ImageGenerationConfig> => {
      const resolved = await connection();
      if (!resolved || resolved === 'off' || resolved.providerId !== providerId) {
        throw new Error('the image slot no longer resolves to this provider');
      }
      return {
        providerId,
        apiKey: resolved.apiKey ?? '',
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        // A slot without a model uses the provider's first catalogue model.
        model: resolved.modelId ?? IMAGE_PROVIDERS[providerId]?.models?.[0]?.id,
        fetchImpl: resolved.managed ? managedMediaProviderFetch : mediaProviderFetch,
      };
    },
  };
}

export function buildGenerateImageTool(
  deps: GenerateImageToolDeps,
): AgentTool<typeof GenerateImageParams, unknown> {
  const providerSource = () => {
    const slot = slotImageProvider(deps.ownerId);
    return {
      configuredProviders: deps.getConfiguredProviders ?? slot.listing,
      resolveProviderConfig: deps.resolveProviderConfig ?? slot.config,
    };
  };
  const callProvider = deps.generateConfiguredImage ?? generateImage;
  const persist = deps.persistGeneratedImage ?? defaultPersistGeneratedImage;

  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: 'Generate image',
    description:
      'Create a new image from a prompt, store it with the explicitly targeted course media, and return its src plus dimensions. The src is a stored-asset id, not a URL; use it verbatim in a later patch_stage set of an existing media element, or add an image element with patch_stage. The image is only kept once a page references it. This tool never edits a page itself.',
    parameters: GenerateImageParams,
    async execute(toolCallId, params: Static<typeof GenerateImageParams>, signal) {
      const callerSignal = signal ?? deps.abortSignal;
      throwIfAborted(callerSignal);

      const prompt = params.prompt.trim();
      if (!prompt) return errorResult('Image generation failed: prompt must not be empty.');

      const stageId = params.stageId;
      throwIfAborted(callerSignal);

      const { configuredProviders, resolveProviderConfig } = providerSource();
      const providers = await configuredProviders();
      const providerId = selectProvider(providers);
      if (!providerId) {
        log.warn(`[${toolCallId}] Image generation unavailable: no image provider resolves`);
        return errorResult(
          'Image generation is unavailable: no server image provider is available.',
          {
            stageId,
            sessionId: deps.sessionId,
            reason: MEDIA_TOOL_ERROR_REASONS.noProvider,
          },
        );
      }

      // Defense in depth: the operator force-off is authoritative at the call
      // boundary — even if a caller explicitly selects a disabled provider id,
      // the call fails before any provider I/O (#665).
      if (isServerProviderDisabled('image', providerId)) {
        log.warn(
          `[${toolCallId}] Image generation rejected: provider ${providerId} is force-disabled`,
        );
        return errorResult('Image generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const provider = IMAGE_PROVIDERS[providerId];
      if (!provider) {
        log.error(
          `[${toolCallId}] Image generation unavailable: unsupported provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: the selected provider is not supported by this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.unsupportedProvider,
          },
        );
      }
      const providerConfig = await resolveProviderConfig(providerId);
      if (provider.requiresApiKey && !providerConfig.apiKey) {
        log.warn(
          `[${toolCallId}] Image generation unavailable: no API key configured for provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: no API key is configured for the selected image provider.',
          { stageId, reason: MEDIA_TOOL_ERROR_REASONS.missingApiKey },
        );
      }

      const model = providerConfig.model;
      // The server-side model resolution is authoritative: the tool never
      // accepts a caller-supplied model, and a provider that expects one
      // fails loud here instead of silently falling back to an adapter
      // default. Model-less providers (empty catalog, e.g. workflow-driven
      // runners) resolve their own target at call time.
      if ((provider.models?.length ?? 0) > 0 && !model) {
        log.warn(
          `[${toolCallId}] Image generation unavailable: no model configured for provider ${providerId}`,
        );
        return errorResult(
          'Image generation is unavailable: no model is configured for the selected image provider on this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.missingModel,
          },
        );
      }

      const options = resolveImageSize({
        prompt: params.styleHint
          ? `${prompt}\nStyle direction: ${params.styleHint.trim()}`
          : prompt,
        aspectRatio: params.aspectRatio ?? '16:9',
      });
      const ioSignal = combineSignals(callerSignal, deps.timeoutMs ?? GENERATE_IMAGE_TIMEOUT_MS);

      try {
        const result = await callProvider(providerConfig, {
          ...options,
          stageId,
          signal: ioSignal,
        });
        throwIfAborted(ioSignal);

        const src = await persist({
          result,
          stageId,
          signal: ioSignal,
          ...(deps.ownerId ? { ownerId: deps.ownerId } : {}),
        });
        throwIfAborted(ioSignal);
        void recordGenerationUsage({
          kind: 'image',
          unit: 'image',
          providerId,
          modelId: model,
          quantity: 1,
        });
        log.info(
          `[${toolCallId}] Image generated: provider=${providerId}, model=${model ?? 'default'}, ${result.width}x${result.height}`,
        );

        return {
          content: [
            {
              type: 'text',
              text: `Generated image: src=${src}, width=${result.width}, height=${result.height}. src is a stored-asset id; use it verbatim with patch_stage set or add an image element.`,
            },
          ],
          details: {
            src,
            width: result.width,
            height: result.height,
          },
        };
      } catch (error) {
        if (callerSignal?.aborted) throw new Error('aborted');
        // A full store is the one failure the model can act on, so it is said
        // plainly and given its own code. Nothing was written: there is no
        // local-disk fallback, because a fallback would put the workbench back
        // on two storage models — the thing this path exists to end.
        if (error instanceof AssetStorageFullError) {
          log.warn(`[${toolCallId}] Image generation refused: the asset store is full`);
          return errorResult(
            'Image generation failed: asset storage is full, so the generated image could not be stored. Nothing was saved. Ask the operator to raise the asset storage limit or free space, then try again.',
            { stageId, reason: MEDIA_TOOL_ERROR_REASONS.storageFull },
          );
        }
        if (isTimeout(ioSignal)) {
          log.warn(
            `[${toolCallId}] Image generation timed out: provider=${providerId}, model=${model ?? 'default'}, timeoutMs=${deps.timeoutMs ?? GENERATE_IMAGE_TIMEOUT_MS}`,
          );
          return errorResult('Image generation timed out after the configured server timeout.', {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.timeout,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `[${toolCallId}] Image generation failed: provider=${providerId}, model=${model ?? 'default'}, error=${message}`,
          error,
        );
        return errorResult('Image generation failed.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
      }
    },
  };
}
