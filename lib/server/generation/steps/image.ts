/**
 * Image: generate one image from a prompt through the image slot's provider.
 * Moved from POST /api/generate/image, which keeps resolving the slot (with
 * the request's deprecated provider headers) and mapping failures to its
 * responses.
 */
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type {
  ImageGenerationOptions,
  ImageGenerationResult,
  ImageProviderId,
} from '@/lib/media/types';
import { resolveImageModel } from '@/lib/server/provider-config';
import type { MediaConnection } from '@/lib/server/model-config/media';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { resolveImageSize } from '@/lib/server/image-sizing';
import { recordGenerationUsage } from '@/lib/server/usage-storage';

import { StepRefusal, type StepContext } from './context';

export interface ImageInput {
  options: ImageGenerationOptions;
  /** The image slot's connection. */
  connection: MediaConnection;
  /**
   * The model a deprecated request names; it still applies, through the
   * provider's allowlist, on the legacy default provider.
   */
  requestedModel?: string;
}

export type ImageRefusal = 'missing-api-key' | 'missing-model';

export async function generateImageStep(
  input: ImageInput,
  ctx: StepContext,
): Promise<ImageGenerationResult> {
  const { connection } = input;
  const { providerId, apiKey, baseUrl, managed } = connection as MediaConnection & {
    providerId: ImageProviderId;
  };
  const provider = IMAGE_PROVIDERS[providerId];
  if (provider?.requiresApiKey && !apiKey) {
    throw new StepRefusal<ImageRefusal>(
      'missing-api-key',
      `No API key configured for image provider: ${providerId}`,
    );
  }
  // A configured slot without a model uses the provider's first catalogue
  // model. On the legacy default provider the request's model still applies
  // through its allowlist, as before slots.
  const model =
    connection.origin === 'configuration'
      ? (connection.modelId ?? provider?.models?.[0]?.id)
      : connection.origin === 'default'
        ? resolveImageModel(providerId, input.requestedModel)
        : connection.modelId;
  // Workflow-based providers (e.g. comfyui-image) have no model catalog and
  // need no model; everyone else must resolve one.
  if (!model && provider?.models && provider.models.length > 0) {
    throw new StepRefusal<ImageRefusal>(
      'missing-model',
      `No model configured for image provider: ${providerId}`,
    );
  }

  const sizedOptions = resolveImageSize(input.options, { providerId, modelId: model });

  ctx.log.info(
    `Generating image: provider=${providerId}, model=${model || 'default'}, ` +
      `prompt="${sizedOptions.prompt.slice(0, 80)}...", size=${sizedOptions.width ?? 'auto'}x${sizedOptions.height ?? 'auto'}`,
  );

  const result = await generateImage(
    withMediaProviderFetch({ providerId, apiKey: apiKey ?? '', baseUrl, model }, managed),
    sizedOptions,
  );

  void recordGenerationUsage({
    kind: 'image',
    unit: 'image',
    providerId,
    modelId: model,
    quantity: 1,
  });

  return result;
}
