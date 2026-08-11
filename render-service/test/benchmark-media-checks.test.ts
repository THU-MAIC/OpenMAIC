import { describe, expect, it } from 'vitest';
import {
  parseProbeOutput,
  validateProbeMetrics,
  validateRepresentativeFrameVariation,
} from '../src/benchmark/media-checks.js';

describe('benchmark ffprobe checks', () => {
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
