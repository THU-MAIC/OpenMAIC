import { describe, expect, it, vi } from 'vitest';
import {
  describeSelfHostedMinerUError,
  pageLimitOf,
  parseMinerUErrorBody,
  selfHostedMinerUFailure,
} from '@/lib/pdf/pdf-providers';
import {
  isTransientExtractionError,
  MaterialSourceRefusedError,
} from '@/lib/server/material-extraction/errors';

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

describe('a MinerU gateway refusal', () => {
  const GATEWAY_BODY = JSON.stringify({
    error: {
      code: 'pdf_too_many_pages',
      message:
        'PDF has 461 pages, which exceeds the 200-page limit. Split the file and upload it again.',
    },
  });

  it('turns pdf_too_many_pages into a too_many_pages refusal with its counts', () => {
    for (const managed of [true, false]) {
      const error = selfHostedMinerUFailure(422, GATEWAY_BODY, { managed });
      expect(error).toBeInstanceOf(MaterialSourceRefusedError);
      expect(error).toMatchObject({
        reasonCode: 'too_many_pages',
        reasonValues: { pages: 461, maxPages: 200 },
        retryable: false,
      });
      expect(isTransientExtractionError(error)).toBe(false);
      expect(error.message).toBe(
        'MinerU refused the document: too many pages (status 422; 461 pages, limit 200 pages)',
      );
      // Only the counts, never the provider's words.
      expect(error.message).not.toContain('Split the file');
    }
  });

  it('keeps the refusal when the message states no counts', () => {
    const error = selfHostedMinerUFailure(
      422,
      JSON.stringify({ error: { code: 'pdf_too_many_pages', message: 'Document is too long' } }),
    );
    expect(error).toMatchObject({ reasonCode: 'too_many_pages', reasonValues: {} });
    expect(error.message).toBe('MinerU refused the document: too many pages (status 422)');
  });

  it('keeps a managed service message, truncated, for any other 4xx', () => {
    const body = JSON.stringify({
      error: { code: 'unsupported_file', message: `Encrypted PDF ${'x'.repeat(1000)}` },
    });
    const error = selfHostedMinerUFailure(415, body, { managed: true });
    expect(error).not.toBeInstanceOf(MaterialSourceRefusedError);
    expect(
      error.message.startsWith('MinerU API error (415): unsupported_file: Encrypted PDF'),
    ).toBe(true);
    expect(error.message.length).toBeLessThan(350);
    expect(isTransientExtractionError(error)).toBe(false);
    expect(selfHostedMinerUFailure(400, 'plain refusal text', { managed: true }).message).toBe(
      'MinerU API error (400): plain refusal text',
    );
  });

  it('never quotes the body of a caller-supplied service', () => {
    const body = JSON.stringify({ error: { code: 'x', message: 'internal-secret-body' } });
    expect(selfHostedMinerUFailure(400, body).message).toBe('MinerU API error (400)');
  });

  it('parses OpenAI-style, FastAPI and plain-text bodies', () => {
    expect(parseMinerUErrorBody(GATEWAY_BODY)).toMatchObject({ code: 'pdf_too_many_pages' });
    expect(parseMinerUErrorBody('{"detail":"bad backend"}')).toEqual({ message: 'bad backend' });
    expect(parseMinerUErrorBody('{"error":"nope"}')).toEqual({ message: 'nope' });
    expect(parseMinerUErrorBody(' Bad Gateway ')).toEqual({ message: 'Bad Gateway' });
    expect(parseMinerUErrorBody('[1]')).toEqual({ message: '[1]' });
  });

  it('reads the page count and limit from the usual phrasings', () => {
    expect(pageLimitOf('PDF has 461 pages, which exceeds the 200-page limit')).toEqual({
      pages: 461,
      maxPages: 200,
    });
    expect(pageLimitOf('PDF has 461 pages; the limit is 200')).toEqual({
      pages: 461,
      maxPages: 200,
    });
    expect(pageLimitOf('too many pages')).toEqual({});
  });
});
