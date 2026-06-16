import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';
export const maxDuration = 300;

const execFileAsync = promisify(execFile);

interface VideoCourseManifest {
  fileName?: string;
  width?: number;
  height?: number;
  fps?: number;
  scenes: VideoCourseScene[];
}

interface VideoCourseScene {
  title?: string;
  imageField: string;
  fallbackMs?: number;
  tracks?: VideoCourseTrack[];
}

type VideoCourseTrack =
  | {
      type: 'file';
      field: string;
      durationMs?: number;
      mimeType?: string;
      required?: boolean;
    }
  | {
      type: 'url';
      url: string;
      durationMs?: number;
      mimeType?: string;
      required?: boolean;
    }
  | {
      type: 'silence';
      durationMs: number;
    };

interface PreparedTrack {
  path?: string;
  durationMs: number;
  type: 'file' | 'silence';
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const DEFAULT_SCENE_MS = 2500;
const MIN_SCENE_MS = 1000;

function asFile(value: FormDataEntryValue | null): File | null {
  return value instanceof File ? value : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function extFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback;
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  return fallback;
}

function extFromUrl(url: URL, fallback: string): string {
  const ext = path.extname(url.pathname).toLowerCase().replace(/^\./, '');
  return ext || fallback;
}

function quoteConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function resolveSafeAudioUrl(rawUrl: string, request: NextRequest): URL | null {
  try {
    const parsed = new URL(rawUrl, request.url);
    if (!parsed.pathname.startsWith('/api/classroom-media/')) return null;
    if (!parsed.pathname.includes('/audio/')) return null;

    // Only trust the path. Server-generated classrooms may preserve the
    // origin used at generation time, while the user later opens the app from
    // localhost/127.0.0.1 or another forwarded host. Rebase to this request's
    // origin so we still read from our own media route, never from an external
    // host supplied by the client.
    return new URL(`${parsed.pathname}${parsed.search}`, request.url);
  } catch {
    return null;
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  const binary = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    await execFileAsync(binary, ['-hide_banner', '-loglevel', 'error', ...args], {
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ffmpeg failed: ${message}`);
  }
}

async function probeDurationMs(filePath: string, fallbackMs?: number): Promise<number> {
  const binary = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  } catch {
    // Keep export moving when ffprobe cannot read a file; the caller's
    // duration estimate is still good enough for a still-image segment.
  }
  return Math.max(MIN_SCENE_MS, fallbackMs ?? DEFAULT_SCENE_MS);
}

async function writeUploadedFile(file: File, targetPath: string): Promise<void> {
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(targetPath, bytes);
}

async function writeFetchedAudio(url: URL, targetPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);
}

async function prepareTrack(
  track: VideoCourseTrack,
  formData: FormData,
  workDir: string,
  sceneIndex: number,
  trackIndex: number,
  request: NextRequest,
): Promise<PreparedTrack> {
  if (track.type === 'silence') {
    return {
      type: 'silence',
      durationMs: Math.max(MIN_SCENE_MS, Math.round(track.durationMs || DEFAULT_SCENE_MS)),
    };
  }

  if (track.type === 'url') {
    const url = resolveSafeAudioUrl(track.url, request);
    if (!url) {
      if (track.required) {
        throw new Error('Narration audio URL is not available');
      }
      return {
        type: 'silence',
        durationMs: Math.max(MIN_SCENE_MS, Math.round(track.durationMs || DEFAULT_SCENE_MS)),
      };
    }

    try {
      const ext = extFromMime(track.mimeType, extFromUrl(url, 'audio'));
      const filePath = path.join(workDir, `scene_${sceneIndex}_track_${trackIndex}.${ext}`);
      await writeFetchedAudio(url, filePath);
      return {
        type: 'file',
        path: filePath,
        durationMs: await probeDurationMs(filePath, track.durationMs),
      };
    } catch (error) {
      if (track.required) {
        throw error;
      }
      return {
        type: 'silence',
        durationMs: Math.max(MIN_SCENE_MS, Math.round(track.durationMs || DEFAULT_SCENE_MS)),
      };
    }
  }

  const file = asFile(formData.get(track.field));
  if (!file) {
    if (track.required) {
      throw new Error('Narration audio file is missing');
    }
    return {
      type: 'silence',
      durationMs: Math.max(MIN_SCENE_MS, Math.round(track.durationMs || DEFAULT_SCENE_MS)),
    };
  }

  const ext = extFromMime(track.mimeType || file.type, 'audio');
  const filePath = path.join(workDir, `scene_${sceneIndex}_track_${trackIndex}.${ext}`);
  await writeUploadedFile(file, filePath);

  return {
    type: 'file',
    path: filePath,
    durationMs: await probeDurationMs(filePath, track.durationMs),
  };
}

async function buildSceneAudio(
  preparedTracks: PreparedTrack[],
  fallbackMs: number,
  workDir: string,
  sceneIndex: number,
): Promise<{ audioPath: string; durationMs: number }> {
  const tracks =
    preparedTracks.length > 0
      ? preparedTracks
      : [{ type: 'silence' as const, durationMs: fallbackMs }];

  const durationMs = Math.max(
    MIN_SCENE_MS,
    tracks.reduce((sum, track) => sum + Math.max(0, track.durationMs), 0),
  );
  const audioPath = path.join(workDir, `scene_${sceneIndex}_audio.m4a`);

  if (tracks.length === 1 && tracks[0].type === 'silence') {
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      audioPath,
    ]);
    return { audioPath, durationMs };
  }

  if (tracks.length === 1 && tracks[0].type === 'file' && tracks[0].path) {
    await runFfmpeg([
      '-y',
      '-i',
      tracks[0].path,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      audioPath,
    ]);
    return { audioPath, durationMs };
  }

  const args = ['-y'];
  const labels: string[] = [];
  tracks.forEach((track, index) => {
    if (track.type === 'silence') {
      args.push(
        '-f',
        'lavfi',
        '-t',
        (track.durationMs / 1000).toFixed(3),
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
      );
    } else if (track.path) {
      args.push('-i', track.path);
    }
    labels.push(`[${index}:a]`);
  });

  args.push(
    '-filter_complex',
    `${labels.join('')}concat=n=${tracks.length}:v=0:a=1[a]`,
    '-map',
    '[a]',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    audioPath,
  );

  await runFfmpeg(args);
  return { audioPath, durationMs };
}

async function buildSceneVideo({
  imagePath,
  audioPath,
  outputPath,
  durationMs,
  width,
  height,
  fps,
}: {
  imagePath: string;
  audioPath: string;
  outputPath: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}): Promise<void> {
  const duration = (durationMs / 1000).toFixed(3);
  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-t',
    duration,
    '-i',
    imagePath,
    '-i',
    audioPath,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=yuv420p`,
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-shortest',
    outputPath,
  ]);
}

async function concatSegments(segmentPaths: string[], outputPath: string, workDir: string) {
  const listPath = path.join(workDir, 'segments.txt');
  await writeFile(
    listPath,
    segmentPaths.map((segmentPath) => `file '${quoteConcatPath(segmentPath)}'`).join('\n'),
  );
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
}

export async function POST(request: NextRequest) {
  let workDir: string | null = null;

  try {
    const formData = await request.formData();
    const rawManifest = formData.get('manifest');
    if (typeof rawManifest !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing manifest');
    }

    const manifest = JSON.parse(rawManifest) as VideoCourseManifest;
    if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      return apiError('INVALID_REQUEST', 400, 'No scenes to export');
    }

    const width = clampNumber(manifest.width, DEFAULT_WIDTH, 320, 3840);
    const height = clampNumber(manifest.height, DEFAULT_HEIGHT, 180, 2160);
    const fps = clampNumber(manifest.fps, DEFAULT_FPS, 10, 60);

    workDir = await mkdtemp(path.join(tmpdir(), 'maic-video-export-'));
    const segmentPaths: string[] = [];

    for (let sceneIndex = 0; sceneIndex < manifest.scenes.length; sceneIndex++) {
      const scene = manifest.scenes[sceneIndex];
      const imageFile = asFile(formData.get(scene.imageField));
      if (!imageFile) {
        return apiError('INVALID_REQUEST', 400, `Missing image for scene ${sceneIndex + 1}`);
      }

      const imagePath = path.join(workDir, `scene_${sceneIndex}.png`);
      await writeUploadedFile(imageFile, imagePath);

      const fallbackMs = Math.max(MIN_SCENE_MS, Math.round(scene.fallbackMs || DEFAULT_SCENE_MS));
      const preparedTracks = await Promise.all(
        (scene.tracks ?? []).map((track, trackIndex) =>
          prepareTrack(track, formData, workDir!, sceneIndex, trackIndex, request),
        ),
      );
      const { audioPath, durationMs } = await buildSceneAudio(
        preparedTracks,
        fallbackMs,
        workDir,
        sceneIndex,
      );

      const segmentPath = path.join(workDir, `segment_${sceneIndex}.mp4`);
      await buildSceneVideo({
        imagePath,
        audioPath,
        outputPath: segmentPath,
        durationMs,
        width,
        height,
        fps,
      });
      segmentPaths.push(segmentPath);
    }

    const outputPath = path.join(workDir, 'course.mp4');
    await concatSegments(segmentPaths, outputPath, workDir);
    const output = await readFile(outputPath);

    const fileName = (manifest.fileName || 'course').replace(/[\\/:*?"<>|]/g, '_') || 'course';
    return new NextResponse(output, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}.mp4"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('INTERNAL_ERROR', 500, message);
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
