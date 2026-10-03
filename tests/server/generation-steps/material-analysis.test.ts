import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  analyzeMaterial,
  type MaterialAnalysisInput,
} from '@/lib/server/generation/steps/material-analysis';
import type { ExtractionServices } from '@/lib/server/material-extraction/services';

import { testLogger } from './helpers';

// No model configuration: the self-contained extractors and the providers a
// request names.
vi.mock('@/lib/server/model-config/deployment-layer', () => ({
  loadDeploymentLayer: () => ({ layer: null, legacy: false, notices: [] }),
}));

const services: ExtractionServices = { document: null, documentStatus: 'unassigned' };

function source(text: string, mimeType: string, fileName = 'notes.txt') {
  const buffer = Buffer.from(text, 'utf8');
  return { fileName, fileSize: buffer.byteLength, mimeType, buffer };
}

async function refusal(input: MaterialAnalysisInput) {
  const failure = await analyzeMaterial(input, { log: testLogger() }).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(StepRefusal);
  return failure as StepRefusal;
}

describe('material analysis step', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('extracts a plain-text material with its metadata', async () => {
    const trace: { resolvedProviderId?: string } = {};
    const result = await analyzeMaterial(
      {
        source: source('Fractions are parts of a whole.', 'text/plain'),
        services,
        request: {},
        redactCallerInput: false,
        trace,
      },
      { log: testLogger() },
    );
    expect(result.text).toContain('Fractions are parts of a whole.');
    expect(result.metadata).toMatchObject({
      fileName: 'notes.txt',
      fileSize: 31,
      mimeType: 'text/plain',
    });
    expect(trace.resolvedProviderId).toBe(result.metadata?.parser);
  });

  it('refuses an extractor that does not exist', async () => {
    const failure = await refusal({
      source: source('x', 'text/plain'),
      services,
      request: { providerId: 'no-such-extractor' },
      redactCallerInput: false,
    });
    expect(failure.reason).toBe('unknown-provider');
    expect(failure.message).toContain('no-such-extractor');
  });

  it('refuses a document extractor for media', async () => {
    const failure = await refusal({
      source: source('x', 'audio/mpeg', 'talk.mp3'),
      services,
      request: { providerId: 'unpdf' },
      redactCallerInput: false,
    });
    expect(failure.reason).toBe('provider-cannot-extract');
  });

  it('keeps the caller input out of a redacted refusal', async () => {
    const mime = 'application/x-probe';
    const plain = await refusal({
      source: source('x', mime, 'probe.bin'),
      services,
      request: {},
      redactCallerInput: false,
    });
    const redacted = await refusal({
      source: source('x', mime, 'probe.bin'),
      services,
      request: {},
      redactCallerInput: true,
    });
    expect(plain.reason).toBe('unsupported-type');
    expect(plain.message).toContain(mime);
    expect(redacted.reason).toBe('unsupported-type');
    expect(redacted.message).not.toContain(mime);
  });
});
