import type { NextRequest } from 'next/server';

import {
  getDocumentExtractorProviders,
  type DocumentArtifact,
  type DocumentExtractorConfig,
  type DocumentExtractorProvider,
} from '@/lib/document';
import {
  getServerPDFProviders,
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  resolveOwnedReadyMaterialAssetsForSnapshot,
  type VerifiedOwnerMaterialAsset,
} from '@/lib/server/materials/owner-assets';
import { extractExamPdfTextArtifact } from '@/lib/server/zhongkao/exam-pdf-text-extractor';
import {
  EXAM_PDF_EXTRACTOR_ID,
  EXAM_PDF_EXTRACTOR_VERSION,
} from '@/lib/zhongkao/exam-document-artifact';
import {
  analysisSourceSchema,
  createTeacherAnalysisSchema,
  TEACHER_ANALYSIS_MAX_SOURCE_CHARS,
  TeacherAnalysisError,
  type CreateTeacherAnalysis,
  type TeacherAnalysisSource,
} from '@/lib/teacher/analysis';

const ALLOWED_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface TeacherAnalysisSourceDependencies {
  captureSources?: typeof resolveOwnedReadyMaterialAssetsForSnapshot;
  providers?: () => DocumentExtractorProvider[];
  extractPdf?: typeof extractExamPdfTextArtifact;
}

export function assertTeacherAnalysisActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TeacherAnalysisError('ANALYSIS_CANCELED');
}

async function ocrConfig(
  req: NextRequest,
  provider: DocumentExtractorProvider,
): Promise<DocumentExtractorConfig | undefined> {
  const managed = isServerConfiguredProvider('pdf', provider.id);
  const selected = req.headers.get('x-pdf-provider') === provider.id;
  if (!managed && !selected) return undefined;
  const clientBaseUrl = managed ? undefined : req.headers.get('x-pdf-base-url') || undefined;
  if (clientBaseUrl && (await validateUrlForSSRF(clientBaseUrl))) {
    throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
  }
  const ali =
    managed && provider.id === 'alidocmind' ? resolveManagedAliDocMindCredentials() : undefined;
  const config: DocumentExtractorConfig = {
    providerId: provider.id,
    apiKey:
      resolvePDFApiKey(
        provider.id,
        managed ? undefined : req.headers.get('x-pdf-api-key') || undefined,
      ) || undefined,
    baseUrl: ali?.baseUrl ?? resolvePDFBaseUrl(provider.id, clientBaseUrl),
    accessKeyId: managed ? ali?.accessKeyId : req.headers.get('x-pdf-access-key-id') || undefined,
    accessKeySecret: managed
      ? ali?.accessKeySecret
      : req.headers.get('x-pdf-access-key-secret') || undefined,
    allowEnvFallback: managed,
    textOnly: true,
  };
  if (provider.id === 'mineru' && !config.baseUrl) return undefined;
  if (provider.id === 'mineru-cloud' && !config.apiKey) return undefined;
  if (provider.id === 'alidocmind' && (!config.accessKeyId || !config.accessKeySecret))
    return undefined;
  return config;
}

function sourceBlocks(artifact: DocumentArtifact): TeacherAnalysisSource['blocks'] {
  const blocks = artifact.blocks
    .filter((block) => typeof block.text === 'string' && block.text.trim().length > 0)
    .map((block, index) => ({
      blockId: `b${index + 1}`,
      text: block.text!.trim(),
      ...(Number.isSafeInteger(block.pageNumber) && block.pageNumber! > 0
        ? { pageNumber: block.pageNumber }
        : {}),
    }));
  if (blocks.length > 500) throw new TeacherAnalysisError('ANALYSIS_INPUT_TOO_LARGE');
  return blocks;
}

async function extractSource(
  req: NextRequest,
  asset: VerifiedOwnerMaterialAsset,
  signal: AbortSignal | undefined,
  deps: TeacherAnalysisSourceDependencies,
): Promise<Pick<TeacherAnalysisSource, 'blocks' | 'extractorId' | 'extractorVersion' | 'ocr'>> {
  assertTeacherAnalysisActive(signal);
  if (asset.mimeType === 'application/pdf') {
    try {
      // The existing exam extractor retains real page anchors and enforces PDF resource bounds.
      const pdf = await (deps.extractPdf ?? extractExamPdfTextArtifact)({
        examSessionId: 'teacher-analysis-extraction',
        examDocumentId: asset.ownerMaterialId,
        sourceSnapshotFingerprint: asset.sha256,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
      });
      assertTeacherAnalysisActive(signal);
      const blocks = pdf.pages.flatMap((page) =>
        page.blocks.flatMap((block) =>
          typeof block.text === 'string' && block.text.trim()
            ? [
                {
                  blockId: `p${page.pageNumber}b${block.blockIndex + 1}`,
                  text: block.text,
                  pageNumber: page.pageNumber,
                },
              ]
            : [],
        ),
      );
      // Mixed scanned/text PDFs need OCR too: a text-bearing cover cannot stand in for answer pages.
      if (
        pdf.pages.every((page) =>
          page.blocks.some((block) => (block.text?.trim().length ?? 0) >= 8),
        )
      ) {
        if (blocks.length > 500) throw new TeacherAnalysisError('ANALYSIS_INPUT_TOO_LARGE');
        return {
          blocks,
          extractorId: EXAM_PDF_EXTRACTOR_ID,
          extractorVersion: EXAM_PDF_EXTRACTOR_VERSION,
          ocr: false,
        };
      }
    } catch (error) {
      assertTeacherAnalysisActive(signal);
      if (error instanceof TeacherAnalysisError) throw error;
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EXAM_TEXT_EXTRACTION_UNAVAILABLE'
        )
      ) {
        throw new TeacherAnalysisError('ANALYSIS_EXTRACTION_FAILED');
      }
    }
  }

  const providers = (deps.providers ?? getDocumentExtractorProviders)();
  const plain = asset.mimeType.startsWith('text/')
    ? providers.find(
        (provider) =>
          provider.id === 'plain-text' &&
          (asset.mimeType === 'text/csv' || provider.supportedMimeTypes.includes(asset.mimeType)),
      )
    : undefined;
  let selected = plain;
  let config: DocumentExtractorConfig | undefined = plain
    ? { providerId: plain.id, textOnly: true }
    : undefined;
  if (!selected) {
    const requestedId = req.headers.get('x-pdf-provider');
    const requestedOcr = providers.find(
      (provider) => provider.id === requestedId && provider.capabilities.ocr,
    );
    const configured = new Set(Object.keys(getServerPDFProviders()));
    const candidates = providers.filter(
      (provider) =>
        provider.capabilities.ocr &&
        provider.supportedMimeTypes.includes(asset.mimeType) &&
        (requestedOcr ? provider.id === requestedOcr.id : configured.has(provider.id)),
    );
    candidates.sort(
      (left, right) => Number(right.id === requestedId) - Number(left.id === requestedId),
    );
    for (const provider of candidates) {
      config = await ocrConfig(req, provider);
      if (config) {
        selected = provider;
        break;
      }
    }
  }
  if (!selected || !config) throw new TeacherAnalysisError('ANALYSIS_OCR_REQUIRED');
  let artifact: DocumentArtifact;
  try {
    artifact = await selected.extract({
      buffer: asset.bytes,
      fileName: asset.record.originalName ?? undefined,
      fileSize: asset.byteLength,
      // CSV is read verbatim through the text extractor; source metadata retains its original MIME.
      mimeType:
        asset.mimeType === 'text/csv' && selected.id === 'plain-text'
          ? 'text/plain'
          : asset.mimeType,
      config,
    });
  } catch {
    assertTeacherAnalysisActive(signal);
    throw new TeacherAnalysisError('ANALYSIS_EXTRACTION_FAILED');
  }
  assertTeacherAnalysisActive(signal);
  const blocks = sourceBlocks(artifact);
  if (blocks.length === 0) throw new TeacherAnalysisError('ANALYSIS_EXTRACTION_FAILED');
  return {
    blocks,
    extractorId: selected.id,
    extractorVersion: selected.version,
    ocr: selected.capabilities.ocr,
  };
}

export async function extractTeacherAnalysisSources(
  req: NextRequest,
  ownerId: string,
  input: CreateTeacherAnalysis,
  signal?: AbortSignal,
  deps: TeacherAnalysisSourceDependencies = {},
): Promise<TeacherAnalysisSource[]> {
  assertTeacherAnalysisActive(signal);
  const parsed = createTeacherAnalysisSchema.safeParse(input);
  if (!parsed.success) throw new TeacherAnalysisError('ANALYSIS_INPUT_INVALID');
  let capture: Awaited<ReturnType<typeof resolveOwnedReadyMaterialAssetsForSnapshot>>;
  try {
    capture = await (deps.captureSources ?? resolveOwnedReadyMaterialAssetsForSnapshot)(
      ownerId,
      input.materials.map((material) => material.materialId),
      { allowedMimeTypes: ALLOWED_MIMES },
    );
  } catch {
    assertTeacherAnalysisActive(signal);
    throw new TeacherAnalysisError('ANALYSIS_SOURCE_INVALID');
  }
  assertTeacherAnalysisActive(signal);
  if (!capture.ok) throw new TeacherAnalysisError('ANALYSIS_SOURCE_INVALID');
  if (
    capture.assets.reduce((total, asset) => total + asset.byteLength, 0) > MAX_TOTAL_BYTES ||
    capture.assets.some((asset) => asset.byteLength > MAX_FILE_BYTES)
  ) {
    throw new TeacherAnalysisError('ANALYSIS_INPUT_TOO_LARGE');
  }
  const sources: TeacherAnalysisSource[] = [];
  let totalChars = 0;
  for (const [index, material] of input.materials.entries()) {
    const asset = capture.assets.find((item) => item.ownerMaterialId === material.materialId);
    if (!asset || !ALLOWED_MIMES.has(asset.mimeType))
      throw new TeacherAnalysisError('ANALYSIS_SOURCE_INVALID');
    const extracted = await extractSource(req, asset, signal, deps);
    totalChars += extracted.blocks.reduce((total, block) => total + block.text.length, 0);
    if (totalChars > TEACHER_ANALYSIS_MAX_SOURCE_CHARS)
      throw new TeacherAnalysisError('ANALYSIS_INPUT_TOO_LARGE');
    const source = analysisSourceSchema.safeParse({
      sourceId: `s${index + 1}`,
      materialId: material.materialId,
      role: material.role,
      name: asset.record.originalName || material.materialId,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      ...extracted,
    });
    if (!source.success) throw new TeacherAnalysisError('ANALYSIS_EXTRACTION_FAILED');
    sources.push(source.data);
  }
  return sources;
}
