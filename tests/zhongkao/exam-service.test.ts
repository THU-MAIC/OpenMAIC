import { createHash } from 'node:crypto';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import {
  createExam,
  deleteExam,
  getExam,
  resolveExamDocumentSnapshot,
  type ExamServiceDeps,
} from '@/lib/server/zhongkao/exam-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamDocumentId,
  deriveExamEventId,
  deriveExamHumanReviewArtifactRef,
  deriveExamHumanReviewRef,
  deriveExamHumanReviewStartedOperationId,
  deriveExamSessionId,
  examRuntimeSessionId,
  loadExamRuntime,
} from '@/lib/server/zhongkao/exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  examHumanReviewObjectKey,
  examSnapshotObjectKey,
} from '@/lib/server/materials/object-keys';
import type { ExamEvent, ExamHumanReviewStartedEvent } from '@/lib/zhongkao/exam-event';
import { extractExamQuestionCandidates } from '@/lib/server/zhongkao/exam-extraction-service';
import { captureExamStudentResponses } from '@/lib/server/zhongkao/exam-response-service';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile, zhongkaoStageId } from '@/lib/zhongkao/runtime';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';

const NOW = '2026-08-31T08:00:00.000Z';
const OWNER_A = 'fictional-owner-alpha';
const OWNER_B = 'fictional-owner-beta';
const PROFILE_A = 'student-alpha';
const PROFILE_B = 'student-beta';
const MATERIAL_IDS = {
  question_paper: `mat_${'0'.repeat(26)}`,
  student_response: `mat_${'1'.repeat(26)}`,
  answer_key: `mat_${'2'.repeat(26)}`,
} as const;

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inputBytes(body: MaterialByteInput): Buffer {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('test byte store accepts buffered Exam sources only');
}

class FakeExamByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: string[] = [];
  readonly getCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  readonly deletePrefixCalls: string[] = [];
  failPutOnCall?: number;
  commitThenThrowPutOnCall?: number;
  corruptPutOnCall?: number;
  failGetOnCall?: number;
  failDeleteOnCall?: number;

  async put(key: string, body: MaterialByteInput): Promise<void> {
    this.putCalls.push(key);
    const call = this.putCalls.length;
    if (call === this.failPutOnCall) {
      throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'material byte write failed');
    }
    const bytes = inputBytes(body);
    this.objects.set(key, call === this.corruptPutOnCall ? Buffer.from('corrupt') : bytes);
    if (call === this.commitThenThrowPutOnCall) {
      throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'material byte write failed');
    }
  }

  async get(key: string): Promise<Buffer> {
    this.getCalls.push(key);
    if (this.getCalls.length === this.failGetOnCall) {
      throw new MaterialByteStoreError('MATERIAL_BYTE_READ_FAILED', 'material byte read failed');
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'material bytes are unavailable');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.deleteCalls.length === this.failDeleteOnCall) {
      throw new MaterialByteStoreError(
        'MATERIAL_BYTE_DELETE_FAILED',
        'material byte deletion failed',
      );
    }
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletePrefixCalls.push(prefix);
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  resetFaults(): void {
    this.failPutOnCall = undefined;
    this.commitThenThrowPutOnCall = undefined;
    this.corruptPutOnCall = undefined;
    this.failGetOnCall = undefined;
    this.failDeleteOnCall = undefined;
  }
}

function ownerRecord(
  materialId: string,
  bytes: Buffer,
  mimeType: string,
  originalName: string,
): OwnerMaterialRecord {
  return {
    id: materialId,
    ownerId: OWNER_A,
    kind: 'source',
    derivedFrom: null,
    mime: mimeType,
    bytes: bytes.byteLength,
    originalName,
    ossKey: `private-owner-key-${materialId}`,
    sha256: sha256(bytes),
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: Date.parse(NOW),
    deletedAt: null,
  };
}

function source(
  materialId: string,
  body: string | Uint8Array,
  mimeType: string,
  originalName: string,
): VerifiedOwnerMaterialAsset {
  const bytes = Buffer.from(body);
  const record = ownerRecord(materialId, bytes, mimeType, originalName);
  return {
    record,
    bytes,
    ownerMaterialId: materialId,
    sha256: record.sha256!,
    mimeType,
    byteLength: bytes.byteLength,
  };
}

async function fictionalQuestionPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 700]);
  page.drawText(
    [
      '1. Fictional algebra question with enough native text',
      '2. Fictional geometry question with enough native text',
    ].join('\n'),
    { x: 36, y: 650, size: 12, lineHeight: 18, font },
  );
  return Buffer.from(await pdf.save());
}

function request(
  overrides: Partial<{
    clientRequestId: string;
    profileId: string;
    subjectId: string;
    title: string;
    documents: Array<{ role: string; ownerMaterialId: string }>;
  }> = {},
) {
  return {
    clientRequestId: 'exam-request-alpha',
    profileId: PROFILE_A,
    subjectId: 'math',
    title: 'Fictional practice exam',
    documents: [{ role: 'question_paper', ownerMaterialId: MATERIAL_IDS.question_paper }],
    ...overrides,
  };
}

function allDocuments() {
  return [
    { role: 'question_paper', ownerMaterialId: MATERIAL_IDS.question_paper },
    { role: 'student_response', ownerMaterialId: MATERIAL_IDS.student_response },
    { role: 'answer_key', ownerMaterialId: MATERIAL_IDS.answer_key },
  ];
}

function keyedMutex() {
  const tails = new Map<string, Promise<void>>();
  const calls: string[] = [];
  const lock: ExamServiceDeps['withExamMutationLock'] = async (key, work) => {
    calls.push(key);
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
  return { lock, calls };
}

function withAppend(
  backing: RuntimeStore,
  appendRecord: RuntimeStore['appendRecord'],
): RuntimeStore {
  return new Proxy(backing, {
    get(target, property, receiver) {
      if (property === 'appendRecord') return appendRecord;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface Harness {
  store: RuntimeStore;
  byteStore: FakeExamByteStore;
  deps: ExamServiceDeps;
  sources: Map<string, VerifiedOwnerMaterialAsset>;
  captureCalls: Array<{ ownerId: string; materialIds: readonly string[] }>;
  sourceFailure?: 'unavailable' | 'unsupported_mime' | 'integrity_failed';
  seedProfile(ownerId: string, profileId: string): Promise<void>;
}

async function harness(seedDefaultProfile = true): Promise<Harness> {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-service-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FakeExamByteStore();
  const mutex = keyedMutex();
  const sources = new Map<string, VerifiedOwnerMaterialAsset>([
    [
      MATERIAL_IDS.question_paper,
      source(
        MATERIAL_IDS.question_paper,
        'fictional question paper bytes',
        'application/pdf',
        '../fictional-question.pdf',
      ),
    ],
    [
      MATERIAL_IDS.student_response,
      source(
        MATERIAL_IDS.student_response,
        'fictional student response bytes',
        'image/png',
        'fictional-response.png',
      ),
    ],
    [
      MATERIAL_IDS.answer_key,
      source(
        MATERIAL_IDS.answer_key,
        'fictional answer key bytes',
        'text/plain',
        'fictional-key.txt',
      ),
    ],
  ]);
  const captureCalls: Array<{ ownerId: string; materialIds: readonly string[] }> = [];
  let seconds = 0;
  const result = {} as Harness;
  const deps: ExamServiceDeps = {
    store,
    ownerId: OWNER_A,
    byteStore,
    withExamMutationLock: mutex.lock,
    captureSources: async (ownerId, materialIds) => {
      captureCalls.push({ ownerId, materialIds: [...materialIds] });
      if (ownerId !== OWNER_A || result.sourceFailure) {
        return { ok: false, reason: result.sourceFailure ?? 'unavailable' };
      }
      const assets = materialIds
        .map((id) => sources.get(id))
        .filter((asset) => asset !== undefined);
      return assets.length === materialIds.length
        ? { ok: true, assets }
        : { ok: false, reason: 'unavailable' };
    },
    now: () => new Date(Date.parse(NOW) + seconds++ * 1000).toISOString(),
  };

  const seedProfile = async (ownerId: string, profileId: string) => {
    await saveStudentProfile(createInitialStudentProfile({ profileId, createdAt: NOW }), {
      store,
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(ownerId),
      now: () => NOW,
      mintRecordId: () => `profile-record-${ownerId}-${profileId}`,
    });
  };
  Object.assign(result, { store, byteStore, deps, sources, captureCalls, seedProfile });
  if (seedDefaultProfile) await seedProfile(OWNER_A, PROFILE_A);
  return result;
}

async function examRecords(h: Harness, examSessionId: string) {
  return h.store.listRecords(examRuntimeSessionId(examSessionId));
}

function expectedOperationFingerprint(event: ExamEvent): string {
  const common = {
    action: event.eventType,
    schemaVersion: event.schemaVersion,
    examSessionId: event.examSessionId,
    profileId: event.profileId,
  };
  switch (event.eventType) {
    case 'exam_created':
      return createExamOperationFingerprint({
        ...common,
        subjectId: event.subjectId,
        title: event.title,
        requestFingerprint: event.requestFingerprint,
        documentSetFingerprint: event.documentSetFingerprint,
        documents: event.documents,
      });
    case 'exam_document_snapshotted':
      return createExamOperationFingerprint({
        ...common,
        examDocumentId: event.examDocumentId,
        snapshotSha256: event.snapshotSha256,
        byteLength: event.byteLength,
      });
    case 'exam_intake_completed':
    case 'exam_delete_requested':
      return createExamOperationFingerprint({
        ...common,
        documentSetFingerprint: event.documentSetFingerprint,
      });
    case 'exam_question_extraction_started':
      return createExamOperationFingerprint({
        ...common,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
      });
    case 'exam_document_artifact_extracted':
      return createExamOperationFingerprint({
        ...common,
        extractionVersion: event.extractionVersion,
        examDocumentId: event.examDocumentId,
        sourceSnapshotFingerprint: event.sourceSnapshotFingerprint,
        extractorId: event.extractorId,
        extractorVersion: event.extractorVersion,
        normalizationVersion: event.normalizationVersion,
        documentArtifactRef: event.documentArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        pageCount: event.pageCount,
      });
    case 'exam_question_segmentation_started':
      return createExamOperationFingerprint({
        ...common,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
      });
    case 'exam_question_candidates_extracted':
      return createExamOperationFingerprint({
        ...common,
        extractionVersion: event.extractionVersion,
        segmentationVersion: event.segmentationVersion,
        examDocumentId: event.examDocumentId,
        sourceArtifactFingerprint: event.sourceArtifactFingerprint,
        documentArtifactRef: event.documentArtifactRef,
        candidateArtifactRef: event.candidateArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        candidateCount: event.candidateCount,
        needsReview: event.needsReview,
      });
    case 'exam_student_response_capture_started':
      return createExamOperationFingerprint({
        ...common,
        captureVersion: event.captureVersion,
        matchingVersion: event.matchingVersion,
        segmentationVersion: event.segmentationVersion,
        questionCandidateArtifactRef: event.questionCandidateArtifactRef,
        sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
        inputSemanticFingerprint: event.inputSemanticFingerprint,
        captureRef: event.captureRef,
        responseArtifactRef: event.responseArtifactRef,
        matchingArtifactRef: event.matchingArtifactRef,
      });
    case 'exam_response_candidates_recorded':
      return createExamOperationFingerprint({
        ...common,
        captureVersion: event.captureVersion,
        matchingVersion: event.matchingVersion,
        segmentationVersion: event.segmentationVersion,
        questionCandidateArtifactRef: event.questionCandidateArtifactRef,
        sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
        inputSemanticFingerprint: event.inputSemanticFingerprint,
        captureRef: event.captureRef,
        responseArtifactRef: event.responseArtifactRef,
        matchingArtifactRef: event.matchingArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        responseCount: event.responseCount,
      });
    case 'exam_response_matching_completed':
      return createExamOperationFingerprint({
        ...common,
        captureVersion: event.captureVersion,
        matchingVersion: event.matchingVersion,
        segmentationVersion: event.segmentationVersion,
        questionCandidateArtifactRef: event.questionCandidateArtifactRef,
        sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
        inputSemanticFingerprint: event.inputSemanticFingerprint,
        captureRef: event.captureRef,
        responseArtifactRef: event.responseArtifactRef,
        matchingArtifactRef: event.matchingArtifactRef,
        responseArtifactFingerprint: event.responseArtifactFingerprint,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        responseCount: event.responseCount,
        matchedCount: event.matchedCount,
        ambiguousCount: event.ambiguousCount,
        unmatchedCount: event.unmatchedCount,
        needsReview: event.needsReview,
      });
    case 'exam_human_review_started':
      return createExamOperationFingerprint({
        ...common,
        reviewVersion: event.reviewVersion,
        questionExtractionVersion: event.questionExtractionVersion,
        questionSegmentationVersion: event.questionSegmentationVersion,
        responseCaptureVersion: event.responseCaptureVersion,
        matchingVersion: event.matchingVersion,
        questionCandidateArtifactRef: event.questionCandidateArtifactRef,
        sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
        responseArtifactRef: event.responseArtifactRef,
        sourceResponseArtifactFingerprint: event.sourceResponseArtifactFingerprint,
        matchingArtifactRef: event.matchingArtifactRef,
        sourceMatchingArtifactFingerprint: event.sourceMatchingArtifactFingerprint,
        decisionSemanticFingerprint: event.decisionSemanticFingerprint,
        reviewArtifactRef: event.reviewArtifactRef,
      });
    case 'exam_human_review_completed':
      return createExamOperationFingerprint({
        ...common,
        reviewVersion: event.reviewVersion,
        questionExtractionVersion: event.questionExtractionVersion,
        questionSegmentationVersion: event.questionSegmentationVersion,
        responseCaptureVersion: event.responseCaptureVersion,
        matchingVersion: event.matchingVersion,
        questionCandidateArtifactRef: event.questionCandidateArtifactRef,
        sourceQuestionCandidateFingerprint: event.sourceQuestionCandidateFingerprint,
        responseArtifactRef: event.responseArtifactRef,
        sourceResponseArtifactFingerprint: event.sourceResponseArtifactFingerprint,
        matchingArtifactRef: event.matchingArtifactRef,
        sourceMatchingArtifactFingerprint: event.sourceMatchingArtifactFingerprint,
        decisionSemanticFingerprint: event.decisionSemanticFingerprint,
        reviewArtifactRef: event.reviewArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        confirmedQuestionCount: event.confirmedQuestionCount,
        confirmedResponseCount: event.confirmedResponseCount,
        confirmedMatchCount: event.confirmedMatchCount,
        rejectedQuestionCount: event.rejectedQuestionCount,
        rejectedResponseCount: event.rejectedResponseCount,
      });
    case 'exam_answer_key_started':
      return createExamOperationFingerprint({
        ...common,
        answerKeyVersion: event.answerKeyVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        answerKeySemanticFingerprint: event.answerKeySemanticFingerprint,
        answerKeyRef: event.answerKeyRef,
        answerKeyArtifactRef: event.answerKeyArtifactRef,
      });
    case 'exam_answer_key_confirmed':
      return createExamOperationFingerprint({
        ...common,
        answerKeyVersion: event.answerKeyVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        answerKeySemanticFingerprint: event.answerKeySemanticFingerprint,
        answerKeyRef: event.answerKeyRef,
        answerKeyArtifactRef: event.answerKeyArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        entryCount: event.entryCount,
        objectiveEntryCount: event.objectiveEntryCount,
        unassessedEntryCount: event.unassessedEntryCount,
      });
    case 'exam_grading_started':
      return createExamOperationFingerprint({
        ...common,
        gradingVersion: event.gradingVersion,
        gradingAlgorithmVersion: event.gradingAlgorithmVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        answerKeyVersion: event.answerKeyVersion,
        answerKeyRef: event.answerKeyRef,
        answerKeyArtifactRef: event.answerKeyArtifactRef,
        sourceAnswerKeyArtifactFingerprint: event.sourceAnswerKeyArtifactFingerprint,
        gradingRef: event.gradingRef,
        assessmentArtifactRef: event.assessmentArtifactRef,
      });
    case 'exam_grading_completed':
      return createExamOperationFingerprint({
        ...common,
        gradingVersion: event.gradingVersion,
        gradingAlgorithmVersion: event.gradingAlgorithmVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        answerKeyVersion: event.answerKeyVersion,
        answerKeyRef: event.answerKeyRef,
        answerKeyArtifactRef: event.answerKeyArtifactRef,
        sourceAnswerKeyArtifactFingerprint: event.sourceAnswerKeyArtifactFingerprint,
        gradingRef: event.gradingRef,
        assessmentArtifactRef: event.assessmentArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        assessmentCount: event.assessmentCount,
        evaluatedCount: event.evaluatedCount,
        correctCount: event.correctCount,
        incorrectCount: event.incorrectCount,
        unassessedCount: event.unassessedCount,
      });
    case 'exam_knowledge_suggestions_started':
      return createExamOperationFingerprint({
        ...common,
        generationVersion: event.generationVersion,
        subjectId: event.subjectId,
        generatorVersion: event.generatorVersion,
        candidateSchemaVersion: event.candidateSchemaVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        candidatePoolMode: event.candidatePoolMode,
        candidatePoolFingerprint: event.candidatePoolFingerprint,
        generationRef: event.generationRef,
        suggestionArtifactRef: event.suggestionArtifactRef,
      });
    case 'exam_knowledge_suggestions_completed':
      return createExamOperationFingerprint({
        ...common,
        generationVersion: event.generationVersion,
        subjectId: event.subjectId,
        generatorVersion: event.generatorVersion,
        candidateSchemaVersion: event.candidateSchemaVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        candidatePoolMode: event.candidatePoolMode,
        candidatePoolFingerprint: event.candidatePoolFingerprint,
        generationRef: event.generationRef,
        suggestionArtifactRef: event.suggestionArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        questionCount: event.questionCount,
        generatedQuestionCount: event.generatedQuestionCount,
        noSuggestionQuestionCount: event.noSuggestionQuestionCount,
        inputTooLargeQuestionCount: event.inputTooLargeQuestionCount,
        suggestionCount: event.suggestionCount,
      });
    case 'exam_knowledge_mapping_started':
      return createExamOperationFingerprint({
        ...common,
        mappingVersion: event.mappingVersion,
        subjectId: event.subjectId,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        assessmentVersion: event.assessmentVersion,
        assessmentArtifactRef: event.assessmentArtifactRef,
        sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
        sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
        mappingSemanticFingerprint: event.mappingSemanticFingerprint,
        mappingRef: event.mappingRef,
        mappingArtifactRef: event.mappingArtifactRef,
      });
    case 'exam_knowledge_mapping_confirmed':
      return createExamOperationFingerprint({
        ...common,
        mappingVersion: event.mappingVersion,
        subjectId: event.subjectId,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        assessmentVersion: event.assessmentVersion,
        assessmentArtifactRef: event.assessmentArtifactRef,
        sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
        sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
        mappingSemanticFingerprint: event.mappingSemanticFingerprint,
        mappingRef: event.mappingRef,
        mappingArtifactRef: event.mappingArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        entryCount: event.entryCount,
        mappedQuestionCount: event.mappedQuestionCount,
        unmappedQuestionCount: event.unmappedQuestionCount,
      });
    case 'exam_observation_projection_started':
      return createExamOperationFingerprint({
        ...common,
        observationVersion: event.observationVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        assessmentVersion: event.assessmentVersion,
        assessmentArtifactRef: event.assessmentArtifactRef,
        sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
        sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
        mappingVersion: event.mappingVersion,
        mappingRef: event.mappingRef,
        mappingArtifactRef: event.mappingArtifactRef,
        sourceMappingArtifactFingerprint: event.sourceMappingArtifactFingerprint,
        sourceMappingSemanticFingerprint: event.sourceMappingSemanticFingerprint,
        observationSemanticFingerprint: event.observationSemanticFingerprint,
        observationRef: event.observationRef,
        observationArtifactRef: event.observationArtifactRef,
      });
    case 'exam_observations_projected':
      return createExamOperationFingerprint({
        ...common,
        observationVersion: event.observationVersion,
        reviewVersion: event.reviewVersion,
        reviewArtifactRef: event.reviewArtifactRef,
        sourceReviewArtifactFingerprint: event.sourceReviewArtifactFingerprint,
        sourceReviewSemanticFingerprint: event.sourceReviewSemanticFingerprint,
        assessmentVersion: event.assessmentVersion,
        assessmentArtifactRef: event.assessmentArtifactRef,
        sourceAssessmentArtifactFingerprint: event.sourceAssessmentArtifactFingerprint,
        sourceAssessmentSemanticFingerprint: event.sourceAssessmentSemanticFingerprint,
        mappingVersion: event.mappingVersion,
        mappingRef: event.mappingRef,
        mappingArtifactRef: event.mappingArtifactRef,
        sourceMappingArtifactFingerprint: event.sourceMappingArtifactFingerprint,
        sourceMappingSemanticFingerprint: event.sourceMappingSemanticFingerprint,
        observationSemanticFingerprint: event.observationSemanticFingerprint,
        observationRef: event.observationRef,
        observationArtifactRef: event.observationArtifactRef,
        artifactByteLength: event.artifactByteLength,
        artifactSha256: event.artifactSha256,
        observationCount: event.observationCount,
        evaluatedCount: event.evaluatedCount,
        correctCount: event.correctCount,
        incorrectCount: event.incorrectCount,
        unassessedCount: event.unassessedCount,
      });
    case 'exam_deleted':
      return createExamOperationFingerprint({
        ...common,
        documentSetFingerprint: event.documentSetFingerprint,
        deleteRequestEventId: event.deleteRequestEventId,
      });
  }
}

describe('Exam intake service', () => {
  it('requires an owner-authorized profile before source capture', async () => {
    const h = await harness(false);
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_PROFILE_NOT_FOUND');
    expect(h.captureCalls).toHaveLength(0);

    await h.seedProfile(OWNER_A, PROFILE_A);
    await expect(createExam({ ...h.deps, ownerId: OWNER_B }, request())).rejects.toThrow(
      'EXAM_PROFILE_NOT_FOUND',
    );
    expect(h.captureCalls).toHaveLength(0);
  });

  it('freezes bytes and appends one created/snapshot/completed saga', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    expect(result).toMatchObject({
      replayed: false,
      exam: { status: 'ready_for_extraction', profileId: PROFILE_A, subjectId: 'math' },
    });
    expect(h.byteStore.objects.size).toBe(1);
    expect([...h.byteStore.objects.values()][0]).toEqual(
      h.sources.get(MATERIAL_IDS.question_paper)?.bytes,
    );
    const records = await examRecords(h, result.exam.examSessionId);
    expect(records.map((record) => (record.payload as { eventType: string }).eventType)).toEqual([
      'exam_created',
      'exam_document_snapshotted',
      'exam_intake_completed',
    ]);
    for (const record of records) {
      const event = record.payload as ExamEvent;
      expect(event.operationFingerprint).toBe(expectedOperationFingerprint(event));
      expect(
        expectedOperationFingerprint({ ...event, profileId: PROFILE_B } as ExamEvent),
      ).not.toBe(event.operationFingerprint);
    }
  });

  it('canonicalizes document order and replays without recapturing sources', async () => {
    const h = await harness();
    const reversed = request({ documents: allDocuments().toReversed() });
    const first = await createExam(h.deps, reversed);
    const replay = await createExam(h.deps, request({ documents: allDocuments() }));
    expect(replay.exam.examSessionId).toBe(first.exam.examSessionId);
    expect(replay.replayed).toBe(true);
    expect(replay.exam.documents.map((document) => document.role)).toEqual([
      'question_paper',
      'student_response',
      'answer_key',
    ]);
    expect(h.captureCalls).toHaveLength(1);
    expect(await examRecords(h, first.exam.examSessionId)).toHaveLength(5);
  });

  it('rejects a changed semantic request under the same idempotency token', async () => {
    const h = await harness();
    await createExam(h.deps, request());
    await expect(createExam(h.deps, request({ title: 'Changed title' }))).rejects.toThrow(
      'EXAM_REQUEST_CONFLICT',
    );
    await expect(
      createExam(
        h.deps,
        request({
          documents: [
            { role: 'question_paper', ownerMaterialId: MATERIAL_IDS.question_paper },
            { role: 'answer_key', ownerMaterialId: MATERIAL_IDS.answer_key },
          ],
        }),
      ),
    ).rejects.toThrow('EXAM_REQUEST_CONFLICT');
  });

  it('partitions the same request token by profile and owner', async () => {
    const h = await harness();
    await h.seedProfile(OWNER_A, PROFILE_B);
    const alpha = await createExam(h.deps, request());
    const beta = await createExam(h.deps, request({ profileId: PROFILE_B }));
    expect(beta.exam.examSessionId).not.toBe(alpha.exam.examSessionId);

    const other = await harness(false);
    await other.seedProfile(OWNER_B, PROFILE_A);
    other.deps.ownerId = OWNER_B;
    other.deps.captureSources = async (_ownerId, ids) => ({
      ok: true,
      assets: ids.map((id) => other.sources.get(id)!),
    });
    const ownerBeta = await createExam(other.deps, request());
    expect(ownerBeta.exam.examSessionId).not.toBe(alpha.exam.examSessionId);
  });

  it('serializes concurrent identical creates into one logical Exam', async () => {
    const h = await harness();
    const [left, right] = await Promise.all([
      createExam(h.deps, request()),
      createExam(h.deps, request()),
    ]);
    expect(left.exam.examSessionId).toBe(right.exam.examSessionId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(h.captureCalls).toHaveLength(1);
    const records = await examRecords(h, left.exam.examSessionId);
    expect(records).toHaveLength(3);
    expect(
      records.filter(
        (record) =>
          (record.payload as { eventType: string }).eventType === 'exam_document_snapshotted',
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent multi-document creates into one snapshot fact per role', async () => {
    const h = await harness();
    const input = request({ documents: allDocuments() });
    const [left, right] = await Promise.all([createExam(h.deps, input), createExam(h.deps, input)]);
    expect(left.exam.examSessionId).toBe(right.exam.examSessionId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(h.captureCalls).toHaveLength(1);
    expect(h.byteStore.objects.size).toBe(3);
    const records = await examRecords(h, left.exam.examSessionId);
    const snapshotEvents = records.filter(
      (record) =>
        (record.payload as { eventType?: string }).eventType === 'exam_document_snapshotted',
    );
    expect(snapshotEvents).toHaveLength(3);
    expect(
      new Set(
        snapshotEvents.map(
          (record) => (record.payload as { examDocumentId: string }).examDocumentId,
        ),
      ).size,
    ).toBe(3);
  });

  it('recovers an existing empty Exam runtime session as a replayed create', async () => {
    const h = await harness();
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const examSessionId = deriveExamSessionId({
      learnerKey,
      profileId: PROFILE_A,
      clientRequestId: request().clientRequestId,
    });
    const runtimeSessionId = examRuntimeSessionId(examSessionId);
    await h.store.createSession({
      id: runtimeSessionId,
      kind: 'zhongkaoExamEvent',
      stageId: zhongkaoStageId(PROFILE_A),
      learnerKey,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await h.store.listRecords(runtimeSessionId)).toHaveLength(0);

    const recovered = await createExam(h.deps, request());

    expect(recovered).toMatchObject({
      replayed: true,
      exam: { examSessionId, status: 'ready_for_extraction' },
    });
    expect(await examRecords(h, examSessionId)).toHaveLength(3);
  });

  it('recovers after createSession or the initial created append fails before commit', async () => {
    const createFailure = await harness();
    let createFailed = false;
    createFailure.deps.store = new Proxy(createFailure.store, {
      get(target, property, receiver) {
        if (property === 'createSession') {
          return async (...args: Parameters<RuntimeStore['createSession']>) => {
            if (!createFailed) {
              createFailed = true;
              throw new Error('create failed before commit');
            }
            return target.createSession(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(createExam(createFailure.deps, request())).rejects.toThrow(
      'EXAM_SESSION_CONFLICT',
    );
    createFailure.deps.store = createFailure.store;
    await expect(createExam(createFailure.deps, request())).resolves.toMatchObject({
      replayed: false,
      exam: { status: 'ready_for_extraction' },
    });

    const appendFailure = await harness();
    let appendFailed = false;
    appendFailure.deps.store = withAppend(appendFailure.store, async (init, options = {}) => {
      if (!appendFailed && (init.payload as { eventType?: string }).eventType === 'exam_created') {
        appendFailed = true;
        throw new Error('created append failed before commit');
      }
      return appendFailure.store.appendRecord(init, options);
    });
    await expect(createExam(appendFailure.deps, request())).rejects.toThrow(
      'EXAM_SESSION_CONFLICT',
    );
    appendFailure.deps.store = appendFailure.store;
    await expect(createExam(appendFailure.deps, request())).resolves.toMatchObject({
      replayed: true,
      exam: { status: 'ready_for_extraction' },
    });
  });

  it.each([
    ['unavailable', 'EXAM_SOURCE_UNAVAILABLE'],
    ['integrity_failed', 'EXAM_SOURCE_INTEGRITY_FAILED'],
    ['unsupported_mime', 'EXAM_INPUT_INVALID'],
  ] as const)('fails closed for a %s source capture', async (reason, code) => {
    const h = await harness();
    h.sourceFailure = reason;
    await expect(createExam(h.deps, request())).rejects.toThrow(code);
  });

  it('keeps a created plan pending after byte put failure and resumes it', async () => {
    const h = await harness();
    h.byteStore.failPutOnCall = 1;
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    const sessions = await h.store.listSessions(
      `zhongkao-profile:${PROFILE_A}`,
      resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A),
    );
    const examSession = sessions.find((session) => session.kind === 'zhongkaoExamEvent')!;
    expect(await h.store.listRecords(examSession.id)).toHaveLength(1);

    h.byteStore.resetFaults();
    const replay = await createExam(h.deps, request());
    expect(replay).toMatchObject({ replayed: true, exam: { status: 'ready_for_extraction' } });
  });

  it('recovers a byte write whose success response was lost', async () => {
    const h = await harness();
    h.byteStore.commitThenThrowPutOnCall = 1;
    const result = await createExam(h.deps, request());
    expect(result.exam.status).toBe('ready_for_extraction');
    expect(h.byteStore.objects.size).toBe(1);
    expect(await examRecords(h, result.exam.examSessionId)).toHaveLength(3);
  });

  it('does not overwrite different bytes already stored at the deterministic key', async () => {
    const h = await harness();
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const examSessionId = deriveExamSessionId({
      learnerKey,
      profileId: PROFILE_A,
      clientRequestId: request().clientRequestId,
    });
    const documentId = deriveExamDocumentId(examSessionId, 'question_paper');
    const key = examSnapshotObjectKey(examSessionId, documentId);
    const existing = Buffer.from('conflicting immutable bytes');
    h.byteStore.objects.set(key, existing);

    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_DOCUMENT_CONFLICT');
    expect(h.byteStore.putCalls).toHaveLength(0);
    expect(h.byteStore.objects.get(key)).toEqual(existing);
    expect(await examRecords(h, examSessionId)).toHaveLength(1);
  });

  it('resumes bytes committed before a snapshot event append failure', async () => {
    const h = await harness();
    let failed = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      if (
        !failed &&
        (init.payload as { eventType?: string }).eventType === 'exam_document_snapshotted'
      ) {
        failed = true;
        throw new Error('snapshot event append failed before commit');
      }
      return h.store.appendRecord(init, options);
    };
    h.deps.store = withAppend(h.store, appendRecord);
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    expect(h.byteStore.objects.size).toBe(1);
    const putsBeforeRetry = h.byteStore.putCalls.length;

    h.deps.store = h.store;
    const replay = await createExam(h.deps, request());
    expect(replay.exam.status).toBe('ready_for_extraction');
    expect(h.byteStore.putCalls).toHaveLength(putsBeforeRetry);
  });

  it('resumes all snapshot facts after intake completion append failure', async () => {
    const h = await harness();
    let failed = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      if (
        !failed &&
        (init.payload as { eventType?: string }).eventType === 'exam_intake_completed'
      ) {
        failed = true;
        throw new Error('completion append failed before commit');
      }
      return h.store.appendRecord(init, options);
    };
    h.deps.store = withAppend(h.store, appendRecord);
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    expect(h.byteStore.objects.size).toBe(1);

    h.deps.store = h.store;
    const replay = await createExam(h.deps, request());
    expect(replay.exam.status).toBe('ready_for_extraction');
    expect(await examRecords(h, replay.exam.examSessionId)).toHaveLength(3);
  });

  it('does not become ready when the final physical snapshot read-back fails', async () => {
    const h = await harness();
    h.byteStore.failGetOnCall = 3;
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const examSessionId = deriveExamSessionId({
      learnerKey,
      profileId: PROFILE_A,
      clientRequestId: request().clientRequestId,
    });
    const records = await examRecords(h, examSessionId);
    expect(records.map((record) => (record.payload as { eventType: string }).eventType)).toEqual([
      'exam_created',
      'exam_document_snapshotted',
    ]);

    h.byteStore.resetFaults();
    await expect(createExam(h.deps, request())).resolves.toMatchObject({
      replayed: true,
      exam: { status: 'ready_for_extraction' },
    });
  });

  it.each(['exam_created', 'exam_document_snapshotted', 'exam_intake_completed'] as const)(
    'recovers a committed %s event response loss',
    async (eventType) => {
      const h = await harness();
      let lost = false;
      const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
        const record = await h.store.appendRecord(init, options);
        if (!lost && (init.payload as { eventType?: string }).eventType === eventType) {
          lost = true;
          throw new Error('simulated response loss');
        }
        return record;
      };
      h.deps.store = withAppend(h.store, appendRecord);
      const result = await createExam(h.deps, request());
      expect(result.exam.status).toBe('ready_for_extraction');
      expect(lost).toBe(true);
      const records = await examRecords(h, result.exam.examSessionId);
      expect(records).toHaveLength(3);
      expect(
        records.filter(
          (record) => (record.payload as { eventType?: string }).eventType === eventType,
        ),
      ).toHaveLength(1);
      expect(new Set(records.map((record) => record.id)).size).toBe(3);

      const replay = await createExam(h.deps, request());
      expect(replay.replayed).toBe(true);
      expect(await examRecords(h, result.exam.examSessionId)).toHaveLength(3);
    },
  );

  it('retains the first completed snapshot when the second document write fails', async () => {
    const h = await harness();
    h.byteStore.failPutOnCall = 2;
    const multi = request({ documents: allDocuments().slice(0, 2) });
    await expect(createExam(h.deps, multi)).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    const learner = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const examSession = (await h.store.listSessions(`zhongkao-profile:${PROFILE_A}`, learner)).find(
      (session) => session.kind === 'zhongkaoExamEvent',
    )!;
    const before = await h.store.listRecords(examSession.id);
    expect(before.map((record) => (record.payload as { eventType: string }).eventType)).toEqual([
      'exam_created',
      'exam_document_snapshotted',
    ]);
    const firstKey = h.byteStore.putCalls[0]!;
    const firstPuts = h.byteStore.putCalls.filter((key) => key === firstKey).length;

    h.byteStore.resetFaults();
    const replay = await createExam(h.deps, multi);
    expect(replay.exam.status).toBe('ready_for_extraction');
    expect(h.byteStore.putCalls.filter((key) => key === firstKey)).toHaveLength(firstPuts);
  });

  it('fails closed for snapshot read errors and mismatched read-back bytes', async () => {
    const readFailure = await harness();
    readFailure.byteStore.failGetOnCall = 2;
    await expect(createExam(readFailure.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');

    const mismatch = await harness();
    mismatch.byteStore.corruptPutOnCall = 1;
    await expect(createExam(mismatch.deps, request())).rejects.toThrow('EXAM_DOCUMENT_CONFLICT');
  });

  it('keeps a ready Exam independent after its owner source disappears', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    h.sources.delete(MATERIAL_IDS.question_paper);
    const publicExam = await getExam(h.deps, result.exam.examSessionId);
    const resolved = await resolveExamDocumentSnapshot(
      h.deps,
      result.exam.examSessionId,
      result.exam.documents[0]!.examDocumentId,
    );
    expect(publicExam.status).toBe('ready_for_extraction');
    expect(resolved.bytes.toString()).toBe('fictional question paper bytes');
    const replay = await createExam(h.deps, request());
    expect(replay.replayed).toBe(true);
    expect(h.captureCalls).toHaveLength(1);
    await expect(
      createExam(h.deps, request({ clientRequestId: 'exam-request-after-source-delete' })),
    ).rejects.toThrow('EXAM_SOURCE_UNAVAILABLE');
  });

  it('keeps Exam state and snapshot bytes after an Agent runtime session is deleted', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const agentSessionId = 'agent-runtime-session-for-exam-isolation';
    await h.store.createSession({
      id: agentSessionId,
      kind: 'chat',
      stageId: 'agent-runtime-stage',
      learnerKey,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });

    await h.store.deleteSession(agentSessionId);

    expect(await h.store.getSession(agentSessionId)).toBeUndefined();
    expect((await getExam(h.deps, result.exam.examSessionId)).status).toBe('ready_for_extraction');
    const resolved = await resolveExamDocumentSnapshot(
      h.deps,
      result.exam.examSessionId,
      result.exam.documents[0]!.examDocumentId,
    );
    expect(resolved.bytes.toString()).toBe('fictional question paper bytes');
    expect(await examRecords(h, result.exam.examSessionId)).toHaveLength(3);
  });

  it('returns only a safe public projection and keeps answer_key non-authoritative', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request({ documents: allDocuments() }));
    const serialized = JSON.stringify(result.exam);
    expect(serialized).not.toMatch(
      /sourceSha256|snapshotSha256|ownerMaterialId|objectKey|learnerKey|eventId|operationId|requestFingerprint|documentSetFingerprint|gradingSpec|authoritative|verified/u,
    );
    expect(result.exam.documents.find((document) => document.role === 'answer_key')).toEqual({
      examDocumentId: expect.any(String),
      role: 'answer_key',
      displayName: 'fictional-key.txt',
      mimeType: 'text/plain',
      byteLength: Buffer.byteLength('fictional answer key bytes'),
      snapshotStatus: 'snapshotted',
    });
    expect(result.exam.humanReview).toEqual({ status: 'not_started' });
  });

  it('fails closed when a resolved snapshot is missing, corrupt or foreign', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    const documentId = result.exam.documents[0]!.examDocumentId;
    const key = [...h.byteStore.objects.keys()][0]!;
    h.byteStore.objects.set(key, Buffer.from('corrupt'));
    await expect(
      resolveExamDocumentSnapshot(h.deps, result.exam.examSessionId, documentId),
    ).rejects.toThrow('EXAM_SNAPSHOT_INTEGRITY_FAILED');
    h.byteStore.objects.delete(key);
    await expect(
      resolveExamDocumentSnapshot(h.deps, result.exam.examSessionId, documentId),
    ).rejects.toThrow('EXAM_SNAPSHOT_INTEGRITY_FAILED');
    await expect(
      resolveExamDocumentSnapshot(h.deps, result.exam.examSessionId, 'unknown-document'),
    ).rejects.toThrow('EXAM_NOT_FOUND');
    await expect(
      resolveExamDocumentSnapshot(
        { ...h.deps, ownerId: OWNER_B },
        result.exam.examSessionId,
        documentId,
      ),
    ).rejects.toThrow('EXAM_NOT_FOUND');
  });

  it('serializes a server snapshot read against Exam deletion', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    const documentId = result.exam.documents[0]!.examDocumentId;
    const originalGet = h.byteStore.get.bind(h.byteStore);
    let entered!: () => void;
    const readEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const readRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const getSpy = vi.spyOn(h.byteStore, 'get').mockImplementation(async (key) => {
      if (!blocked) {
        blocked = true;
        entered();
        await readRelease;
      }
      return originalGet(key);
    });

    try {
      const resolving = resolveExamDocumentSnapshot(h.deps, result.exam.examSessionId, documentId);
      await readEntered;
      const deleting = deleteExam(h.deps, result.exam.examSessionId);
      await Promise.resolve();
      expect(h.byteStore.deleteCalls).toHaveLength(0);
      release();
      await expect(resolving).resolves.toMatchObject({
        examDocumentId: documentId,
        byteLength: Buffer.byteLength('fictional question paper bytes'),
      });
      await expect(deleting).resolves.toBe('deleted');
      await expect(
        resolveExamDocumentSnapshot(h.deps, result.exam.examSessionId, documentId),
      ).rejects.toThrow('EXAM_NOT_FOUND');
    } finally {
      release();
      getSpy.mockRestore();
    }
  });
});

describe('Exam deletion service', () => {
  it('deletes exact snapshots, hides the Exam and replays idempotently', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request({ documents: allDocuments() }));
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('deleted');
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.byteStore.deleteCalls).toHaveLength(3);
    expect(h.byteStore.deletePrefixCalls).toHaveLength(1);
    const events = (await examRecords(h, result.exam.examSessionId)).map(
      (record) => record.payload as ExamEvent,
    );
    expect(events.map((event) => event.eventType)).toEqual([
      'exam_created',
      'exam_document_snapshotted',
      'exam_document_snapshotted',
      'exam_document_snapshotted',
      'exam_intake_completed',
      'exam_delete_requested',
      'exam_deleted',
    ]);
    for (const event of events) {
      expect(event.operationFingerprint).toBe(expectedOperationFingerprint(event));
    }
    await expect(getExam(h.deps, result.exam.examSessionId)).rejects.toThrow('EXAM_NOT_FOUND');
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('already_deleted');
  });

  it('deletes an exact human-review key from started state without prefix deletion', async () => {
    const h = await harness();
    const questionBytes = await fictionalQuestionPdf();
    h.sources.set(
      MATERIAL_IDS.question_paper,
      source(
        MATERIAL_IDS.question_paper,
        questionBytes,
        'application/pdf',
        'fictional-question.pdf',
      ),
    );
    const result = await createExam(h.deps, request({ documents: allDocuments() }));
    await extractExamQuestionCandidates(h.deps, result.exam.examSessionId);
    await captureExamStudentResponses(h.deps, result.exam.examSessionId, {
      format: 'numbered_text_v1',
      text: '1=A\n2=',
    });

    const snapshot = await loadExamRuntime(h.deps, result.exam.examSessionId);
    const extraction = snapshot.state.questionExtraction;
    const segmentation = extraction?.segmentation;
    const candidateArtifact = segmentation?.candidateArtifact;
    const capture = snapshot.state.studentResponseCapture;
    const responseArtifact = capture?.responseArtifact;
    const matchingArtifact = capture?.matchingArtifact;
    if (
      !extraction ||
      !segmentation ||
      !candidateArtifact ||
      !capture ||
      !responseArtifact ||
      !matchingArtifact
    ) {
      throw new Error('review source fixture is incomplete');
    }
    const reviewVersion = 1;
    const upstreamPlan = {
      reviewVersion,
      questionExtractionVersion: extraction.extractionVersion,
      questionSegmentationVersion: segmentation.segmentationVersion,
      responseCaptureVersion: capture.captureVersion,
      matchingVersion: capture.matchingVersion,
      questionCandidateArtifactRef: segmentation.candidateArtifactRef,
      sourceQuestionCandidateFingerprint: candidateArtifact.sha256,
      responseArtifactRef: capture.responseArtifactRef,
      sourceResponseArtifactFingerprint: responseArtifact.sha256,
      matchingArtifactRef: capture.matchingArtifactRef,
      sourceMatchingArtifactFingerprint: matchingArtifact.sha256,
    } as const;
    const plan = {
      ...upstreamPlan,
      decisionSemanticFingerprint: '9'.repeat(64),
      reviewArtifactRef: deriveExamHumanReviewArtifactRef(
        deriveExamHumanReviewRef({ examSessionId: result.exam.examSessionId, ...upstreamPlan }),
      ),
    };
    const operationId = deriveExamHumanReviewStartedOperationId(
      result.exam.examSessionId,
      reviewVersion,
    );
    const started: ExamHumanReviewStartedEvent = {
      schemaVersion: 1,
      eventId: deriveExamEventId(operationId),
      examSessionId: result.exam.examSessionId,
      profileId: result.exam.profileId,
      eventType: 'exam_human_review_started',
      createdAt: '2026-08-31T09:00:00.000Z',
      operationId,
      operationFingerprint: createExamOperationFingerprint({
        action: 'exam_human_review_started',
        schemaVersion: 1,
        examSessionId: result.exam.examSessionId,
        profileId: result.exam.profileId,
        ...plan,
      }),
      ...plan,
    };
    await appendExamRuntimeEvent(h.deps, {
      event: started,
      expectedRevision: snapshot.state.revision,
    });

    const reviewKey = examHumanReviewObjectKey(
      result.exam.examSessionId,
      capture.captureVersion,
      capture.matchingVersion,
      reviewVersion,
    );
    await h.byteStore.put(reviewKey, Buffer.from('{"fixture":true}'));
    const byteStoreWithoutPrefix: MaterialByteStore = {
      put: h.byteStore.put.bind(h.byteStore),
      get: h.byteStore.get.bind(h.byteStore),
      delete: h.byteStore.delete.bind(h.byteStore),
    };

    await expect(
      deleteExam({ ...h.deps, byteStore: byteStoreWithoutPrefix }, result.exam.examSessionId),
    ).resolves.toBe('deleted');
    expect(h.byteStore.objects.has(reviewKey)).toBe(false);
    expect(h.byteStore.deleteCalls).toContain(reviewKey);
    expect(h.byteStore.deletePrefixCalls).toHaveLength(0);
  });

  it('recovers deletion after a midway byte failure', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request({ documents: allDocuments().slice(0, 2) }));
    h.byteStore.failDeleteOnCall = 2;
    await expect(deleteExam(h.deps, result.exam.examSessionId)).rejects.toThrow(
      'EXAM_DELETE_FAILED',
    );
    expect((await getExam(h.deps, result.exam.examSessionId)).status).toBe('deleting');
    expect(h.byteStore.objects.size).toBe(1);

    h.byteStore.resetFaults();
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('deleted');
    expect(h.byteStore.objects.size).toBe(0);
  });

  it('recovers when bytes are gone but the deleted event append failed', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    let failed = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      if (!failed && (init.payload as { eventType?: string }).eventType === 'exam_deleted') {
        failed = true;
        throw new Error('deleted event append failed before commit');
      }
      return h.store.appendRecord(init, options);
    };
    h.deps.store = withAppend(h.store, appendRecord);
    await expect(deleteExam(h.deps, result.exam.examSessionId)).rejects.toThrow(
      'EXAM_DELETE_FAILED',
    );
    expect(h.byteStore.objects.size).toBe(0);

    h.deps.store = h.store;
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('deleted');
  });

  it('deletes deterministic bytes that were written before a missing snapshot event', async () => {
    const h = await harness();
    let failed = false;
    h.deps.store = withAppend(h.store, async (init, options = {}) => {
      if (
        !failed &&
        (init.payload as { eventType?: string }).eventType === 'exam_document_snapshotted'
      ) {
        failed = true;
        throw new Error('snapshot event append failed before commit');
      }
      return h.store.appendRecord(init, options);
    });
    await expect(createExam(h.deps, request())).rejects.toThrow('EXAM_SNAPSHOT_FAILED');
    const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(OWNER_A);
    const examSessionId = deriveExamSessionId({
      learnerKey,
      profileId: PROFILE_A,
      clientRequestId: request().clientRequestId,
    });
    expect(h.byteStore.objects.size).toBe(1);

    h.deps.store = h.store;
    await expect(deleteExam(h.deps, examSessionId)).resolves.toBe('deleted');
    expect(h.byteStore.objects.size).toBe(0);
    expect((await examRecords(h, examSessionId)).map((record) => record.payload)).toEqual([
      expect.objectContaining({ eventType: 'exam_created' }),
      expect.objectContaining({ eventType: 'exam_delete_requested' }),
      expect.objectContaining({ eventType: 'exam_deleted' }),
    ]);
  });

  it('does not append exam_deleted when the byte store falsely reports successful deletion', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    const deleteSpy = vi.spyOn(h.byteStore, 'delete').mockResolvedValue(undefined);
    const prefixSpy = vi.spyOn(h.byteStore, 'deletePrefix').mockResolvedValue(undefined);
    try {
      await expect(deleteExam(h.deps, result.exam.examSessionId)).rejects.toThrow(
        'EXAM_DELETE_FAILED',
      );
      const records = await examRecords(h, result.exam.examSessionId);
      expect(records.at(-1)?.payload).toMatchObject({ eventType: 'exam_delete_requested' });
      expect(
        records.some(
          (record) => (record.payload as { eventType?: string }).eventType === 'exam_deleted',
        ),
      ).toBe(false);
      expect(h.byteStore.objects.size).toBe(1);
    } finally {
      deleteSpy.mockRestore();
      prefixSpy.mockRestore();
    }
    await expect(deleteExam(h.deps, result.exam.examSessionId)).resolves.toBe('deleted');
  });

  it.each(['before_commit', 'committed_response_loss'] as const)(
    'recovers exam_delete_requested append %s',
    async (failureMode) => {
      const h = await harness();
      const result = await createExam(h.deps, request());
      let failed = false;
      h.deps.store = withAppend(h.store, async (init, options = {}) => {
        if (
          !failed &&
          (init.payload as { eventType?: string }).eventType === 'exam_delete_requested'
        ) {
          failed = true;
          if (failureMode === 'before_commit') throw new Error('delete request append failed');
          const record = await h.store.appendRecord(init, options);
          throw new Error(`response lost after ${record.id}`);
        }
        return h.store.appendRecord(init, options);
      });

      if (failureMode === 'before_commit') {
        await expect(deleteExam(h.deps, result.exam.examSessionId)).rejects.toThrow(
          'EXAM_DELETE_FAILED',
        );
        expect(h.byteStore.objects.size).toBe(1);
        h.deps.store = h.store;
        await expect(deleteExam(h.deps, result.exam.examSessionId)).resolves.toBe('deleted');
      } else {
        await expect(deleteExam(h.deps, result.exam.examSessionId)).resolves.toBe('deleted');
      }
      const records = await examRecords(h, result.exam.examSessionId);
      expect(
        records.filter(
          (record) =>
            (record.payload as { eventType?: string }).eventType === 'exam_delete_requested',
        ),
      ).toHaveLength(1);
    },
  );

  it('recovers a committed deleted event response loss', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    let lost = false;
    const appendRecord: RuntimeStore['appendRecord'] = async (init, options = {}) => {
      const record = await h.store.appendRecord(init, options);
      if (!lost && (init.payload as { eventType?: string }).eventType === 'exam_deleted') {
        lost = true;
        throw new Error('deleted event response lost');
      }
      return record;
    };
    h.deps.store = withAppend(h.store, appendRecord);
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('deleted');
    expect(lost).toBe(true);
    expect(await deleteExam(h.deps, result.exam.examSessionId)).toBe('already_deleted');
  });

  it('rejects cross-owner deletion without touching bytes', async () => {
    const h = await harness();
    const result = await createExam(h.deps, request());
    await expect(
      deleteExam({ ...h.deps, ownerId: OWNER_B }, result.exam.examSessionId),
    ).rejects.toThrow('EXAM_NOT_FOUND');
    expect(h.byteStore.objects.size).toBe(1);
    expect(h.byteStore.deleteCalls).toHaveLength(0);
  });

  it('never removes another Exam prefix', async () => {
    const h = await harness();
    const first = await createExam(h.deps, request());
    const second = await createExam(h.deps, request({ clientRequestId: 'exam-request-beta' }));
    const secondDocument = second.exam.documents[0]!;
    await deleteExam(h.deps, first.exam.examSessionId);
    const resolved = await resolveExamDocumentSnapshot(
      h.deps,
      second.exam.examSessionId,
      secondDocument.examDocumentId,
    );
    expect(resolved.bytes.toString()).toBe('fictional question paper bytes');
    expect(h.byteStore.objects.size).toBe(1);
  });
});
