import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const config = vi.hoisted(() => ({
  managed: new Set<string>(),
  keys: new Map<string, string>(),
  urls: new Map<string, string>(),
  validateUrl: vi.fn(),
  ali: vi.fn(),
}));
vi.mock('@/lib/document', () => ({ getDocumentExtractorProviders: () => [] }));
vi.mock('@/lib/server/provider-config', () => ({
  getServerPDFProviders: () => Object.fromEntries([...config.managed].map((id) => [id, {}])),
  isServerConfiguredProvider: (_section: string, id: string) => config.managed.has(id),
  resolvePDFApiKey: (id: string, key?: string) =>
    config.managed.has(id) ? config.keys.get(id) || '' : key || '',
  resolvePDFBaseUrl: (id: string, url?: string) =>
    config.managed.has(id) ? config.urls.get(id) : url,
  resolveManagedAliDocMindCredentials: config.ali,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: config.validateUrl }));

import { extractTeacherAnalysisSources } from '@/lib/server/teacher/analysis-sources';
import type { DocumentExtractorProvider } from '@/lib/document';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';
import type { CreateTeacherAnalysis } from '@/lib/teacher/analysis';
import { textDocumentExtractorProvider } from '@/lib/document/extractors/text';

const id1 = 'mat_00000000000000000000000001';
const id2 = 'mat_00000000000000000000000002';
const input: CreateTeacherAnalysis = {
  requestId: 'a2dc1b08-e25a-419c-a3f4-60a5f99117ff',
  workKind: 'homework',
  subject: 'math',
  title: 'Fictional homework',
  workDate: '2026-09-08',
  teacherNotes: '',
  materials: [{ materialId: id1, role: 'student_work' }],
};
const request = (headers?: HeadersInit) =>
  new NextRequest('http://localhost/api/teacher/analysis', { headers });
const asset = (mimeType = 'text/plain', id = id1): VerifiedOwnerMaterialAsset =>
  ({
    ownerMaterialId: id,
    bytes: Buffer.from('Fictional work'),
    byteLength: 14,
    sha256: 'a'.repeat(64),
    mimeType,
    record: { originalName: 'fictional.txt' },
  }) as VerifiedOwnerMaterialAsset;
function provider(
  id = 'plain-text',
  text = 'Question 1: 2 + 2 = 4',
  ocr = false,
): DocumentExtractorProvider {
  return {
    id,
    displayName: id,
    version: 'fixture-v1',
    supportedMimeTypes: ['text/plain', 'application/pdf', 'image/png'],
    capabilities: {
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr,
      async: false,
    },
    extract: vi.fn().mockResolvedValue({
      metadata: { providerId: id },
      blocks: [{ id: 'original', text, type: 'text', pageNumber: 2 }],
      assets: [],
    }),
  };
}
function capture(...assets: VerifiedOwnerMaterialAsset[]) {
  return vi.fn().mockResolvedValue({ ok: true, assets });
}

describe('teacher analysis sources', () => {
  beforeEach(() => {
    config.managed.clear();
    config.keys.clear();
    config.urls.clear();
    vi.clearAllMocks();
    config.validateUrl.mockResolvedValue(null);
    config.ali.mockReturnValue(undefined);
  });

  it('uses owned verified bytes and preserves source hashes and actual page anchors', async () => {
    const plain = provider();
    const captureSources = capture(asset());
    const result = await extractTeacherAnalysisSources(
      request(),
      'owner-fixture',
      input,
      undefined,
      { captureSources, providers: () => [plain] },
    );
    expect(captureSources).toHaveBeenCalledWith(
      'owner-fixture',
      [id1],
      expect.objectContaining({ allowedMimeTypes: expect.any(Set) }),
    );
    expect(result[0]).toMatchObject({
      sourceId: 's1',
      materialId: id1,
      role: 'student_work',
      sha256: 'a'.repeat(64),
      extractorId: 'plain-text',
      extractorVersion: 'fixture-v1',
      ocr: false,
      blocks: [{ blockId: 'b1', pageNumber: 2, text: 'Question 1: 2 + 2 = 4' }],
    });
    expect(plain.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from('Fictional work'),
        config: { providerId: 'plain-text', textOnly: true },
      }),
    );
  });

  it('extracts fictional Chinese work with the real existing plain-text provider', async () => {
    const text = '虚构学生练习：2x = 6，作答 x = 4。';
    const bytes = Buffer.from(text);
    const result = await extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
      captureSources: capture({ ...asset(), bytes, byteLength: bytes.byteLength }),
      providers: () => [textDocumentExtractorProvider],
    });
    expect(result[0]!.blocks).toEqual([{ blockId: 'b1', text }]);
    expect(result[0]!.ocr).toBe(false);
  });

  it('reads CSV as native text without requiring OCR', async () => {
    const text = 'question,response\n2+2,4';
    const bytes = Buffer.from(text);
    const result = await extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
      captureSources: capture({ ...asset('text/csv'), bytes, byteLength: bytes.byteLength }),
      providers: () => [textDocumentExtractorProvider],
    });
    expect(result[0]).toMatchObject({
      mimeType: 'text/csv',
      ocr: false,
      blocks: [{ blockId: 'b1', text }],
    });
  });

  it('refuses missing or foreign material without extracting any bytes', async () => {
    const plain = provider();
    await expect(
      extractTeacherAnalysisSources(request(), 'other-owner', input, undefined, {
        captureSources: vi.fn().mockResolvedValue({ ok: false, reason: 'unavailable' }),
        providers: () => [plain],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_INVALID' });
    expect(plain.extract).not.toHaveBeenCalled();
  });

  it('uses the existing local PDF extractor with true page/block identifiers', async () => {
    const extractPdf = vi.fn().mockResolvedValue({
      pages: [{ pageNumber: 3, blocks: [{ blockIndex: 0, text: 'Fictional answer 2 + 2 = 4' }] }],
    });
    const sources = await extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
      captureSources: capture(asset('application/pdf')),
      extractPdf,
    });
    expect(sources[0]).toMatchObject({ ocr: false, blocks: [{ blockId: 'p3b1', pageNumber: 3 }] });
    expect(extractPdf).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSnapshotFingerprint: 'a'.repeat(64), examDocumentId: id1 }),
    );
  });

  it('requires configured OCR for scanned PDFs and never pretends a text cover represents blank answer pages', async () => {
    const extractPdf = vi.fn().mockResolvedValue({
      pages: [
        { pageNumber: 1, blocks: [{ blockIndex: 0, text: 'Fictional cover page' }] },
        { pageNumber: 2, blocks: [] },
      ],
    });
    await expect(
      extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
        captureSources: capture(asset('application/pdf')),
        extractPdf,
        providers: () => [provider('mineru', 'OCR', true)],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_OCR_REQUIRED' });
  });

  it('routes photographs through the explicitly selected OCR provider and validates client URL', async () => {
    const ocr = provider('mineru', 'Fictional handwritten work', true);
    const result = await extractTeacherAnalysisSources(
      request({ 'x-pdf-provider': 'mineru', 'x-pdf-base-url': 'https://ocr.example.invalid' }),
      'owner',
      input,
      undefined,
      { captureSources: capture(asset('image/png')), providers: () => [ocr] },
    );
    expect(result[0]).toMatchObject({ extractorId: 'mineru', ocr: true });
    expect(config.validateUrl).toHaveBeenCalledWith('https://ocr.example.invalid');
  });

  it('uses configured OCR after the existing PDF extractor identifies a missing text layer', async () => {
    config.managed.add('mineru');
    config.urls.set('mineru', 'http://trusted-ocr.internal');
    const ocr = provider('mineru', 'Fictional OCR response: x = 4', true);
    const result = await extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
      captureSources: capture(asset('application/pdf')),
      extractPdf: vi.fn().mockRejectedValue({ code: 'EXAM_TEXT_EXTRACTION_UNAVAILABLE' }),
      providers: () => [ocr],
    });
    expect(result[0]).toMatchObject({
      ocr: true,
      extractorId: 'mineru',
      extractorVersion: 'fixture-v1',
    });
  });

  it('rejects unsafe unmanaged OCR URLs even outside production', async () => {
    config.validateUrl.mockResolvedValue('private network');
    const ocr = provider('mineru', 'OCR', true);
    await expect(
      extractTeacherAnalysisSources(
        request({ 'x-pdf-provider': 'mineru', 'x-pdf-base-url': 'http://127.0.0.1/internal' }),
        'owner',
        input,
        undefined,
        { captureSources: capture(asset('image/png')), providers: () => [ocr] },
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_INVALID' });
    expect(ocr.extract).not.toHaveBeenCalled();
  });

  it('keeps managed OCR credentials authoritative and off the returned sources', async () => {
    config.managed.add('mineru');
    config.keys.set('mineru', 'SERVER_SECRET_CANARY');
    config.urls.set('mineru', 'http://trusted-ocr.internal');
    const ocr = provider('mineru', 'Fictional work', true);
    const result = await extractTeacherAnalysisSources(
      request({
        'x-pdf-provider': 'mineru',
        'x-pdf-api-key': 'CLIENT_SECRET_CANARY',
        'x-pdf-base-url': 'http://attacker.invalid',
      }),
      'owner',
      input,
      undefined,
      { captureSources: capture(asset('image/png')), providers: () => [ocr] },
    );
    expect(ocr.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          apiKey: 'SERVER_SECRET_CANARY',
          baseUrl: 'http://trusted-ocr.internal',
          allowEnvFallback: true,
        }),
      }),
    );
    expect(config.validateUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/SECRET_CANARY|baseUrl|trusted-ocr/);
  });

  it('does not silently substitute a cloud provider for an unconfigured self-hosted selection', async () => {
    config.managed.add('mineru-cloud');
    config.keys.set('mineru-cloud', 'SERVER_CLOUD_CANARY');
    const cloud = provider('mineru-cloud', 'OCR', true);
    await expect(
      extractTeacherAnalysisSources(
        request({ 'x-pdf-provider': 'mineru', 'x-pdf-api-key': 'CLIENT_SECRET_CANARY' }),
        'owner',
        input,
        undefined,
        {
          captureSources: capture(asset('image/png')),
          providers: () => [provider('mineru', 'OCR', true), cloud],
        },
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_OCR_REQUIRED' });
    expect(cloud.extract).not.toHaveBeenCalled();
  });

  it('maps extractor errors to a safe code without provider diagnostics', async () => {
    const plain = provider();
    vi.mocked(plain.extract).mockRejectedValue(new Error('PRIVATE_KEY_CANARY provider diagnostic'));
    await expect(
      extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
        captureSources: capture(asset()),
        providers: () => [plain],
      }),
    ).rejects.toMatchObject({
      code: 'ANALYSIS_EXTRACTION_FAILED',
      message: 'ANALYSIS_EXTRACTION_FAILED',
    });
  });

  it('rejects the combined 40k text overflow rather than truncating sources', async () => {
    const plain = provider('plain-text', 'x'.repeat(20_001));
    await expect(
      extractTeacherAnalysisSources(
        request(),
        'owner',
        { ...input, materials: [...input.materials, { materialId: id2, role: 'answer_key' }] },
        undefined,
        { captureSources: capture(asset(), asset('text/plain', id2)), providers: () => [plain] },
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_TOO_LARGE' });
  });

  it('checks cancellation again after an extractor finishes', async () => {
    const controller = new AbortController();
    const plain = provider();
    vi.mocked(plain.extract).mockImplementation(async () => {
      controller.abort();
      return { metadata: {}, blocks: [{ id: '1', type: 'text', text: 'answer' }], assets: [] };
    });
    await expect(
      extractTeacherAnalysisSources(request(), 'owner', input, controller.signal, {
        captureSources: capture(asset()),
        providers: () => [plain],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CANCELED' });
  });

  it('refuses oversized verified files before extraction', async () => {
    const plain = provider();
    await expect(
      extractTeacherAnalysisSources(request(), 'owner', input, undefined, {
        captureSources: capture({ ...asset(), byteLength: 21 * 1024 * 1024 }),
        providers: () => [plain],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_TOO_LARGE' });
    expect(plain.extract).not.toHaveBeenCalled();
  });
});
