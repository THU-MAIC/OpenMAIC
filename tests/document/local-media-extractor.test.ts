import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import type { MediaExtractorInput, MediaExtractorProvider } from '@/lib/document';
import { selectMediaExtractorProvider } from '@/lib/document/extractors/media-registry';
import {
  createLocalMediaExtractorProvider,
  defaultMediaCommands,
} from '@/lib/document/extractors/local-media';

const execFileAsync = promisify(execFile);
const unavailableCommands = {
  resolve: vi.fn(async (name: 'ffmpeg' | 'ffprobe') => {
    throw new Error(`${name} missing`);
  }),
  run: vi.fn(),
};
const input: MediaExtractorInput = {
  buffer: Buffer.from('fixture'),
  fileName: 'lesson.mp4',
  mimeType: 'video/mp4',
  config: { providerId: '' },
};

function cloudProvider(available: boolean): MediaExtractorProvider {
  return {
    id: 'cloud',
    displayName: 'Cloud',
    version: '1',
    supportedMimeTypes: ['video/mp4'],
    capabilities: {
      transcript: true,
      keyframes: true,
      synopsis: true,
      ocr: true,
      async: true,
    },
    availability: vi.fn(async () => ({ available })),
    extract: vi.fn(),
  };
}

describe('optional local media extractor availability', () => {
  it('does not offer the local provider when either executable is absent', async () => {
    const local = createLocalMediaExtractorProvider({ commands: unavailableCommands });

    await expect(local.availability?.(input)).resolves.toMatchObject({ available: false });
    expect(unavailableCommands.resolve).toHaveBeenCalledWith('ffmpeg');
    expect(unavailableCommands.resolve).toHaveBeenCalledWith('ffprobe');
  });

  it('falls back to a configured cloud provider without calling local extraction', async () => {
    const cloud = cloudProvider(true);
    const local = createLocalMediaExtractorProvider({ commands: unavailableCommands });

    await expect(
      selectMediaExtractorProvider({
        mimeType: input.mimeType,
        input,
        providers: [local, cloud],
      }),
    ).resolves.toBe(cloud);
  });

  it('names both enablement paths when no provider is available', async () => {
    const local = createLocalMediaExtractorProvider({ commands: unavailableCommands });

    await expect(
      selectMediaExtractorProvider({
        mimeType: input.mimeType,
        input,
        providers: [cloudProvider(false), local],
      }),
    ).rejects.toThrow(/Configure AliDocMind credentials.*install ffmpeg.*configure a server ASR/i);
  });
});

let ffmpegAvailable = false;
try {
  await Promise.all([
    defaultMediaCommands.resolve('ffmpeg'),
    defaultMediaCommands.resolve('ffprobe'),
  ]);
  ffmpegAvailable = true;
} catch {
  // The real-pipeline suite is optional, like the PostgreSQL-backed suites.
}

describe.skipIf(!ffmpegAvailable)('local media extractor real pipeline', () => {
  it('probes, chunks, transcribes, and timestamps a tiny fixture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmaic-media-test-'));
    const fixturePath = join(directory, 'fixture.mp4');
    try {
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-shortest',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        fixturePath,
      ]);
      const provider = createLocalMediaExtractorProvider({
        transcribe: vi.fn(async () => ({ text: 'A tiny local transcript.' })),
        resolveASRConfig: () => ({
          providerId: 'openai-whisper',
          modelId: 'whisper-1',
          language: 'auto',
        }),
      });

      const artifact = await provider.extract({
        buffer: await readFile(fixturePath),
        fileName: 'fixture.mp4',
        mimeType: 'video/mp4',
        config: { providerId: 'local-ffmpeg' },
      });

      expect(artifact.metadata.durationMs).toBeGreaterThan(1_500);
      expect(artifact.transcript).toEqual([
        expect.objectContaining({
          startMs: 0,
          endMs: expect.any(Number),
          text: 'A tiny local transcript.',
        }),
      ]);
      expect(artifact.transcript?.[0].endMs).toBeGreaterThan(1_500);
      expect(artifact.keyframes?.length).toBeGreaterThan(0);
      expect(artifact.assets?.[0]).toMatchObject({ type: 'image', mimeType: 'image/webp' });

      const deadlineProvider = createLocalMediaExtractorProvider({
        transcribe: vi.fn(() => new Promise<{ text: string }>(() => undefined)),
        resolveASRConfig: () => ({
          providerId: 'openai-whisper',
          modelId: 'whisper-1',
          language: 'auto',
        }),
        jobTimeoutMs: 2_000,
      });
      await expect(
        deadlineProvider.extract({
          buffer: await readFile(fixturePath),
          fileName: 'long-running.mp4',
          mimeType: 'video/mp4',
          config: { providerId: 'local-ffmpeg' },
        }),
      ).rejects.toThrow(/media extraction job deadline exceeded/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
