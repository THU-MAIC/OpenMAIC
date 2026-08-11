import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProbeMetrics, RepresentativeFrame } from './types.js';

interface ProbeStream {
  codec_type?: string;
  duration?: string;
  nb_frames?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

export function parseProbeOutput(
  output: ProbeOutput,
  fallbackSizeBytes: number,
  fps: number,
): ProbeMetrics {
  const video = output.streams?.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('ffprobe validation failed: output has no video stream');
  const audio = output.streams?.find((stream) => stream.codec_type === 'audio');
  const formatDuration = Number(output.format?.duration);
  const videoDuration = Number(video.duration || output.format?.duration);
  const audioDuration = audio ? Number(audio.duration || output.format?.duration) : null;
  if (!Number.isFinite(formatDuration) || !Number.isFinite(videoDuration)) {
    throw new Error('ffprobe validation failed: output duration is unavailable');
  }
  const parsedFrames = Number(video.nb_frames);
  return {
    formatDurationSeconds: formatDuration,
    videoDurationSeconds: videoDuration,
    audioDurationSeconds:
      audioDuration != null && Number.isFinite(audioDuration) ? audioDuration : null,
    avDriftSeconds:
      audioDuration != null && Number.isFinite(audioDuration)
        ? Math.abs(videoDuration - audioDuration)
        : null,
    frameCount: Number.isFinite(parsedFrames) ? parsedFrames : Math.round(videoDuration * fps),
    outputSizeBytes: Number(output.format?.size) || fallbackSizeBytes,
  };
}

export function validateProbeMetrics(
  metrics: ProbeMetrics,
  expectedDurationSeconds: number,
  fps: number,
): void {
  const durationTolerance = Math.max(0.1, 2 / fps);
  if (Math.abs(metrics.videoDurationSeconds - expectedDurationSeconds) > durationTolerance) {
    throw new Error(
      `ffprobe duration mismatch: expected ${expectedDurationSeconds}s, got ${metrics.videoDurationSeconds}s`,
    );
  }
  const expectedFrames = Math.round(expectedDurationSeconds * fps);
  if (Math.abs(metrics.frameCount - expectedFrames) > 2) {
    throw new Error(
      `ffprobe frame-count mismatch: expected ${expectedFrames}, got ${metrics.frameCount}`,
    );
  }
  if (metrics.avDriftSeconds != null && metrics.avDriftSeconds > durationTolerance) {
    throw new Error(`ffprobe A/V drift exceeded ${durationTolerance}s: ${metrics.avDriftSeconds}s`);
  }
}

export function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else
        reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

export async function probeVideo(
  ffprobePath: string,
  outputPath: string,
  fps: number,
): Promise<ProbeMetrics> {
  const output = await runCommand(ffprobePath, [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,duration,nb_frames,nb_read_frames:format=duration,size',
    '-of',
    'json',
    outputPath,
  ]);
  const parsed = JSON.parse(output) as ProbeOutput;
  const metrics = parseProbeOutput(parsed, (await stat(outputPath)).size, fps);
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const counted = Number((video as ProbeStream & { nb_read_frames?: string })?.nb_read_frames);
  if (Number.isFinite(counted)) metrics.frameCount = counted;
  return metrics;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function compareRepresentativeFrames(input: {
  ffmpegPath: string;
  videoPath: string;
  caseId: string;
  durationSeconds: number;
  fractions: number[];
  frameDir: string;
  baselineDir: string;
  establishBaseline: boolean;
}): Promise<RepresentativeFrame[]> {
  const results: RepresentativeFrame[] = [];
  for (const fraction of input.fractions) {
    const timestampSeconds = input.durationSeconds * fraction;
    const name = `${Math.round(fraction * 1000)
      .toString()
      .padStart(4, '0')}.png`;
    const framePath = join(input.frameDir, name);
    const baselinePath = join(input.baselineDir, input.caseId, name);
    await mkdir(dirname(framePath), { recursive: true });
    await runCommand(input.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      timestampSeconds.toFixed(6),
      '-i',
      input.videoPath,
      '-frames:v',
      '1',
      framePath,
    ]);
    const bytes = await readFile(framePath);
    const sha256 = hash(bytes);
    let baselineSha256: string | null = null;
    let matchesBaseline: boolean | null = null;
    if (input.establishBaseline) {
      await mkdir(dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, bytes);
    } else {
      baselineSha256 = hash(await readFile(baselinePath));
      matchesBaseline = baselineSha256 === sha256;
    }
    results.push({ fraction, timestampSeconds, sha256, baselineSha256, matchesBaseline });
  }
  return results;
}
