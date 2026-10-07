/**
 * Video: generate one video from a prompt through the video slot's provider,
 * submitting the provider task and waiting for it. A caller that must survive
 * a restart learns the task before the wait (`onProviderTask`) and resumes the
 * wait on it later (`resume`), on the same connection only. Moved from POST /api/generate/video,
 * which keeps resolving the slot (with the request's deprecated provider
 * headers) and mapping failures to its responses.
 */
import {
  generateVideo,
  normalizeVideoOptions,
  VIDEO_PROVIDERS,
  videoTaskEndpoint,
} from '@/lib/media/video-providers';
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

/**
 * A submitted provider task and the connection it was submitted on: a task id
 * means something only to that provider, model (one provider's models may use
 * different task APIs) and endpoint.
 */
export interface VideoProviderTask {
  taskId: string;
  providerId: string;
  model: string;
  /** The effective endpoint (videoTaskEndpoint), not the configured base URL. */
  endpoint: string;
}

export interface VideoInput {
  options: VideoGenerationOptions;
  /** The video slot's connection. */
  connection: MediaConnection;
  /**
   * The model a deprecated request names; it still applies, through the
   * provider's allowlist, on the legacy default provider.
   */
  requestedModel?: string;
  /** Told the provider task once it is submitted, before the step waits on it. */
  onProviderTask?: (task: VideoProviderTask) => void | Promise<void>;
  /**
   * Wait on this provider task, submitted earlier, instead of submitting a new
   * one. Refused when the slot no longer resolves to the connection it was
   * submitted on.
   */
  resume?: VideoProviderTask;
}

export type VideoRefusal =
  | 'missing-api-key'
  | 'missing-model'
  /** The task to resume was submitted on another provider, model or endpoint. */
  | 'task-connection-changed';

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

  const { resume, onProviderTask } = input;
  const endpoint = videoTaskEndpoint(providerId, baseUrl);
  if (
    resume &&
    (resume.providerId !== providerId || resume.model !== model || resume.endpoint !== endpoint)
  ) {
    throw new StepRefusal<VideoRefusal>(
      'task-connection-changed',
      `The video task ${resume.taskId} was submitted to ${resume.providerId} (${resume.model}), which is no longer the video slot's connection`,
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
    onProviderTask || resume
      ? await generateVideo(config, options, {
          onSubmitted: onProviderTask
            ? (taskId) => onProviderTask({ taskId, providerId, model, endpoint })
            : undefined,
          resumeTaskId: resume?.taskId,
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
