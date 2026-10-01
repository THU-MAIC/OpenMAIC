/**
 * Video: generate one video from a prompt through the video slot's provider,
 * submitting the provider task and waiting for it. A caller that must survive
 * a restart learns the task id before the wait (`onProviderTask`) and resumes
 * the wait on it later (`resumeTaskId`). Moved from POST /api/generate/video,
 * which keeps resolving the slot (with the request's deprecated provider
 * headers) and mapping failures to its responses.
 */
import { generateVideo, normalizeVideoOptions, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type {
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderId,
} from '@/lib/media/types';
import { resolveVideoModel } from '@/lib/server/provider-config';
import type { MediaConnection } from '@/lib/server/model-config/media';
import { withVideoProviderFetch } from '@/lib/server/media-provider-fetch';
import { recordGenerationUsage } from '@/lib/server/usage-storage';

import { StepRefusal, type StepContext } from './context';

export interface VideoInput {
  options: VideoGenerationOptions;
  /** The video slot's connection. */
  connection: MediaConnection;
  /**
   * The model a deprecated request names; it still applies, through the
   * provider's allowlist, on the legacy default provider.
   */
  requestedModel?: string;
  /** Told the provider's task id once it is submitted, before the step waits on it. */
  onProviderTask?: (taskId: string) => void | Promise<void>;
  /** Wait on this provider task, submitted earlier, instead of submitting a new one. */
  resumeTaskId?: string;
}

export type VideoRefusal = 'missing-api-key' | 'missing-model';

export async function generateVideoStep(
  input: VideoInput,
  ctx: StepContext,
): Promise<VideoGenerationResult> {
  const { connection } = input;
  const providerId = connection.providerId as VideoProviderId;
  const { apiKey, baseUrl, managed } = connection;
  if (!apiKey) {
    throw new StepRefusal<VideoRefusal>(
      'missing-api-key',
      `No API key configured for video provider: ${providerId}`,
    );
  }
  // A configured slot without a model uses the provider's first catalogue
  // model. On the legacy default provider the request's model still applies
  // through its allowlist, as before slots.
  const model =
    connection.origin === 'configuration'
      ? (connection.modelId ?? VIDEO_PROVIDERS[providerId]?.models?.[0]?.id)
      : connection.origin === 'default'
        ? resolveVideoModel(providerId, input.requestedModel)
        : connection.modelId;
  if (!model) {
    throw new StepRefusal<VideoRefusal>(
      'missing-model',
      `No model configured for video provider: ${providerId}`,
    );
  }

  // Normalize options against provider capabilities
  const options = normalizeVideoOptions(providerId, input.options);

  ctx.log.info(
    `Generating video: provider=${providerId}, model=${model || 'default'}, ` +
      `prompt="${input.options.prompt.slice(0, 80)}...", duration=${options.duration ?? 'auto'}, ` +
      `aspect=${options.aspectRatio ?? 'auto'}, resolution=${options.resolution ?? 'auto'}`,
  );

  const config = withVideoProviderFetch({ providerId, apiKey, baseUrl, model }, managed);
  const result =
    input.onProviderTask || input.resumeTaskId
      ? await generateVideo(config, options, {
          onSubmitted: input.onProviderTask,
          resumeTaskId: input.resumeTaskId,
        })
      : await generateVideo(config, options);

  ctx.log.info(
    `Video generated: url=${result.url ? 'yes' : 'no'}, ${result.width}x${result.height}, ${result.duration}s`,
  );

  void recordGenerationUsage({
    kind: 'video',
    unit: 'second',
    providerId,
    modelId: model,
    quantity: result.duration,
  });

  return result;
}
