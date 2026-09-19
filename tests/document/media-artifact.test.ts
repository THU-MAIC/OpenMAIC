import { describe, expect, it } from 'vitest';

import type { ExtractionResult, MediaArtifact } from '@/lib/document';

describe('media extraction artifact', () => {
  it('represents timestamp-anchored media extraction output separately from document pages', () => {
    const artifact: MediaArtifact = {
      metadata: {
        fileName: 'lesson.mp4',
        fileSize: 1024,
        mimeType: 'video/mp4',
        durationMs: 90_000,
        providerId: 'maic-media',
      },
      transcript: [
        {
          id: 'seg_1',
          startMs: 0,
          endMs: 12_500,
          text: 'Today we will review Ohm law.',
          confidence: 0.93,
        },
      ],
      keyframes: [
        {
          id: 'frame_1',
          timeMs: 10_000,
          ocrText: 'V = IR',
          description: 'Slide showing the Ohm law formula',
        },
      ],
    };

    expect(artifact.transcript?.[0]).toMatchObject({
      startMs: 0,
      endMs: 12_500,
      text: 'Today we will review Ohm law.',
    });
    expect(artifact.keyframes?.[0].timeMs).toBe(10_000);
  });

  it('keeps extraction failures at the result layer instead of encoding them as artifacts', () => {
    const result: ExtractionResult = {
      status: 'failed',
      error: {
        code: 'UNSUPPORTED_MEDIA_CODEC',
        message: 'The uploaded media codec is not supported by the configured extractor.',
        providerId: 'maic-media',
        retryable: false,
      },
    };

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('UNSUPPORTED_MEDIA_CODEC');
    }
  });
});
