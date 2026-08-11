import { describe, expect, it } from 'vitest';
import { parseProbeOutput, validateProbeMetrics } from '../src/benchmark/media-checks.js';

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
    expect(() => validateProbeMetrics(metrics, 5, 30)).not.toThrow();
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
    expect(() => validateProbeMetrics(base, 5, 30)).toThrow(/duration mismatch/);
  });
});
