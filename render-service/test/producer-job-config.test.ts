import { describe, expect, it } from 'vitest';
import { assertRequiredCaptureMode, buildProducerJobConfig } from '../src/render-manager.js';

describe('buildProducerJobConfig', () => {
  const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;

  it('passes the configured worker count as an explicit producer job option', () => {
    expect(buildProducerJobConfig(options, 4)).toEqual({ ...options, workers: 4 });
  });

  it('keeps one worker explicit so producer auto-parallel thresholds cannot raise it', () => {
    expect(buildProducerJobConfig(options, 1)).toEqual({ ...options, workers: 1 });
  });

  it('leaves workers unset when no explicit override is supplied', () => {
    expect(buildProducerJobConfig(options, undefined)).toEqual(options);
  });

  it('rejects a required beginFrame profile when workers report screenshot mode', () => {
    expect(() => assertRequiredCaptureMode('screenshot', true)).toThrow(/beginFrame/i);
    expect(() => assertRequiredCaptureMode('beginframe|screenshot', true)).toThrow(/beginFrame/i);
    expect(() => assertRequiredCaptureMode(undefined, true)).toThrow(/beginFrame/i);
  });

  it('accepts the resolved beginFrame mode and does nothing when not required', () => {
    expect(() => assertRequiredCaptureMode('beginframe', true)).not.toThrow();
    expect(() => assertRequiredCaptureMode('screenshot', false)).not.toThrow();
  });
});
