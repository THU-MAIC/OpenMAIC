/**
 * Characterization: the answers POST /api/extract-document gives when a
 * course material cannot be analysed, on the upload form and on the asset-id
 * form. They import nothing but the route and the registry it selects from,
 * so they run unchanged against the route before and after material analysis
 * moved into lib/server/generation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveExtractionServices: vi.fn(),
  checkClientDocumentExtractorBaseUrl: vi.fn(),
  checkClientMediaExtractorBaseUrl: vi.fn(),
  extractMedia: vi.fn(),
  resolveServerAsset: vi.fn(),
}));

// No model configuration: the providers a request names.
vi.mock('@/lib/server/model-config/deployment-layer', () => ({
  loadDeploymentLayer: () => ({ layer: null, defaults: null, notices: [] }),
}));
vi.mock('@/lib/server/material-extraction/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/material-extraction/services')>()),
  resolveExtractionServices: mocks.resolveExtractionServices,
}));
vi.mock('@/lib/server/client-extractor-endpoint', () => ({
  checkClientDocumentExtractorBaseUrl: mocks.checkClientDocumentExtractorBaseUrl,
  checkClientMediaExtractorBaseUrl: mocks.checkClientMediaExtractorBaseUrl,
}));
vi.mock('@/lib/document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document')>()),
  extractMedia: mocks.extractMedia,
}));
vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveServerAsset: mocks.resolveServerAsset,
}));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function upload(file: File, fields: Record<string, string> = {}) {
  const formData = new FormData();
  formData.append('file', file);
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);
  const { POST } = await import('@/app/api/extract-document/route');
  const response = await POST(
    new Request('http://localhost/api/extract-document', {
      method: 'POST',
      body: formData,
    }) as unknown as NextRequest,
  );
  return { status: response.status, body: await response.json() };
}

async function byAssetId(fields: Record<string, string>, bytes: string, mimeType: string) {
  mocks.resolveServerAsset.mockResolvedValue({
    status: 'resolved',
    buffer: Buffer.from(bytes),
    mimeType,
  });
  const { POST } = await import('@/app/api/extract-document/route');
  const response = await POST(
    new Request('http://localhost/api/extract-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: 'ast_1', ...fields }),
    }) as unknown as NextRequest,
  );
  return { status: response.status, body: await response.json() };
}

const refusal = (status: number, errorCode: string, error: string) => ({
  status,
  body: { success: false, errorCode, error },
});

describe('POST /api/extract-document refusals', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) mock.mockReset();
    const actual = await vi.importActual<
      typeof import('@/lib/server/material-extraction/services')
    >('@/lib/server/material-extraction/services');
    mocks.resolveExtractionServices.mockImplementation(actual.resolveExtractionServices);
    mocks.checkClientDocumentExtractorBaseUrl.mockResolvedValue({
      ok: false,
      message: 'document endpoint refused',
    });
    mocks.checkClientMediaExtractorBaseUrl.mockReturnValue({
      ok: false,
      message: 'media endpoint refused',
    });
    mocks.extractMedia.mockResolvedValue({
      metadata: { providerId: 'local-ffmpeg' },
      transcript: [],
      keyframes: [],
    });
  });

  it('refuses a document extractor for media (400)', async () => {
    expect(
      await upload(new File(['x'], 'talk.mp3', { type: 'audio/mpeg' }), { providerId: 'unpdf' }),
    ).toEqual(
      refusal(
        400,
        'INVALID_REQUEST',
        'Provider "unpdf" cannot extract audio/mpeg. Choose a media-capable provider (AliDocMind or local ffmpeg).',
      ),
    );
  });

  it('refuses an extractor that does not exist (400)', async () => {
    expect(
      await upload(new File(['x'], 'notes.txt', { type: 'text/plain' }), { providerId: 'nope' }),
    ).toEqual(refusal(400, 'INVALID_REQUEST', 'Unknown document extractor provider: nope'));
  });

  it('refuses a type no extractor reads (400), generically on the asset-id form', async () => {
    const mime = 'application/x-echo-probe';
    const { selectDocumentExtractorProvider } =
      await vi.importActual<typeof import('@/lib/document')>('@/lib/document');
    let selectionError = '';
    try {
      selectDocumentExtractorProvider({ mimeType: mime, requiredCapabilities: { text: true } });
    } catch (error) {
      selectionError = (error as Error).message;
    }
    expect(selectionError).toContain(mime);
    expect(await upload(new File(['x'], 'probe.bin', { type: mime }))).toEqual(
      refusal(400, 'INVALID_REQUEST', selectionError),
    );
    expect(await byAssetId({ fileName: 'probe.bin', mimeType: mime }, 'x', mime)).toEqual(
      refusal(
        400,
        'INVALID_REQUEST',
        'The requested document extractor cannot process this course material.',
      ),
    );
  });

  it('refuses a media extractor endpoint the caller typed that fails the rule (403)', async () => {
    expect(
      await upload(new File(['x'], 'talk.mp3', { type: 'audio/mpeg' }), {
        providerId: 'alidocmind',
        baseUrl: 'https://media.example.com',
      }),
    ).toEqual(refusal(403, 'INVALID_URL', 'media endpoint refused'));
    expect(mocks.extractMedia).not.toHaveBeenCalled();
  });

  it('refuses a document extractor endpoint the caller typed that fails the rule (403)', async () => {
    expect(
      await upload(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }), {
        providerId: 'mineru',
        baseUrl: 'https://mineru.example.com',
      }),
    ).toEqual(refusal(403, 'INVALID_URL', 'document endpoint refused'));
  });

  it("refuses a workspace document service's endpoint that fails the rule (403)", async () => {
    mocks.resolveExtractionServices.mockResolvedValue({
      document: {
        providerId: 'mineru',
        baseUrl: 'https://mineru.example.com',
        managed: false,
        userEndpoint: true,
        origin: 'configuration',
      },
      documentStatus: 'configured',
    });
    expect(await upload(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }))).toEqual(
      refusal(403, 'INVALID_URL', 'document endpoint refused'),
    );
  });

  it('refuses media with no content (422), without the file name on the asset-id form', async () => {
    expect(await upload(new File(['x'], 'talk.mp3', { type: 'audio/mpeg' }))).toEqual(
      refusal(
        422,
        'PARSE_FAILED',
        'No transcript, keyframes, or synopsis could be extracted from "talk.mp3".',
      ),
    );
    expect(
      await byAssetId({ fileName: 'talk.mp3', mimeType: 'audio/mpeg' }, 'x', 'audio/mpeg'),
    ).toEqual(
      refusal(
        422,
        'PARSE_FAILED',
        'No transcript, keyframes, or synopsis could be extracted from this course material.',
      ),
    );
  });

  it('refuses a type that needs a document service once the slot is off (422)', async () => {
    mocks.resolveExtractionServices.mockResolvedValue({
      document: null,
      documentStatus: 'disabled',
    });
    expect(await upload(new File(['x'], 'a.docx', { type: DOCX }))).toEqual(
      refusal(
        422,
        'INVALID_REQUEST',
        'DOCX extraction needs a document service, and none is configured. Assign one to the document slot in the model settings or openmaic.yml.',
      ),
    );
  });

  it('refuses self-hosted MinerU without a base URL (422)', async () => {
    expect(
      await upload(new File(['x'], 'a.docx', { type: DOCX }), { providerId: 'mineru' }),
    ).toEqual(
      refusal(
        422,
        'INVALID_REQUEST',
        'DOCX extraction requires a configured MinerU document extractor. Self-hosted MinerU was selected, but no self-hosted MinerU base URL is configured, so it is unavailable. Documents are not sent to MinerU Cloud automatically: configure a self-hosted MinerU base URL in PDF provider settings, or set ALLOW_MINERU_CLOUD_FALLBACK=1 to explicitly allow the MinerU Cloud fallback.',
      ),
    );
  });
});
