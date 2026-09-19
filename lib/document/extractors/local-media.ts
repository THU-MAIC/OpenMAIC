import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, extname, join, resolve as resolvePath } from 'node:path';

import { transcribeAudio, type ASRTranscriptionResult } from '@/lib/audio/asr-providers';
import type { ASRModelConfig, ASRProviderId } from '@/lib/audio/types';
import {
  resolveASRApiKey,
  resolveASRBaseUrl,
  resolveASRModel,
  resolveServerASRProviderId,
} from '@/lib/server/provider-config';

import { LOCAL_FFMPEG_MEDIA_MIMES } from '../mime';
import type {
  DocumentAsset,
  MediaArtifact,
  MediaExtractorInput,
  MediaExtractorProvider,
  MediaTranscriptSegment,
} from '../types';
import {
  isTransientExtractionError,
  MaterialExtractionError,
} from '../../server/material-extraction/errors';
import { MAX_DERIVED_IMAGES, prepareDerivedImage } from './images';
import { getMediaExtractorManifestEntry } from './manifest';

export const MEDIA_ASR_CHUNK_SEC = 600;
const MEDIA_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30_000;
const MEDIA_JOB_TIMEOUT_MS = 45 * 60 * 1000;
const MEDIA_ASR_TIMEOUT_MS = 8 * 60 * 1000;
const MEDIA_MAX_DURATION_SEC = 90 * 60;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_KEYFRAME_CANDIDATES = 50_000;
const KEYFRAME_END_SAFETY_MS = 1500;
const MEDIA_MIME_SET = new Set<string>(LOCAL_FFMPEG_MEDIA_MIMES);
const asrFetchSignal = new AsyncLocalStorage<AbortSignal>();
let abortableFetchInstalled = false;

export type MediaExtractionStage = 'probing' | 'audio' | 'asr' | 'keyframes';

export interface MediaExtractionProgress {
  stage: MediaExtractionStage;
  current?: number;
  total?: number;
}

export interface MediaCommandResult {
  stdout: string;
  stderr: string;
}

export interface MediaCommandRunner {
  resolve(name: 'ffmpeg' | 'ffprobe'): Promise<string>;
  run(file: string, args: string[], timeoutMs: number): Promise<MediaCommandResult>;
}

export interface LocalMediaExtractorDependencies {
  commands?: MediaCommandRunner;
  transcribe?: (config: ASRModelConfig, audio: Buffer) => Promise<ASRTranscriptionResult>;
  resolveASRConfig?: () => ASRModelConfig;
  jobTimeoutMs?: number;
}

interface KeyframeMaterial {
  asset: DocumentAsset;
  timeMs: number;
}

export { MaterialExtractionError as LocalMediaExtractionError };
export const isTransientMediaExtractionError = isTransientExtractionError;

export interface MediaProbe {
  durationSec: number;
  hasAudioStream: boolean;
  videoDurationSec?: number;
}

class MediaJobDeadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  check(): void {
    if (this.remainingMs() <= 0) {
      throw new MaterialExtractionError('media extraction job deadline exceeded', true);
    }
  }

  commandTimeoutMs(maximum: number): number {
    this.check();
    return Math.max(1, Math.min(maximum, this.remainingMs()));
  }

  beforeAwait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return operation();
  }
}

function installAbortableFetch(): void {
  if (abortableFetchInstalled) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const contextSignal = asrFetchSignal.getStore();
    if (!contextSignal) return originalFetch(input, init);
    const signal = init?.signal ? AbortSignal.any([init.signal, contextSignal]) : contextSignal;
    return originalFetch(input, { ...init, signal });
  }) as typeof globalThis.fetch;
  abortableFetchInstalled = true;
}

async function runASRWithTimeout<T>(run: () => Promise<T>, deadline: MediaJobDeadline): Promise<T> {
  deadline.check();
  installAbortableFetch();
  const jobRemainingMs = deadline.remainingMs();
  const perChunkMs = MEDIA_ASR_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(jobRemainingMs, perChunkMs));
  const jobDeadlineWins = jobRemainingMs <= perChunkMs;
  const controller = new AbortController();
  const timeoutError = new MaterialExtractionError(
    jobDeadlineWins ? 'media extraction job deadline exceeded' : 'ASR chunk timed out',
    true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([asrFetchSignal.run(controller.signal, run), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runMediaCommand(
  commands: MediaCommandRunner,
  file: string,
  args: string[],
  maximumTimeoutMs: number,
  deadline: MediaJobDeadline,
): Promise<MediaCommandResult> {
  const timeoutMs = deadline.commandTimeoutMs(maximumTimeoutMs);
  const jobLimited = timeoutMs < maximumTimeoutMs;
  try {
    const result = await commands.run(file, args, timeoutMs);
    deadline.check();
    return result;
  } catch (error) {
    if (deadline.remainingMs() <= 0) deadline.check();
    const commandError = error as NodeJS.ErrnoException & { killed?: boolean };
    if (jobLimited && (commandError.code === 'ETIMEDOUT' || commandError.killed)) {
      throw new MaterialExtractionError('media extraction job deadline exceeded', true, {
        cause: error,
      });
    }
    throw error;
  }
}

export function isSupportedMediaMime(mime: string): boolean {
  return MEDIA_MIME_SET.has(mime.toLowerCase());
}

async function resolveExecutable(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const candidates = new Set<string>();
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory) candidates.add(resolvePath(directory, name));
  }
  for (const directory of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']) {
    candidates.add(join(directory, name));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking; the final error is explicit and permanent.
    }
  }
  throw new MaterialExtractionError(
    `${name} is unavailable; install ffmpeg (including ffprobe) to extract media materials`,
    false,
  );
}

export const defaultMediaCommands: MediaCommandRunner = {
  resolve: resolveExecutable,
  run(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message)
              .trim()
              .slice(-4000);
            const wrapped = new Error(`${basename(file)} failed: ${detail || error.message}`, {
              cause: error,
            }) as Error & { code?: string };
            wrapped.code = (error as NodeJS.ErrnoException).code;
            reject(wrapped);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  },
};

export function parseMediaProbe(stdout: string): MediaProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new MaterialExtractionError('ffprobe returned malformed duration metadata', false, {
      cause: error,
    });
  }
  const probe = parsed as {
    format?: { duration?: unknown };
    streams?: Array<{ codec_type?: unknown; duration?: unknown }>;
  };
  const value = probe?.format?.duration;
  const duration = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MaterialExtractionError(
      'ffprobe could not determine a positive media duration',
      false,
    );
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === 'video');
  const rawVideoDuration = videoStream?.duration;
  const parsedVideoDuration =
    typeof rawVideoDuration === 'number' ? rawVideoDuration : Number(rawVideoDuration);
  const videoDurationSec = videoStream
    ? Number.isFinite(parsedVideoDuration) && parsedVideoDuration > 0
      ? parsedVideoDuration
      : Math.max(0, duration - KEYFRAME_END_SAFETY_MS / 1000)
    : undefined;
  return {
    durationSec: duration,
    hasAudioStream: streams.some((stream) => stream?.codec_type === 'audio'),
    ...(videoDurationSec !== undefined ? { videoDurationSec } : {}),
  };
}

export function parseMediaDuration(stdout: string): number {
  return parseMediaProbe(stdout).durationSec;
}

export interface MediaChunkWindow {
  index: number;
  startMs: number;
  endMs: number;
}

export function mediaChunkWindows(durationSec: number): MediaChunkWindow[] {
  const count = Math.max(1, Math.ceil(durationSec / MEDIA_ASR_CHUNK_SEC));
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: index * MEDIA_ASR_CHUNK_SEC * 1000,
    endMs: Math.min(durationSec * 1000, (index + 1) * MEDIA_ASR_CHUNK_SEC * 1000),
  }));
}

export function maxMediaChunkCheckpoints(): number {
  return Math.max(1, Math.ceil(MEDIA_MAX_DURATION_SEC / MEDIA_ASR_CHUNK_SEC));
}

export function uniformKeyframeTimes(
  sceneTimesMs: readonly number[],
  videoDurationSec: number,
): number[] {
  const durationMs = Math.max(0, Math.round(videoDurationSec * 1000));
  const lastSafeTimeMs = durationMs - KEYFRAME_END_SAFETY_MS;
  if (lastSafeTimeMs < 0) return [];
  const scenes = new Set<number>();
  for (const raw of sceneTimesMs.slice(0, MAX_KEYFRAME_CANDIDATES)) {
    if (!Number.isFinite(raw)) continue;
    const rounded = Math.round(raw);
    if (rounded < 0 || rounded > lastSafeTimeMs) continue;
    scenes.add(Math.min(rounded, lastSafeTimeMs));
  }
  const candidates = new Set<number>(scenes);
  for (let timeMs = 0; timeMs <= lastSafeTimeMs; timeMs += 60_000) candidates.add(timeMs);
  candidates.add(lastSafeTimeMs);
  const ordered = [...candidates].sort((a, b) => a - b);
  if (ordered.length <= MAX_DERIVED_IMAGES) return ordered;

  // Once the cap is reached, the timeline—not candidate density—is the
  // authority. A burst of scene changes in one chapter must not consume most
  // of the 100-frame budget. Prefer the scene nearest each bucket's centre;
  // an empty bucket receives its centre grid anchor.
  const orderedScenes = [...scenes].sort((a, b) => a - b);
  let sceneIndex = 0;
  return Array.from({ length: MAX_DERIVED_IMAGES }, (_, bucket) => {
    const samplingSpanMs = lastSafeTimeMs + 1;
    const start = Math.floor((bucket * samplingSpanMs) / MAX_DERIVED_IMAGES);
    const end = Math.max(
      start + 1,
      Math.floor(((bucket + 1) * samplingSpanMs) / MAX_DERIVED_IMAGES),
    );
    const anchor = Math.min(lastSafeTimeMs, Math.floor((start + end - 1) / 2));
    while (sceneIndex < orderedScenes.length && orderedScenes[sceneIndex] < start) sceneIndex += 1;
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (
      let index = sceneIndex;
      index < orderedScenes.length && orderedScenes[index] < end;
      index += 1
    ) {
      const distance = Math.abs(orderedScenes[index] - anchor);
      if (distance < bestDistance) {
        best = orderedScenes[index];
        bestDistance = distance;
      }
    }
    return best >= 0 ? best : anchor;
  });
}

function formatMarkerTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Render a readable transcript while proving every inline image id belongs to this derivation. */
export function renderTranscriptView(
  segments: readonly MediaTranscriptSegment[],
  keyframes: readonly { materialId: string; timeMs: number }[],
  allowedMaterialIds: ReadonlySet<string>,
): string {
  for (const frame of keyframes) {
    if (!allowedMaterialIds.has(frame.materialId)) {
      throw new MaterialExtractionError(
        `cross-reference ${frame.materialId} is outside this material's derived domain`,
        false,
      );
    }
  }
  const orderedSegments = [...segments].sort((a, b) => a.startMs - b.startMs);
  const orderedFrames = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  const lines: string[] = [];
  let frameIndex = 0;
  for (const segment of orderedSegments) {
    while (
      frameIndex < orderedFrames.length &&
      orderedFrames[frameIndex].timeMs < segment.startMs
    ) {
      const frame = orderedFrames[frameIndex++];
      lines.push(`[keyframe@${formatMarkerTime(frame.timeMs)}](${frame.materialId})`);
    }
    lines.push(
      `[${formatMarkerTime(segment.startMs)}-${formatMarkerTime(segment.endMs)}] ${segment.text}`,
    );
    while (frameIndex < orderedFrames.length && orderedFrames[frameIndex].timeMs <= segment.endMs) {
      const frame = orderedFrames[frameIndex++];
      lines.push(`[keyframe@${formatMarkerTime(frame.timeMs)}](${frame.materialId})`);
    }
  }
  while (frameIndex < orderedFrames.length) {
    const frame = orderedFrames[frameIndex++];
    lines.push(`[keyframe@${formatMarkerTime(frame.timeMs)}](${frame.materialId})`);
  }
  return lines.join('\n\n');
}

function sourceExtension(mime: string): string {
  const extensions: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/webm': '.webm',
  };
  return extensions[mime] ?? '.media';
}

function derivedStem(originalName: string | null, fallback: string): string {
  if (!originalName) return fallback;
  const name = basename(originalName);
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

function configuredASR(): ASRModelConfig {
  const providerId = resolveServerASRProviderId();
  if (!providerId) {
    throw new MaterialExtractionError(
      'No server ASR provider is configured for local media extraction',
      false,
    );
  }
  return {
    providerId: providerId as ASRProviderId,
    modelId: resolveASRModel(providerId),
    apiKey: resolveASRApiKey(providerId) || undefined,
    baseUrl: resolveASRBaseUrl(providerId),
    language: 'auto',
  };
}

function frameTimes(stderr: string): number[] {
  return [...stderr.matchAll(/showinfo[^\n]*pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)].map((match) =>
    Math.round(Number(match[1]) * 1000),
  );
}

async function readRequiredIntermediate(
  path: string,
  description: string,
  deadline: MediaJobDeadline,
): Promise<Buffer> {
  try {
    return await deadline.beforeAwait(() => readFile(path));
  } catch (error) {
    if (error instanceof MaterialExtractionError) throw error;
    throw new MaterialExtractionError(
      `${description} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      false,
      { cause: error },
    );
  }
}

function incrementDiagnostic(diagnostics: Map<string, number>, reason: string): void {
  diagnostics.set(reason, (diagnostics.get(reason) ?? 0) + 1);
}

function aggregatedDiagnostics(diagnostics: ReadonlyMap<string, number>): string[] {
  return [...diagnostics].map(([reason, count]) => (count > 1 ? `${reason} (${count})` : reason));
}

async function probeMedia(
  commands: MediaCommandRunner,
  ffprobe: string,
  sourcePath: string,
  deadline: MediaJobDeadline,
): Promise<MediaProbe> {
  try {
    const result = await runMediaCommand(
      commands,
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,duration',
        '-of',
        'json',
        sourcePath,
      ],
      FFPROBE_TIMEOUT_MS,
      deadline,
    );
    return parseMediaProbe(result.stdout);
  } catch (error) {
    if (error instanceof MaterialExtractionError) throw error;
    throw new MaterialExtractionError(
      `ffprobe could not inspect this media file: ${error instanceof Error ? error.message : String(error)}`,
      false,
      { cause: error },
    );
  }
}

async function transcribeChunks(
  chunkPaths: string[],
  windows: MediaChunkWindow[],
  config: ASRModelConfig,
  transcribe: (config: ASRModelConfig, audio: Buffer) => Promise<ASRTranscriptionResult>,
  deadline: MediaJobDeadline,
  onProgress?: (progress: MediaExtractionProgress) => void | Promise<void>,
): Promise<MediaTranscriptSegment[]> {
  const segments: MediaTranscriptSegment[] = [];
  for (const [index, chunkPath] of chunkPaths.entries()) {
    try {
      deadline.check();
      await deadline.beforeAwait(async () =>
        onProgress?.({ stage: 'asr', current: index + 1, total: chunkPaths.length }),
      );
      const chunk = await readRequiredIntermediate(
        chunkPath,
        `ASR chunk ${index + 1}/${chunkPaths.length}`,
        deadline,
      );
      const result = await runASRWithTimeout(() => transcribe(config, chunk), deadline);
      const text = result.text.trim();
      if (text) {
        segments.push({
          id: `segment-${String(index + 1).padStart(3, '0')}`,
          startMs: windows[index].startMs,
          endMs: windows[index].endMs,
          text,
          metadata: { chunk: index + 1 },
        });
      }
    } catch (error) {
      throw new MaterialExtractionError(
        `ASR chunk ${index + 1}/${chunkPaths.length} failed: ${error instanceof Error ? error.message : String(error)}`,
        isTransientExtractionError(error),
        { cause: error },
      );
    } finally {
      await rm(chunkPath, { force: true }).catch(() => undefined);
    }
  }
  return segments;
}

/** Execute the ffmpeg + ASR light pipeline for one media source. */
export async function extractMediaMaterial(
  input: MediaExtractorInput,
  dependencies: LocalMediaExtractorDependencies = {},
): Promise<MediaArtifact> {
  if (!isSupportedMediaMime(input.mimeType)) {
    throw new MaterialExtractionError(`Unsupported media MIME type: ${input.mimeType}`, false);
  }
  const startedAt = Date.now();
  const deadline = new MediaJobDeadline(dependencies.jobTimeoutMs ?? MEDIA_JOB_TIMEOUT_MS);
  const commands = dependencies.commands ?? defaultMediaCommands;
  const transcribe = dependencies.transcribe ?? transcribeAudio;
  const sessionDir = await deadline.beforeAwait(() => mkdtemp(join(tmpdir(), 'openmaic-media-')));
  const sourcePath = join(sessionDir, `source${sourceExtension(input.mimeType)}`);
  try {
    await deadline.beforeAwait(() => writeFile(sourcePath, input.buffer));
    const [ffprobe, ffmpeg] = await deadline.beforeAwait(() =>
      Promise.all([commands.resolve('ffprobe'), commands.resolve('ffmpeg')]),
    );
    const probe = await probeMedia(commands, ffprobe, sourcePath, deadline);
    const { durationSec } = probe;
    if (durationSec > MEDIA_MAX_DURATION_SEC) {
      throw new MaterialExtractionError(
        `Media duration ${Math.ceil(durationSec)} seconds exceeds the ${MEDIA_MAX_DURATION_SEC}-second limit; trim it before uploading`,
        false,
      );
    }

    const isVideo = input.mimeType.startsWith('video/');
    const stem = derivedStem(input.fileName ?? null, 'media');
    let segments: MediaTranscriptSegment[];
    let asrChunks = 0;
    let transcriptDurationSec = durationSec;

    if (isVideo && !probe.hasAudioStream) {
      segments = [
        {
          id: 'segment-001',
          startMs: 0,
          endMs: Math.round(durationSec * 1000),
          text: 'No audio track',
          metadata: { noAudioTrack: true },
        },
      ];
    } else {
      if (!probe.hasAudioStream) {
        throw new MaterialExtractionError(
          'ffprobe found no audio stream in this audio material',
          false,
        );
      }
      let audioInputPath: string;
      if (isVideo) {
        audioInputPath = join(sessionDir, 'audio-track.wav');
        await runMediaCommand(
          commands,
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            sourcePath,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            audioInputPath,
          ],
          MEDIA_COMMAND_TIMEOUT_MS,
          deadline,
        );
        transcriptDurationSec = (await probeMedia(commands, ffprobe, audioInputPath, deadline))
          .durationSec;
      } else {
        // Audio uploads already are the reference track; preserve their exact bytes and codec lineage.
        audioInputPath = sourcePath;
      }

      const chunkPattern = join(sessionDir, 'chunk-%03d.wav');
      try {
        await runMediaCommand(
          commands,
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            audioInputPath,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            '-f',
            'segment',
            '-segment_time',
            String(MEDIA_ASR_CHUNK_SEC),
            '-reset_timestamps',
            '1',
            chunkPattern,
          ],
          MEDIA_COMMAND_TIMEOUT_MS,
          deadline,
        );
      } finally {
        if (isVideo) await rm(audioInputPath, { force: true }).catch(() => undefined);
      }
      const chunkPaths = (await deadline.beforeAwait(() => readdir(sessionDir)))
        .filter((name) => /^chunk-\d{3}\.wav$/.test(name))
        .sort()
        .map((name) => join(sessionDir, name));
      if (chunkPaths.length === 0) {
        throw new MaterialExtractionError('ffmpeg produced no ASR audio chunks', false);
      }
      const windows = mediaChunkWindows(transcriptDurationSec);
      if (chunkPaths.length !== windows.length) {
        throw new MaterialExtractionError(
          `ffmpeg produced ${chunkPaths.length} ASR chunks; expected ${windows.length} for ${transcriptDurationSec} seconds`,
          false,
        );
      }
      asrChunks = chunkPaths.length;
      const asr = dependencies.resolveASRConfig?.() ?? configuredASR();
      segments = await deadline.beforeAwait(() =>
        transcribeChunks(chunkPaths, windows, asr, transcribe, deadline),
      );
    }

    const keyframes: KeyframeMaterial[] = [];
    let imagesSkipped = 0;
    const keyframeDiagnostics = new Map<string, number>();
    if (isVideo) {
      let detectedSceneTimes: number[] = [];
      try {
        const sceneResult = await runMediaCommand(
          commands,
          ffmpeg,
          [
            '-hide_banner',
            '-i',
            sourcePath,
            '-vf',
            'select=gt(scene\\,0.3),showinfo',
            '-an',
            '-f',
            'null',
            '-',
          ],
          MEDIA_COMMAND_TIMEOUT_MS,
          deadline,
        );
        detectedSceneTimes = frameTimes(sceneResult.stderr);
      } catch {
        incrementDiagnostic(
          keyframeDiagnostics,
          'keyframe scene detection failed; used uniform sampling',
        );
      }
      const selectedTimes = uniformKeyframeTimes(
        detectedSceneTimes,
        probe.videoDurationSec ?? Math.max(0, durationSec - KEYFRAME_END_SAFETY_MS / 1000),
      );
      for (const [index, timeMs] of selectedTimes.entries()) {
        const framePath = join(sessionDir, `frame-${String(index + 1).padStart(3, '0')}.png`);
        let stage: 'ffmpeg' | 'read' | 'prepare' | 'store' = 'ffmpeg';
        try {
          deadline.check();
          await runMediaCommand(
            commands,
            ffmpeg,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-ss',
              (timeMs / 1000).toFixed(3),
              '-i',
              sourcePath,
              '-frames:v',
              '1',
              '-vf',
              'scale=1280:1280:force_original_aspect_ratio=decrease',
              framePath,
            ],
            MEDIA_COMMAND_TIMEOUT_MS,
            deadline,
          );
          stage = 'read';
          const frameBytes = await deadline.beforeAwait(() => readFile(framePath));
          stage = 'prepare';
          const prepared = await deadline.beforeAwait(() => prepareDerivedImage(frameBytes));
          if (!prepared) {
            imagesSkipped += 1;
            incrementDiagnostic(
              keyframeDiagnostics,
              'keyframe image preparation returned no image',
            );
            continue;
          }
          stage = 'store';
          const assetId = `keyframe-${String(index + 1).padStart(3, '0')}`;
          const asset: DocumentAsset = {
            id: assetId,
            type: 'image',
            mimeType: prepared.mime,
            data: prepared.buffer.toString('base64'),
            width: prepared.width,
            height: prepared.height,
            description: `${stem} at ${(timeMs / 1000).toFixed(3)} seconds`,
            metadata: { timeMs },
          };
          keyframes.push({ asset, timeMs });
        } catch (error) {
          imagesSkipped += 1;
          const code = (error as NodeJS.ErrnoException | null)?.code;
          incrementDiagnostic(
            keyframeDiagnostics,
            code === 'ENOENT'
              ? `keyframe ${stage} failed: output missing (ENOENT)`
              : `keyframe ${stage} failed`,
          );
        } finally {
          await rm(framePath, { force: true }).catch(() => undefined);
        }
      }
    }

    const allowedImageIds = new Set(keyframes.map((frame) => frame.asset.id));
    const transcriptText = renderTranscriptView(
      segments,
      keyframes.map((frame) => ({ materialId: frame.asset.id, timeMs: frame.timeMs })),
      allowedImageIds,
    );
    return {
      metadata: {
        fileName: input.fileName,
        fileSize: input.fileSize ?? input.buffer.byteLength,
        mimeType: input.mimeType,
        durationMs: Math.round(transcriptDurationSec * 1000),
        providerId: 'local-ffmpeg',
        processingTime: Date.now() - startedAt,
      },
      transcript: segments,
      keyframes: keyframes.map((frame) => ({
        id: frame.asset.id,
        assetId: frame.asset.id,
        timeMs: frame.timeMs,
      })),
      assets: keyframes.map((frame) => frame.asset),
      diagnostics: [
        ...aggregatedDiagnostics(keyframeDiagnostics),
        ...(imagesSkipped > 0 ? [`${imagesSkipped} keyframe images were skipped`] : []),
      ].map((message) => ({
        severity: 'warning' as const,
        message,
        providerId: 'local-ffmpeg',
      })),
      providerRaw: { transcriptText, durationSec, asrChunks },
    };
  } finally {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createLocalMediaExtractorProvider(
  dependencies: LocalMediaExtractorDependencies = {},
): MediaExtractorProvider {
  const entry = getMediaExtractorManifestEntry('local-ffmpeg');
  if (!entry) throw new Error('No media extractor manifest entry for provider "local-ffmpeg"');
  const commands = dependencies.commands ?? defaultMediaCommands;
  return {
    ...entry,
    supportedMimeTypes: entry.supportedMimeTypes.filter(isSupportedMediaMime),
    async availability() {
      try {
        await Promise.all([commands.resolve('ffmpeg'), commands.resolve('ffprobe')]);
        return { available: true };
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    extract(input) {
      return extractMediaMaterial(input, { ...dependencies, commands });
    },
  };
}

export const localMediaExtractorProvider = createLocalMediaExtractorProvider();
