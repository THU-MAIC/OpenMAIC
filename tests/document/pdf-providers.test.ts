import { describe, expect, it, vi } from 'vitest';
import { describeSelfHostedMinerUError } from '@/lib/pdf/pdf-providers';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('describeSelfHostedMinerUError', () => {
  it('returns a friendly message when the pipeline module is missing', () => {
    const raw = JSON.stringify({
      detail: "ModuleNotFoundError: No module named 'mineru.backend.pipeline'",
    });
    const message = describeSelfHostedMinerUError(500, raw);
    expect(message).toContain('pipeline/core dependencies are not installed');
    expect(message).toContain('mineru[pipeline]');
    // Raw traceback should not leak into the surfaced message.
    expect(message).not.toContain('ModuleNotFoundError');
  });

  it('detects the CPU "device string" failure of vllm-only installs', () => {
    const message = describeSelfHostedMinerUError(500, 'Device string must not be empty');
    expect(message).toContain('pipeline/core dependencies are not installed');
  });

  it('detects an ImportError signature', () => {
    const message = describeSelfHostedMinerUError(
      500,
      'ImportError: cannot import name pipeline_analyze',
    );
    expect(message).toContain('mineru[core]');
  });

  it('reports only the status for unknown errors', () => {
    const message = describeSelfHostedMinerUError(502, 'Bad Gateway');
    expect(message).toBe('MinerU API error (502)');
  });

  it('never quotes an unknown error body', () => {
    const message = describeSelfHostedMinerUError(500, 'internal-secret-body '.repeat(50));
    expect(message).toBe('MinerU API error (500)');
  });
});
