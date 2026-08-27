import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';

import { generateVideo, normalizeVideoOptions, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderId,
} from '@/lib/media/types';
import {
  enabledProviderIds,
  getServerVideoProviders,
  isServerProviderDisabled,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { readResponseBodyWithLimit } from '@/lib/server/bounded-download';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { resolveMediaServingOrigin } from '@/lib/server/media-origin';
import type { CourseToolDeps } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { errorResult, MEDIA_TOOL_ERROR_REASONS } from './media-tool-result';

const log = createLogger('AgentGenerateVideo');

export const GENERATE_VIDEO_TOOL_NAME = 'generate_video';
// The longest provider poll budget is 15 minutes.
export const GENERATE_VIDEO_TIMEOUT_MS = 15 * 60_000;
export const MAX_GENERATED_VIDEO_BYTES = 200 * 1024 * 1024;

export const GenerateVideoParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  prompt: Type.String({
    minLength: 1,
    description: 'A concrete visual and motion description of the video to create.',
  }),
  aspectRatio: Type.Optional(
    Type.Union(
      [
        Type.Literal('16:9'),
        Type.Literal('4:3'),
        Type.Literal('1:1'),
        Type.Literal('9:16'),
        Type.Literal('3:4'),
        Type.Literal('21:9'),
      ],
      { description: 'Requested output aspect ratio. Provider capabilities may normalize it.' },
    ),
  ),
  durationSec: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'Requested duration in seconds. Provider capabilities may normalize it.',
    }),
  ),
  resolution: Type.Optional(
    Type.Union([Type.Literal('480p'), Type.Literal('720p'), Type.Literal('1080p')], {
      description: 'Requested output resolution. Provider capabilities may normalize it.',
    }),
  ),
});

type GenerateConfiguredVideo = (
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
) => Promise<VideoGenerationResult>;

interface PersistVideoInput {
  result: VideoGenerationResult;
  stageId: string;
  baseUrl?: string;
  signal: AbortSignal;
}

interface PersistedVideo {
  src: string;
  mime: string;
}

type PersistGeneratedVideo = (input: PersistVideoInput) => Promise<PersistedVideo>;

export interface GenerateVideoToolDeps extends Pick<
  CourseToolDeps,
  'sessionId' | 'baseUrl' | 'abortSignal'
> {
  getConfiguredVideoProviders?: () => Record<string, { models?: string[]; disabled?: boolean }>;
  resolveVideoProviderConfig?: (providerId: VideoProviderId) => VideoGenerationConfig;
  generateConfiguredVideo?: GenerateConfiguredVideo;
  persistGeneratedVideo?: PersistGeneratedVideo;
  timeoutMs?: number;
}

function extensionForVideoMime(mime: string): string {
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  return 'mp4';
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

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function fetchGeneratedVideo(url: string, signal: AbortSignal): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    throwIfAborted(signal);
    const ssrfError = await validateUrlForSSRF(currentUrl);
    throwIfAborted(signal);
    if (ssrfError) throw new Error(ssrfError);

    const response = await fetch(currentUrl, { redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Video download redirect has no Location header');
    if (hop >= maxRedirects) throw new Error('Video download exceeded 5 redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
}

/**
 * Video providers return hosted URLs that may expire. Materialize those bytes
 * through the same local classroom-media path as generate_image and classic mode.
 */
export async function defaultPersistGeneratedVideo({
  result,
  stageId,
  baseUrl,
  signal,
}: PersistVideoInput): Promise<PersistedVideo> {
  throwIfAborted(signal);
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    throw new Error('Video provider returned an invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Video provider returned an unsupported URL protocol: ${parsed.protocol}`);
  }

  const response = await fetchGeneratedVideo(result.url, signal);
  if (!response.ok) throw new Error(`Generated video download failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
  if (!mime.startsWith('video/')) {
    throw new Error(`Generated video download returned unexpected content type: ${mime}`);
  }
  const bytes = await readResponseBodyWithLimit(response, { maxBytes: MAX_GENERATED_VIDEO_BYTES });
  const hash = createHash('sha256').update(bytes).digest('hex');
  throwIfAborted(signal);

  const mediaDir = path.join(CLASSROOMS_DIR, stageId, 'media');
  const filename = `generated-${hash}.${extensionForVideoMime(mime)}`;
  await fs.mkdir(mediaDir, { recursive: true });
  throwIfAborted(signal);
  await fs.writeFile(path.join(mediaDir, filename), bytes);
  throwIfAborted(signal);
  return {
    src: `${resolveMediaServingOrigin(baseUrl)}/api/classroom-media/${stageId}/media/${filename}`,
    mime,
  };
}

/**
 * Enabled video provider ids from the listing: configured and not
 * force-disabled (#665). The gate and the selector both resolve enabledness
 * through {@link enabledProviderIds}, so an operator force-off is never
 * registered or selected.
 */
function configuredProviderIds(
  configured: Record<string, { models?: string[]; disabled?: boolean }>,
): VideoProviderId[] {
  return enabledProviderIds(configured).filter(
    (id): id is VideoProviderId => id in VIDEO_PROVIDERS,
  );
}

/** Server-side config resolution; the server `_MODELS` pin is authoritative. */
function defaultResolveVideoProviderConfig(providerId: VideoProviderId): VideoGenerationConfig {
  return {
    providerId,
    apiKey: resolveVideoApiKey(providerId),
    baseUrl: resolveVideoBaseUrl(providerId),
    model: resolveVideoModel(providerId),
  };
}

/** Capability gate used before the tool enters a session's registered toolset. */
export function hasConfiguredVideoGeneration(deps: Partial<GenerateVideoToolDeps> = {}): boolean {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  return configuredProviderIds(getConfigured()).some((providerId) => {
    const provider = VIDEO_PROVIDERS[providerId];
    const config = resolveConfig(providerId);
    return !provider.requiresApiKey || !!config.apiKey;
  });
}

export function buildGenerateVideoTool(
  deps: GenerateVideoToolDeps,
): AgentTool<typeof GenerateVideoParams, unknown> {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  const callProvider = deps.generateConfiguredVideo ?? generateVideo;
  const persist = deps.persistGeneratedVideo ?? defaultPersistGeneratedVideo;

  return {
    name: GENERATE_VIDEO_TOOL_NAME,
    label: 'Generate video',
    description:
      'Create a new video from a prompt, persist its provider-hosted result for the explicitly targeted course, and return a renderable src, mime and duration. Use the returned src in a later patch_stage set of an existing video element, or add a video element with patch_stage. Video elements also support autoplay and poster. This tool never edits a page itself.',
    parameters: GenerateVideoParams,
    async execute(toolCallId, params: Static<typeof GenerateVideoParams>, signal) {
      const callerSignal = signal ?? deps.abortSignal;
      throwIfAborted(callerSignal);

      const prompt = params.prompt.trim();
      if (!prompt) return errorResult('Video generation failed: prompt must not be empty.');
      const stageId = params.stageId;

      const configured = getConfigured();
      const providerId = configuredProviderIds(configured).find((id) => {
        const provider = VIDEO_PROVIDERS[id];
        return !provider.requiresApiKey || !!resolveConfig(id).apiKey;
      });
      if (!providerId) {
        log.warn(`[${toolCallId}] Video generation unavailable: no enabled server video provider`);
        return errorResult(
          'Video generation is unavailable: no server video provider is available.',
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
      if (isServerProviderDisabled('video', providerId)) {
        log.warn(
          `[${toolCallId}] Video generation rejected: provider ${providerId} is force-disabled`,
        );
        return errorResult('Video generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const providerConfig = resolveConfig(providerId);
      const model = providerConfig.model;
      // Same fail-loud discipline as generate_image: the server-side model
      // resolution is authoritative, and a provider that expects an explicit
      // model errors here instead of silently defaulting.
      if ((VIDEO_PROVIDERS[providerId]?.models?.length ?? 0) > 0 && !model) {
        log.warn(
          `[${toolCallId}] Video generation unavailable: no model configured for provider ${providerId}`,
        );
        return errorResult(
          'Video generation is unavailable: no model is configured for the selected video provider on this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.missingModel,
          },
        );
      }
      const normalized = normalizeVideoOptions(providerId, {
        prompt,
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.durationSec ? { duration: params.durationSec } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        stageId,
      });
      const timeoutMs = deps.timeoutMs ?? GENERATE_VIDEO_TIMEOUT_MS;
      const ioSignal = combineSignals(callerSignal, timeoutMs);

      try {
        const result = await awaitWithSignal(
          callProvider(providerConfig, { ...normalized, signal: ioSignal }),
          ioSignal,
        );
        throwIfAborted(ioSignal);
        const stored = await persist({
          result,
          stageId,
          baseUrl: deps.baseUrl,
          signal: ioSignal,
        });
        throwIfAborted(ioSignal);

        void recordGenerationUsage({
          kind: 'video',
          unit: 'second',
          providerId,
          modelId: model,
          quantity: result.duration,
        });
        log.info(
          `[${toolCallId}] Video generated: provider=${providerId}, model=${model ?? 'default'}, ${result.width}x${result.height}, ${result.duration}s`,
        );

        return {
          content: [
            {
              type: 'text',
              text: `Generated video: src=${stored.src}, mime=${stored.mime}, duration=${result.duration}s. Use this src with patch_stage set or add a video element; set autoplay and poster as needed.`,
            },
          ],
          details: {
            src: stored.src,
            mime: stored.mime,
            ...(result.duration ? { durationSec: result.duration } : {}),
          },
        };
      } catch (error) {
        if (callerSignal?.aborted) throw new Error('aborted');
        if (isTimeout(ioSignal)) {
          log.warn(
            `[${toolCallId}] Video generation timed out: provider=${providerId}, model=${model ?? 'default'}, timeoutMs=${timeoutMs}`,
          );
          return errorResult('Video generation timed out after the configured server timeout.', {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.timeout,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `[${toolCallId}] Video generation failed: provider=${providerId}, model=${model ?? 'default'}, error=${message}`,
          error,
        );
        return errorResult('Video generation failed.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
      }
    },
  };
}
