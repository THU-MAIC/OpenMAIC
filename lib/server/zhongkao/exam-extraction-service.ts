import { createHash } from 'node:crypto';

import {
  examDocumentArtifactObjectKey,
  examQuestionCandidatesObjectKey,
} from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type { PublicExamSession } from '@/lib/zhongkao/exam';
import {
  EXAM_DOCUMENT_NORMALIZATION_VERSION,
  EXAM_EXTRACTION_VERSION,
  EXAM_PDF_EXTRACTOR_ID,
  EXAM_PDF_EXTRACTOR_VERSION,
  parseExamDocumentArtifact,
  serializeExamDocumentArtifact,
  type ExamDocumentArtifactV1,
} from '@/lib/zhongkao/exam-document-artifact';
import { ExamError, isExamError, type ExamErrorCode } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamDocumentArtifactExtractedEvent,
  type ExamQuestionCandidatesExtractedEvent,
  type ExamQuestionExtractionStartedEvent,
  type ExamQuestionSegmentationStartedEvent,
} from '@/lib/zhongkao/exam-event';
import {
  EXAM_QUESTION_SEGMENTATION_VERSION,
  parseExamQuestionCandidatesArtifact,
  segmentExamQuestionCandidates,
  serializeExamQuestionCandidatesArtifact,
  type ExamQuestionCandidatesArtifactV1,
} from '@/lib/zhongkao/exam-question-candidate';
import { toPublicExamSession, type ExamDocumentState } from '@/lib/zhongkao/exam-state';

import { resolveExamDocumentSnapshotFromRuntime, type ExamServiceDeps } from './exam-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamCandidateArtifactRef,
  deriveExamDocumentArtifactExtractedOperationId,
  deriveExamDocumentArtifactRef,
  deriveExamEventId,
  deriveExamQuestionCandidatesExtractedOperationId,
  deriveExamQuestionExtractionStartedOperationId,
  deriveExamQuestionSegmentationStartedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import { extractExamPdfTextArtifact } from './exam-pdf-text-extractor';

export interface ExtractExamQuestionCandidatesResult {
  exam: PublicExamSession;
  replayed: boolean;
}

export interface ResolvedExamQuestionExtraction {
  documentArtifact: ExamDocumentArtifactV1;
  questionCandidates: ExamQuestionCandidatesArtifactV1;
}

function serviceNow(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function questionPaper(snapshot: ExamRuntimeSnapshot): ExamDocumentState {
  const matches = snapshot.state.documents.filter((document) => document.role === 'question_paper');
  if (matches.length !== 1 || !matches[0]!.snapshot) {
    throw new ExamError('EXAM_QUESTION_PAPER_NOT_FOUND');
  }
  if (matches[0]!.mimeType !== 'application/pdf') {
    throw new ExamError('EXAM_QUESTION_PAPER_UNSUPPORTED');
  }
  return matches[0]!;
}

function missingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  failure: ExamErrorCode,
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (missingObject(error)) return undefined;
    throw new ExamError(failure);
  }
}

async function putAndVerifyExpected(
  deps: ExamServiceDeps,
  key: string,
  expected: Buffer,
  failure: ExamErrorCode,
): Promise<void> {
  const existing = await readOptionalObject(deps, key, failure);
  if (existing) {
    if (!existing.equals(expected)) throw new ExamError('EXAM_EXTRACTION_CONFLICT');
    return;
  }

  try {
    await deps.byteStore.put(key, expected, 'application/json');
  } catch {
    const recovered = await readOptionalObject(deps, key, failure).catch(() => undefined);
    if (!recovered) throw new ExamError(failure);
    if (!recovered.equals(expected)) throw new ExamError('EXAM_EXTRACTION_CONFLICT');
  }

  const readBack = await readOptionalObject(deps, key, failure);
  if (!readBack || !readBack.equals(expected)) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
}

async function appendEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event:
    | ExamQuestionExtractionStartedEvent
    | ExamDocumentArtifactExtractedEvent
    | ExamQuestionSegmentationStartedEvent
    | ExamQuestionCandidatesExtractedEvent,
  failure: ExamErrorCode,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event,
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError(failure);
  }
}

function extractionStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
): ExamQuestionExtractionStartedEvent {
  const documentArtifactRef = deriveExamDocumentArtifactRef(
    snapshot.state.examSessionId,
    document.examDocumentId,
    EXAM_EXTRACTION_VERSION,
  );
  const operationId = deriveExamQuestionExtractionStartedOperationId(
    snapshot.state.examSessionId,
    document.examDocumentId,
    EXAM_EXTRACTION_VERSION,
  );
  const facts = {
    action: 'exam_question_extraction_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    extractionVersion: EXAM_EXTRACTION_VERSION,
    examDocumentId: document.examDocumentId,
    sourceSnapshotFingerprint: document.sourceSha256,
    extractorId: EXAM_PDF_EXTRACTOR_ID,
    extractorVersion: EXAM_PDF_EXTRACTOR_VERSION,
    normalizationVersion: EXAM_DOCUMENT_NORMALIZATION_VERSION,
    documentArtifactRef,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_question_extraction_started',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    extractionVersion: facts.extractionVersion,
    examDocumentId: facts.examDocumentId,
    sourceSnapshotFingerprint: facts.sourceSnapshotFingerprint,
    extractorId: facts.extractorId,
    extractorVersion: facts.extractorVersion,
    normalizationVersion: facts.normalizationVersion,
    documentArtifactRef: facts.documentArtifactRef,
  };
}

function documentArtifactEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  bytes: Buffer,
  artifact: ExamDocumentArtifactV1,
): ExamDocumentArtifactExtractedEvent {
  const extraction = snapshot.state.questionExtraction;
  if (!extraction) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  const operationId = deriveExamDocumentArtifactExtractedOperationId(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
  );
  const facts = {
    action: 'exam_document_artifact_extracted',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    extractionVersion: extraction.extractionVersion,
    examDocumentId: extraction.examDocumentId,
    sourceSnapshotFingerprint: extraction.sourceSnapshotFingerprint,
    extractorId: extraction.extractorId,
    extractorVersion: extraction.extractorVersion,
    normalizationVersion: extraction.normalizationVersion,
    documentArtifactRef: extraction.documentArtifactRef,
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    pageCount: artifact.pageCount,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_document_artifact_extracted',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    extractionVersion: facts.extractionVersion,
    examDocumentId: facts.examDocumentId,
    sourceSnapshotFingerprint: facts.sourceSnapshotFingerprint,
    extractorId: facts.extractorId,
    extractorVersion: facts.extractorVersion,
    normalizationVersion: facts.normalizationVersion,
    documentArtifactRef: facts.documentArtifactRef,
    artifactByteLength: facts.artifactByteLength,
    artifactSha256: facts.artifactSha256,
    pageCount: facts.pageCount,
  };
}

function segmentationStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): ExamQuestionSegmentationStartedEvent {
  const extraction = snapshot.state.questionExtraction;
  const artifact = extraction?.documentArtifact;
  if (!extraction || !artifact) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  const candidateArtifactRef = deriveExamCandidateArtifactRef(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
    EXAM_QUESTION_SEGMENTATION_VERSION,
  );
  const operationId = deriveExamQuestionSegmentationStartedOperationId(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
    EXAM_QUESTION_SEGMENTATION_VERSION,
  );
  const facts = {
    action: 'exam_question_segmentation_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    extractionVersion: extraction.extractionVersion,
    segmentationVersion: EXAM_QUESTION_SEGMENTATION_VERSION,
    examDocumentId: extraction.examDocumentId,
    sourceArtifactFingerprint: artifact.sha256,
    documentArtifactRef: extraction.documentArtifactRef,
    candidateArtifactRef,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_question_segmentation_started',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    extractionVersion: facts.extractionVersion,
    segmentationVersion: facts.segmentationVersion,
    examDocumentId: facts.examDocumentId,
    sourceArtifactFingerprint: facts.sourceArtifactFingerprint,
    documentArtifactRef: facts.documentArtifactRef,
    candidateArtifactRef: facts.candidateArtifactRef,
  };
}

function candidatesExtractedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  bytes: Buffer,
  artifact: ExamQuestionCandidatesArtifactV1,
): ExamQuestionCandidatesExtractedEvent {
  const extraction = snapshot.state.questionExtraction;
  const segmentation = extraction?.segmentation;
  if (!extraction || !segmentation) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  const operationId = deriveExamQuestionCandidatesExtractedOperationId(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
    segmentation.segmentationVersion,
  );
  const facts = {
    action: 'exam_question_candidates_extracted',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    extractionVersion: extraction.extractionVersion,
    segmentationVersion: segmentation.segmentationVersion,
    examDocumentId: extraction.examDocumentId,
    sourceArtifactFingerprint: segmentation.sourceArtifactFingerprint,
    documentArtifactRef: extraction.documentArtifactRef,
    candidateArtifactRef: segmentation.candidateArtifactRef,
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    candidateCount: artifact.candidateCount,
    needsReview: artifact.needsReview,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_question_candidates_extracted',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    extractionVersion: facts.extractionVersion,
    segmentationVersion: facts.segmentationVersion,
    examDocumentId: facts.examDocumentId,
    sourceArtifactFingerprint: facts.sourceArtifactFingerprint,
    documentArtifactRef: facts.documentArtifactRef,
    candidateArtifactRef: facts.candidateArtifactRef,
    artifactByteLength: facts.artifactByteLength,
    artifactSha256: facts.artifactSha256,
    candidateCount: facts.candidateCount,
    needsReview: facts.needsReview,
  };
}

function assertCurrentPlan(snapshot: ExamRuntimeSnapshot, document: ExamDocumentState): void {
  const extraction = snapshot.state.questionExtraction;
  if (!extraction) return;
  const expectedDocumentRef = deriveExamDocumentArtifactRef(
    snapshot.state.examSessionId,
    document.examDocumentId,
    EXAM_EXTRACTION_VERSION,
  );
  if (
    extraction.extractionVersion !== EXAM_EXTRACTION_VERSION ||
    extraction.examDocumentId !== document.examDocumentId ||
    extraction.sourceSnapshotFingerprint !== document.sourceSha256 ||
    extraction.extractorId !== EXAM_PDF_EXTRACTOR_ID ||
    extraction.extractorVersion !== EXAM_PDF_EXTRACTOR_VERSION ||
    extraction.normalizationVersion !== EXAM_DOCUMENT_NORMALIZATION_VERSION ||
    extraction.documentArtifactRef !== expectedDocumentRef
  ) {
    throw new ExamError('EXAM_EXTRACTION_CONFLICT');
  }
  const segmentation = extraction.segmentation;
  if (!segmentation) return;
  const expectedCandidateRef = deriveExamCandidateArtifactRef(
    snapshot.state.examSessionId,
    document.examDocumentId,
    EXAM_EXTRACTION_VERSION,
    EXAM_QUESTION_SEGMENTATION_VERSION,
  );
  if (
    segmentation.segmentationVersion !== EXAM_QUESTION_SEGMENTATION_VERSION ||
    segmentation.candidateArtifactRef !== expectedCandidateRef ||
    segmentation.sourceArtifactFingerprint !== extraction.documentArtifact?.sha256
  ) {
    throw new ExamError('EXAM_EXTRACTION_CONFLICT');
  }
}

async function resolveDocumentArtifactFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ExamDocumentArtifactV1> {
  const extraction = snapshot.state.questionExtraction;
  const fact = extraction?.documentArtifact;
  if (!extraction || !fact) throw new ExamError('EXAM_EXTRACTION_NOT_READY');
  const key = examDocumentArtifactObjectKey(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
  );
  const bytes = await readOptionalObject(deps, key, 'EXAM_EXTRACTION_CORRUPT');
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  let artifact: ExamDocumentArtifactV1;
  try {
    artifact = parseExamDocumentArtifact(bytes);
  } catch {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  if (
    artifact.examSessionId !== snapshot.state.examSessionId ||
    artifact.examDocumentId !== extraction.examDocumentId ||
    artifact.sourceSnapshotFingerprint !== extraction.sourceSnapshotFingerprint ||
    artifact.pageCount !== fact.pageCount
  ) {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  return artifact;
}

/** Resolve verified candidates while the caller already owns the per-Exam mutation lock. */
export async function resolveExamQuestionCandidatesFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ExamQuestionCandidatesArtifactV1> {
  const extraction = snapshot.state.questionExtraction;
  const segmentation = extraction?.segmentation;
  const fact = segmentation?.candidateArtifact;
  if (!extraction || !segmentation || !fact) throw new ExamError('EXAM_EXTRACTION_NOT_READY');
  const key = examQuestionCandidatesObjectKey(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
    segmentation.segmentationVersion,
  );
  const bytes = await readOptionalObject(deps, key, 'EXAM_EXTRACTION_CORRUPT');
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  let artifact: ExamQuestionCandidatesArtifactV1;
  try {
    artifact = parseExamQuestionCandidatesArtifact(bytes);
  } catch {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  if (
    artifact.examSessionId !== snapshot.state.examSessionId ||
    artifact.examDocumentId !== extraction.examDocumentId ||
    artifact.segmentationVersion !== segmentation.segmentationVersion ||
    artifact.sourceArtifactFingerprint !== segmentation.sourceArtifactFingerprint ||
    artifact.candidateCount !== fact.candidateCount ||
    artifact.needsReview !== fact.needsReview
  ) {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  const documentArtifact = await resolveDocumentArtifactFromRuntime(deps, snapshot);
  assertCandidateSourceLineage(documentArtifact, artifact);
  try {
    const expectedBytes = serializeExamQuestionCandidatesArtifact(
      segmentExamQuestionCandidates({
        artifact: documentArtifact,
        examSessionId: snapshot.state.examSessionId,
        examDocumentId: extraction.examDocumentId,
      }),
    );
    if (!bytes.equals(expectedBytes)) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  } catch {
    throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  }
  return artifact;
}

function assertCandidateSourceLineage(
  documentArtifact: ExamDocumentArtifactV1,
  candidatesArtifact: ExamQuestionCandidatesArtifactV1,
): void {
  for (const candidate of candidatesArtifact.candidates) {
    const textParts: string[] = [];
    for (const span of candidate.sourceSpans) {
      const page = documentArtifact.pages[span.pageNumber - 1];
      if (
        !page ||
        page.pageNumber !== span.pageNumber ||
        span.startBlockIndex < 0 ||
        span.endBlockIndex >= page.blocks.length ||
        span.startBlockIndex > span.endBlockIndex
      ) {
        throw new ExamError('EXAM_EXTRACTION_CORRUPT');
      }
      for (let index = span.startBlockIndex; index <= span.endBlockIndex; index += 1) {
        const block = page.blocks[index]!;
        if (block.blockIndex !== index || block.text === undefined) continue;
        const start = index === span.startBlockIndex ? (span.startOffset ?? 0) : 0;
        const end =
          index === span.endBlockIndex ? (span.endOffset ?? block.text.length) : block.text.length;
        if (start < 0 || end > block.text.length || start >= end) {
          throw new ExamError('EXAM_EXTRACTION_CORRUPT');
        }
        textParts.push(block.text.slice(start, end));
      }
    }
    if (textParts.join('\n').trim() !== candidate.text) {
      throw new ExamError('EXAM_EXTRACTION_CORRUPT');
    }
  }

  for (const diagnostic of candidatesArtifact.diagnostics) {
    if (diagnostic.blockIndex !== undefined && diagnostic.pageNumber === undefined) {
      throw new ExamError('EXAM_EXTRACTION_CORRUPT');
    }
    if (diagnostic.pageNumber !== undefined) {
      const page = documentArtifact.pages[diagnostic.pageNumber - 1];
      if (!page || page.pageNumber !== diagnostic.pageNumber) {
        throw new ExamError('EXAM_EXTRACTION_CORRUPT');
      }
      if (
        diagnostic.blockIndex !== undefined &&
        (diagnostic.blockIndex < 0 || diagnostic.blockIndex >= page.blocks.length)
      ) {
        throw new ExamError('EXAM_EXTRACTION_CORRUPT');
      }
    }
  }
}

async function extractDocumentArtifactInMemory(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
): Promise<ExamDocumentArtifactV1> {
  const source = await resolveExamDocumentSnapshotFromRuntime(
    deps,
    snapshot,
    document.examDocumentId,
  );
  try {
    return await extractExamPdfTextArtifact({
      examSessionId: snapshot.state.examSessionId,
      examDocumentId: document.examDocumentId,
      sourceSnapshotFingerprint: document.sourceSha256,
      mimeType: source.mimeType,
      bytes: source.bytes,
    });
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_DOCUMENT_EXTRACTION_FAILED');
  }
}

function segmentCandidatesInMemory(
  snapshot: ExamRuntimeSnapshot,
  documentArtifact: ExamDocumentArtifactV1,
): ExamQuestionCandidatesArtifactV1 {
  try {
    const artifact = segmentExamQuestionCandidates({
      artifact: documentArtifact,
      examSessionId: snapshot.state.examSessionId,
      examDocumentId: documentArtifact.examDocumentId,
    });
    serializeExamQuestionCandidatesArtifact(artifact);
    return artifact;
  } catch {
    throw new ExamError('EXAM_QUESTION_SEGMENTATION_FAILED');
  }
}

async function ensureDocumentArtifact(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  document: ExamDocumentState,
  preparedArtifact?: ExamDocumentArtifactV1,
): Promise<{ snapshot: ExamRuntimeSnapshot; artifact: ExamDocumentArtifactV1 }> {
  if (snapshot.state.questionExtraction?.documentArtifact) {
    return { snapshot, artifact: await resolveDocumentArtifactFromRuntime(deps, snapshot) };
  }
  const artifact =
    preparedArtifact ?? (await extractDocumentArtifactInMemory(deps, snapshot, document));
  const bytes = serializeExamDocumentArtifact(artifact);
  const key = examDocumentArtifactObjectKey(
    snapshot.state.examSessionId,
    document.examDocumentId,
    EXAM_EXTRACTION_VERSION,
  );
  await putAndVerifyExpected(deps, key, bytes, 'EXAM_DOCUMENT_EXTRACTION_FAILED');
  snapshot = await appendEvent(
    deps,
    snapshot,
    documentArtifactEvent(deps, snapshot, bytes, artifact),
    'EXAM_DOCUMENT_EXTRACTION_FAILED',
  );
  return { snapshot, artifact: await resolveDocumentArtifactFromRuntime(deps, snapshot) };
}

async function ensureCandidates(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  documentArtifact: ExamDocumentArtifactV1,
  preparedArtifact?: ExamQuestionCandidatesArtifactV1,
): Promise<ExamRuntimeSnapshot> {
  if (snapshot.state.questionExtraction?.segmentation?.candidateArtifact) {
    await resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
    return snapshot;
  }
  const artifact = preparedArtifact ?? segmentCandidatesInMemory(snapshot, documentArtifact);
  const extraction = snapshot.state.questionExtraction;
  const segmentation = extraction?.segmentation;
  if (!extraction || !segmentation) throw new ExamError('EXAM_EXTRACTION_CORRUPT');
  let bytes: Buffer;
  try {
    bytes = serializeExamQuestionCandidatesArtifact(artifact);
  } catch {
    throw new ExamError('EXAM_QUESTION_SEGMENTATION_FAILED');
  }
  const key = examQuestionCandidatesObjectKey(
    snapshot.state.examSessionId,
    extraction.examDocumentId,
    extraction.extractionVersion,
    segmentation.segmentationVersion,
  );
  await putAndVerifyExpected(deps, key, bytes, 'EXAM_QUESTION_SEGMENTATION_FAILED');
  snapshot = await appendEvent(
    deps,
    snapshot,
    candidatesExtractedEvent(deps, snapshot, bytes, artifact),
    'EXAM_QUESTION_SEGMENTATION_FAILED',
  );
  await resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
  return snapshot;
}

export async function extractExamQuestionCandidates(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ExtractExamQuestionCandidatesResult> {
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status === 'deleted') throw new ExamError('EXAM_NOT_FOUND');
    if (snapshot.state.status !== 'ready_for_extraction') {
      throw new ExamError('EXAM_EXTRACTION_NOT_READY');
    }
    const document = questionPaper(snapshot);
    const replayed = snapshot.state.questionExtraction?.status === 'question_candidates_ready';
    assertCurrentPlan(snapshot, document);

    let preparedDocumentArtifact: ExamDocumentArtifactV1 | undefined;
    if (!snapshot.state.questionExtraction) {
      preparedDocumentArtifact = await extractDocumentArtifactInMemory(deps, snapshot, document);
      snapshot = await appendEvent(
        deps,
        snapshot,
        extractionStartedEvent(deps, snapshot, document),
        'EXAM_DOCUMENT_EXTRACTION_FAILED',
      );
    }

    const documentResult = await ensureDocumentArtifact(
      deps,
      snapshot,
      document,
      preparedDocumentArtifact,
    );
    snapshot = documentResult.snapshot;
    let preparedCandidates: ExamQuestionCandidatesArtifactV1 | undefined;
    if (!snapshot.state.questionExtraction?.segmentation) {
      preparedCandidates = segmentCandidatesInMemory(snapshot, documentResult.artifact);
      snapshot = await appendEvent(
        deps,
        snapshot,
        segmentationStartedEvent(deps, snapshot),
        'EXAM_QUESTION_SEGMENTATION_FAILED',
      );
    }
    snapshot = await ensureCandidates(deps, snapshot, documentResult.artifact, preparedCandidates);
    if (snapshot.state.questionExtraction?.status !== 'question_candidates_ready') {
      throw new ExamError('EXAM_EXTRACTION_CORRUPT');
    }
    return { exam: toPublicExamSession(snapshot.state), replayed };
  });
}

export async function resolveExamDocumentArtifact(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ExamDocumentArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    return resolveDocumentArtifactFromRuntime(deps, snapshot);
  });
}

export async function resolveExamQuestionCandidates(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ExamQuestionCandidatesArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    return resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
  });
}

export async function resolveExamQuestionExtraction(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ResolvedExamQuestionExtraction> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    return {
      documentArtifact: await resolveDocumentArtifactFromRuntime(deps, snapshot),
      questionCandidates: await resolveExamQuestionCandidatesFromRuntime(deps, snapshot),
    };
  });
}
