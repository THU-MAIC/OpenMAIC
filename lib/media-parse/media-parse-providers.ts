/**
 * Media Parse Provider Implementation
 *
 * Factory pattern for routing audio/video parsing requests to appropriate
 * provider implementations. Follows the same architecture as lib/pdf/pdf-providers.ts.
 *
 * Currently Supported Providers:
 * - AliDocMind (Aliyun Document Mind LLM version)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to MediaParseProviderId in ./types.ts
 * 2. Add provider metadata to MEDIA_PARSE_PROVIDERS in ./constants.ts
 * 3. Implement parseWithXxx() function in this file
 * 4. Add case to parseMedia() switch statement
 */

import { parseWithAliDocMindClient } from '@/lib/pdf/alidocmind-client';
import type { MediaArtifact, MediaKeyframe, MediaTranscriptSegment } from '@/lib/document';
import type { MediaParseInput, MediaParseResult } from './types';
import { MEDIA_PARSE_PROVIDERS } from './constants';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaParseProviders');

/**
 * Parse media (audio/video) using specified provider.
 */
export async function parseMedia(input: MediaParseInput): Promise<MediaParseResult> {
  const provider = MEDIA_PARSE_PROVIDERS[input.config.providerId];
  if (!provider) {
    throw new Error(`Unknown media parse provider: ${input.config.providerId}`);
  }
  const startTime = Date.now();

  let artifact: MediaArtifact;
  switch (input.config.providerId) {
    case 'alidocmind':
      artifact = await parseWithAliDocMind(input);
      break;
    default: {
      const exhaustive: never = input.config.providerId;
      throw new Error(`Unsupported media parse provider: ${exhaustive}`);
    }
  }

  if (artifact.metadata) {
    artifact.metadata.processingTime = Date.now() - startTime;
  }
  return artifact;
}

async function parseWithAliDocMind(input: MediaParseInput): Promise<MediaArtifact> {
  log.info(`AliDocMind parsing media: ${input.fileName} (${input.buffer.byteLength} bytes)`);
  const result = await parseWithAliDocMindClient(
    {
      accessKeyId: input.config.accessKeyId,
      accessKeySecret: input.config.accessKeySecret,
      endpoint: input.config.baseUrl,
      allowEnvFallback: input.config.allowEnvFallback,
    },
    {
      buffer: input.buffer,
      fileName: input.fileName,
      option: 'advance',
      multimediaParameters: { enableSynopsisParse: true },
    },
  );

  return aliDocMindSegmentsToMediaArtifact(result, input);
}

/**
 * Map AliDocMind segments[] shape → MediaArtifact.
 *
 * Segment schema (per AliDocMind docs):
 *   { index, start_time, end_time, file_url,
 *     audio_frames: [{ start_time, end_time, file_url, ASR_info }],
 *     video_frames: [{ start_time, end_time, file_url, text_info }] }
 * Top-level: synopsis_result (when option=advance)
 */
function aliDocMindSegmentsToMediaArtifact(
  result: { data: Record<string, unknown>; jobId?: string },
  input: MediaParseInput,
): MediaArtifact {
  const segments = (Array.isArray(result.data.segments) ? result.data.segments : []) as Array<{
    index?: number;
    start_time?: number;
    end_time?: number;
    audio_frames?: Array<{
      start_time?: number;
      end_time?: number;
      ASR_info?: string;
    }>;
    video_frames?: Array<{
      start_time?: number;
      end_time?: number;
      file_url?: string;
      text_info?: string;
    }>;
  }>;

  const transcript: MediaTranscriptSegment[] = [];
  const keyframes: MediaKeyframe[] = [];
  let maxTimeMs = 0;

  segments.forEach((seg, i) => {
    (seg.audio_frames ?? []).forEach((af, j) => {
      const start = af.start_time ?? seg.start_time ?? 0;
      const end = af.end_time ?? seg.end_time ?? start;
      maxTimeMs = Math.max(maxTimeMs, end);
      transcript.push({
        id: `seg_${i}_audio_${j}`,
        startMs: start,
        endMs: end,
        text: af.ASR_info ?? '',
      });
    });
    (seg.video_frames ?? []).forEach((vf, j) => {
      const timeMs = vf.start_time ?? seg.start_time ?? 0;
      maxTimeMs = Math.max(maxTimeMs, vf.end_time ?? timeMs);
      keyframes.push({
        id: `seg_${i}_frame_${j}`,
        timeMs,
        ocrText: vf.text_info,
        description: vf.text_info,
        metadata: vf.file_url ? { fileUrl: vf.file_url } : undefined,
      });
    });
  });

  const synopsis =
    typeof result.data.synopsis_result === 'string'
      ? (result.data.synopsis_result as string)
      : undefined;

  return {
    metadata: {
      fileName: input.fileName,
      fileSize: input.buffer.byteLength,
      mimeType: input.mimeType,
      durationMs: maxTimeMs || undefined,
      providerId: 'alidocmind',
    },
    transcript: transcript.length ? transcript : undefined,
    keyframes: keyframes.length ? keyframes : undefined,
    providerRaw: synopsis ? { synopsis, jobId: result.jobId } : { jobId: result.jobId },
  };
}

export { getAllMediaParseProviders, getMediaParseProvider } from './constants';
