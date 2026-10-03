/**
 * Material analysis as a run calls it: the owner's extraction services from
 * the document and speech slots, and no extractor named by the caller.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { analyzeMaterial } from '@/lib/server/generation/steps/material-analysis';
import type { ExtractionServices } from '@/lib/server/material-extraction/services';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

import { testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(() => false),
  parseWithMinerUCloud: vi.fn(),
  checkClientDocumentExtractorBaseUrl: vi.fn(),
  extractMedia: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
}));
// No model configuration beyond what each case installs.
vi.mock('@/lib/server/model-config/deployment-layer', () => ({
  loadDeploymentLayer: () => ({ layer: null, legacy: false, notices: [] }),
}));
vi.mock('@/lib/pdf/mineru-cloud', () => ({
  parseWithMinerUCloud: mocks.parseWithMinerUCloud,
}));
vi.mock('@/lib/server/client-extractor-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/client-extractor-endpoint')>()),
  checkClientDocumentExtractorBaseUrl: mocks.checkClientDocumentExtractorBaseUrl,
}));
vi.mock('@/lib/document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document')>()),
  extractMedia: mocks.extractMedia,
}));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function source(text: string, mimeType: string, fileName: string) {
  const buffer = Buffer.from(text, 'utf8');
  return { fileName, fileSize: buffer.byteLength, mimeType, buffer };
}

/** The deployment's configuration; `legacy` when it was translated from the old variables. */
async function deploymentSlots(config: ModelConfigFile, { legacy = false } = {}) {
  (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy,
    notices: [],
  });
}

/** Analyse one material with the services the slots resolve to, as a run does. */
async function analyze(material: ReturnType<typeof source>, services?: ExtractionServices) {
  const { resolveExtractionServices } = await import('@/lib/server/material-extraction/services');
  return analyzeMaterial(
    {
      source: material,
      services: services ?? (await resolveExtractionServices()),
      request: {},
      redactCallerInput: false,
    },
    { log: testLogger() },
  );
}

async function refusal(material: ReturnType<typeof source>, services?: ExtractionServices) {
  const failure = await analyze(material, services).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(StepRefusal);
  return failure as StepRefusal;
}

describe('material analysis from the slots', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReset().mockReturnValue(false);
    mocks.parseWithMinerUCloud.mockReset().mockResolvedValue({
      text: 'cloud parsed text',
      images: [],
      metadata: { pageCount: 1, parser: 'mineru-cloud' },
    });
    mocks.checkClientDocumentExtractorBaseUrl.mockReset().mockResolvedValue({
      ok: false,
      message: 'document endpoint refused',
    });
    mocks.extractMedia.mockReset().mockResolvedValue({
      metadata: { providerId: 'local-ffmpeg' },
      transcript: [],
      keyframes: [],
    });
  });

  it("hands the caller's signal to the extractor, which stops its requests on it", async () => {
    await deploymentSlots({
      providers: { mc: { preset: 'mineru-cloud', apiKey: 'slot-key' } },
      slots: { document: 'mc' },
    });
    const { resolveExtractionServices } = await import('@/lib/server/material-extraction/services');
    const controller = new AbortController();
    await analyzeMaterial(
      {
        source: source('%PDF-1.4', 'application/pdf', 'lesson.pdf'),
        services: await resolveExtractionServices(),
        request: {},
        redactCallerInput: false,
      },
      { log: testLogger(), signal: controller.signal },
    );
    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
      expect.any(Buffer),
      'lesson.pdf',
    );
  });

  it("uses the document slot's service and key", async () => {
    await deploymentSlots({
      providers: { mc: { preset: 'mineru-cloud', apiKey: 'slot-key' } },
      slots: { document: 'mc' },
    });
    const result = await analyze(source('%PDF-1.4', 'application/pdf', 'lesson.pdf'));

    expect(result.text).toBe('cloud parsed text');
    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'mineru-cloud', apiKey: 'slot-key' }),
      expect.any(Buffer),
      'lesson.pdf',
    );
  });

  it('uses the document default translated from the legacy provider variables', async () => {
    // What loadDeploymentLayer builds from PDF_MINERU_CLOUD_API_KEY alone.
    await deploymentSlots(
      {
        providers: { 'mineru-cloud': { preset: 'mineru-cloud', apiKey: 'env-key' } },
        slots: { document: 'mineru-cloud' },
      },
      { legacy: true },
    );
    await analyze(source('%PDF-1.4', 'application/pdf', 'lesson.pdf'));

    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'mineru-cloud', apiKey: 'env-key' }),
      expect.any(Buffer),
      'lesson.pdf',
    );
  });

  it('uses no document service, even an operator-configured one, once the slot is off', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    await deploymentSlots({ slots: { document: null } });
    const failure = await refusal(source('not really docx', DOCX, 'lesson.docx'));

    expect(failure.reason).toBe('service-required');
    expect(failure.message).toBe(
      'DOCX extraction needs a document service, and none is configured. Assign one to the document slot in the model settings or openmaic.yml.',
    );
    expect(mocks.parseWithMinerUCloud).not.toHaveBeenCalled();
  });

  it("refuses a workspace document service's endpoint that fails the endpoint rule", async () => {
    const failure = await refusal(source('%PDF-1.4', 'application/pdf', 'a.pdf'), {
      document: {
        providerId: 'mineru',
        baseUrl: 'https://mineru.example.com',
        managed: false,
        userEndpoint: true,
        origin: 'configuration',
      },
      documentStatus: 'configured',
    } as ExtractionServices);

    expect(failure.reason).toBe('endpoint-refused');
    expect(failure.message).toBe('document endpoint refused');
  });

  it('extracts a self-contained type when the speech assignment is unusable', async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: { providers: { fa: { preset: 'funasr-asr' } }, slots: { asr: 'fa' } },
    }));
    try {
      const { resolveExtractionServices } =
        await import('@/lib/server/material-extraction/services');
      const result = await analyze(
        source('plain notes', 'text/plain', 'notes.txt'),
        await resolveExtractionServices('user:alice'),
      );
      expect(result.text).toContain('plain notes');
    } finally {
      runtime.setWorkspaceLayerLoaderForTests();
    }
  });

  it('refuses media that produced no content', async () => {
    const failure = await refusal(source('x', 'audio/mpeg', 'talk.mp3'));

    expect(failure.reason).toBe('no-content');
    expect(failure.message).toBe(
      'No transcript, keyframes, or synopsis could be extracted from "talk.mp3".',
    );
  });

  it('refuses a type no extractor reads', async () => {
    const failure = await refusal(source('x', 'application/x-echo-probe', 'probe.bin'));

    expect(failure.reason).toBe('unsupported-type');
    expect(failure.message).toBe(
      'No document extractor supports MIME type "application/x-echo-probe" with the requested capabilities',
    );
  });
});
