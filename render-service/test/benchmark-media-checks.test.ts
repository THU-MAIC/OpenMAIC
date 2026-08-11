import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';
import {
  parseProbeOutput,
  resolveExecutablePath,
  validateProbeMetrics,
  validateRepresentativeFrameVariation,
} from '../src/benchmark/media-checks.js';

describe('benchmark ffprobe checks', () => {
  it('resolves bare executable names to producer-compatible absolute paths', async () => {
    const command = process.platform === 'win32' ? 'node.exe' : 'node';
    expect(isAbsolute(await resolveExecutablePath(command))).toBe(true);
    expect(await resolveExecutablePath(process.execPath)).toBe(process.execPath);
  });

  it('extracts frame, size, duration, and A/V drift metrics', () => {
    const metrics = parseProbeOutput(
      {
        streams: [
          { codec_type: 'video', duration: '5.000', nb_frames: '150' },
          { codec_type: 'audio', duration: '4.990' },
        ],
        format: { duration: '5.000', size: '12345' },
      },
      1,
      30,
    );
    expect(metrics).toEqual({
      formatDurationSeconds: 5,
      videoDurationSeconds: 5,
      audioDurationSeconds: 4.99,
      avDriftSeconds: expect.closeTo(0.01),
      frameCount: 150,
      outputSizeBytes: 12345,
    });
    expect(() => validateProbeMetrics(metrics, 5, 30, true)).not.toThrow();
  });

  it('rejects duration and frame-count mismatches', () => {
    const base = {
      formatDurationSeconds: 5,
      videoDurationSeconds: 4,
      audioDurationSeconds: null,
      avDriftSeconds: null,
      frameCount: 120,
      outputSizeBytes: 1,
    };
    expect(() => validateProbeMetrics(base, 5, 30, false)).toThrow(/duration mismatch/);
  });

  it('rejects missing required audio and visually identical representative frames', () => {
    const metrics = {
      formatDurationSeconds: 5,
      videoDurationSeconds: 5,
      audioDurationSeconds: null,
      avDriftSeconds: null,
      frameCount: 150,
      outputSizeBytes: 1,
    };
    expect(() => validateProbeMetrics(metrics, 5, 30, true)).toThrow(/no audio stream/);
    expect(() =>
      validateProbeMetrics({ ...metrics, audioDurationSeconds: 5 }, 5, 30, false),
    ).toThrow(/unexpected audio stream/);
    expect(() =>
      validateRepresentativeFrameVariation([
        {
          fraction: 0.1,
          timestampSeconds: 0.5,
          sha256: 'same',
          baselineSha256: null,
          matchesBaseline: null,
        },
        {
          fraction: 0.9,
          timestampSeconds: 4.5,
          sha256: 'same',
          baselineSha256: null,
          matchesBaseline: null,
        },
      ]),
    ).toThrow(/no visual variation/);
  });
});
