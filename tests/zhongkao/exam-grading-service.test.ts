import { createHash } from 'node:crypto';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  examAuthoritativeAnswerKeyObjectKey,
  examHumanReviewObjectKey,
  examQuestionAssessmentsObjectKey,
  examSnapshotObjectKey,
} from '@/lib/server/materials/object-keys';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';
import { extractExamQuestionCandidates } from '@/lib/server/zhongkao/exam-extraction-service';
import {
  buildExamQuestionAssessmentsArtifact,
  serializeAuthoritativeExamAnswerKeyArtifact,
  type ExamAnswerKeyRequestV1,
  type ExamQuestionAssessmentsArtifactV1,
} from '@/lib/server/zhongkao/exam-grading-private';
import {
  confirmExamAnswerKeyAndGrade,
  resolveAuthoritativeExamAnswerKey,
  resolveExamQuestionAssessments,
  type ExamGradingServiceDeps,
} from '@/lib/server/zhongkao/exam-grading-service';
import {
  confirmExamHumanReview,
  getExamHumanReview,
  resolveConfirmedExamReviewFacts,
} from '@/lib/server/zhongkao/exam-human-review-service';
import {
  captureExamStudentResponses,
  resolveExamStudentResponses,
} from '@/lib/server/zhongkao/exam-response-service';
import { examRuntimeSessionId } from '@/lib/server/zhongkao/exam-runtime';
import {
  createExam,
  deleteExam,
  getExam,
  type ExamServiceDeps,
} from '@/lib/server/zhongkao/exam-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import type {
  ConfirmedExamReviewFactsV1,
  ExamHumanReviewDecision,
  ExamHumanReviewRequest,
} from '@/lib/zhongkao/exam-human-review';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-01T06:00:00.000Z';
const OWNER = 'fictional-exam-grading-owner';
const PROFILE = 'fictional-exam-grading-profile';
const MATERIALS = {
  question: `mat_${'c'.repeat(26)}`,
  response: `mat_${'d'.repeat(26)}`,
  answer: `mat_${'e'.repeat(26)}`,
} as const;
const ANSWER_KEY_SUFFIX = '/authoritative_answer_key_v1.json';
const ASSESSMENTS_SUFFIX = '/exam_question_assessments_v1.json';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function buffered(body: MaterialByteInput): Buffer {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('test byte store only accepts buffered input');
}

class FakeByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: string[] = [];
  readonly getCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  readonly forbiddenReads = new Set<string>();
  failPutSuffixOnce?: string;
  failPutAfterCommitSuffixOnce?: string;
  failReadBackSuffixOnce?: string;
  private armedReadBackSuffix?: string;

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    this.putCalls.push(key);
    if (this.failPutSuffixOnce && key.endsWith(this.failPutSuffixOnce)) {
      this.failPutSuffixOnce = undefined;
      throw new Error('injected artifact put failure');
    }
    this.objects.set(key, buffered(body));
    if (this.failPutAfterCommitSuffixOnce && key.endsWith(this.failPutAfterCommitSuffixOnce)) {
      this.failPutAfterCommitSuffixOnce = undefined;
      throw new Error('injected committed artifact put response loss');
    }
    if (this.failReadBackSuffixOnce && key.endsWith(this.failReadBackSuffixOnce)) {
      this.armedReadBackSuffix = this.failReadBackSuffixOnce;
      this.failReadBackSuffixOnce = undefined;
    }
  }

  async get(key: string): Promise<Buffer> {
    this.getCalls.push(key);
    if (this.forbiddenReads.has(key)) throw new Error('forbidden snapshot read');
    if (this.armedReadBackSuffix && key.endsWith(this.armedReadBackSuffix)) {
      this.armedReadBackSuffix = undefined;
      throw new Error('injected artifact read-back failure');
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'material bytes are unavailable');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

function keyedMutex(): ExamServiceDeps['withExamMutationLock'] {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
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
}

function ownerRecord(
  id: string,
  bytes: Buffer,
  mime: string,
  originalName: string,
): OwnerMaterialRecord {
  return {
    id,
    ownerId: OWNER,
    kind: 'source',
    derivedFrom: null,
    mime,
    bytes: bytes.byteLength,
    originalName,
    ossKey: `private-${id}`,
    sha256: sha256(bytes),
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: Date.parse(NOW),
    deletedAt: null,
  };
}

function source(
  id: string,
  bytes: Buffer,
  mimeType: string,
  originalName: string,
): VerifiedOwnerMaterialAsset {
  const record = ownerRecord(id, bytes, mimeType, originalName);
  return {
    record,
    bytes,
    ownerMaterialId: id,
    sha256: record.sha256!,
    mimeType,
    byteLength: bytes.byteLength,
  };
}

async function questionPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 700]);
  page.drawText(
    [
      '1. Fictional single-choice question with enough native text',
      '2. Fictional multiple-choice question with enough native text',
      '3. Fictional numeric question with enough native text',
      '4. Fictional exact-short question with enough native text',
      '5. Fictional unsupported question with enough native text',
      '6. Fictional blank-response question with enough native text',
      '7. Fictional no-response question with enough native text',
    ].join('\n'),
    { x: 36, y: 650, size: 11, lineHeight: 18, font },
  );
  return Buffer.from(await pdf.save());
}

interface Harness {
  baseStore: RuntimeStore;
  deps: ExamGradingServiceDeps;
  byteStore: FakeByteStore;
}

async function harness(): Promise<Harness> {
  const baseStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-grading-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FakeByteStore();
  const question = await questionPdf();
  const assets = new Map<string, VerifiedOwnerMaterialAsset>([
    [MATERIALS.question, source(MATERIALS.question, question, 'application/pdf', 'paper.pdf')],
    [
      MATERIALS.response,
      source(
        MATERIALS.response,
        Buffer.from('private fictional responses'),
        'text/plain',
        'responses.txt',
      ),
    ],
    [
      MATERIALS.answer,
      source(
        MATERIALS.answer,
        Buffer.from('uploaded answer-key snapshot must stay unread'),
        'text/plain',
        'uploaded-answers.txt',
      ),
    ],
  ]);
  let second = 0;
  const deps: ExamGradingServiceDeps = {
    store: baseStore,
    ownerId: OWNER,
    byteStore,
    withExamMutationLock: keyedMutex(),
    captureSources: async (ownerId, ids) => {
      if (ownerId !== OWNER) return { ok: false, reason: 'unavailable' };
      const resolved = ids.map((id) => assets.get(id)).filter((asset) => asset !== undefined);
      return resolved.length === ids.length
        ? { ok: true, assets: resolved }
        : { ok: false, reason: 'unavailable' };
    },
    now: () => new Date(Date.parse(NOW) + second++ * 1000).toISOString(),
  };
  await saveStudentProfile(createInitialStudentProfile({ profileId: PROFILE, createdAt: NOW }), {
    store: baseStore,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER),
    now: () => NOW,
    mintRecordId: () => 'profile-record-exam-grading',
  });
  return { baseStore, deps, byteStore };
}

async function reviewRequest(h: Harness, examSessionId: string): Promise<ExamHumanReviewRequest> {
  const bundle = await getExamHumanReview(h.deps, examSessionId);
  const resolved = await resolveExamStudentResponses(h.deps, examSessionId);
  const decisions: ExamHumanReviewDecision[] = bundle.questions.map((question) =>
    question.candidateKind === 'group'
      ? {
          decisionType: 'reject_question' as const,
          questionCandidateId: question.questionCandidateId,
          reason: 'not_a_question' as const,
        }
      : {
          decisionType: 'confirm_question' as const,
          questionCandidateId: question.questionCandidateId,
        },
  );
  const answered = new Set<string>();
  for (const response of resolved.responseCandidates.candidates) {
    const match = resolved.questionResponseMatches.matches.find(
      (item) => item.responseCandidateId === response.candidateId,
    );
    const questionCandidateId =
      match?.status === 'matched' && match.questionCandidateIds.length === 1
        ? match.questionCandidateIds[0]
        : undefined;
    const target = bundle.questions.find(
      (question) =>
        question.questionCandidateId === questionCandidateId && question.candidateKind === 'leaf',
    );
    if (!target || answered.has(target.questionCandidateId)) {
      decisions.push({
        decisionType: 'reject_response',
        responseCandidateId: response.candidateId,
        reason: 'wrong_label',
      });
      continue;
    }
    answered.add(target.questionCandidateId);
    decisions.push({
      decisionType: 'confirm_response',
      responseCandidateId: response.candidateId,
      questionCandidateId: target.questionCandidateId,
    });
  }
  for (const question of bundle.questions) {
    if (question.candidateKind === 'leaf' && !answered.has(question.questionCandidateId)) {
      decisions.push({
        decisionType: 'confirm_no_response',
        questionCandidateId: question.questionCandidateId,
      });
    }
  }
  return { schemaVersion: 1, decisions };
}

async function preparedExam(confirmReview = true) {
  const h = await harness();
  const created = await createExam(h.deps, {
    clientRequestId: 'grading-service-fixture',
    profileId: PROFILE,
    subjectId: 'math',
    documents: [
      { role: 'question_paper', ownerMaterialId: MATERIALS.question },
      { role: 'student_response', ownerMaterialId: MATERIALS.response },
      { role: 'answer_key', ownerMaterialId: MATERIALS.answer },
    ],
  });
  const examSessionId = created.exam.examSessionId;
  await extractExamQuestionCandidates(h.deps, examSessionId);
  await captureExamStudentResponses(h.deps, examSessionId, {
    format: 'numbered_text_v1',
    text: ['1=B', '2=A,C', '3=12.50', '4=\u6c27\u6c14', '5=an essay', '6='].join('\n'),
  });
  if (confirmReview) {
    await confirmExamHumanReview(h.deps, examSessionId, await reviewRequest(h, examSessionId));
  }
  return { h, examSessionId };
}

function questionId(review: ConfirmedExamReviewFactsV1, printedNumber: string): string {
  const question = review.confirmedQuestions.find(
    (candidate) => candidate.locator.printedNumber === printedNumber,
  );
  if (!question) throw new Error(`missing confirmed question ${printedNumber}`);
  return question.confirmedQuestionId;
}

function completeKeyRequest(review: ConfirmedExamReviewFactsV1): ExamAnswerKeyRequestV1 {
  return {
    schemaVersion: 1,
    entries: [
      {
        confirmedQuestionId: questionId(review, '5'),
        type: 'unassessed',
        reason: 'unsupported_question_type',
      },
      {
        confirmedQuestionId: questionId(review, '4'),
        type: 'exact_short_answer',
        acceptedAnswers: ['\u6c27\u6c14', 'O2'],
      },
      {
        confirmedQuestionId: questionId(review, '2'),
        type: 'multiple_choice',
        expectedOptionIds: ['C', 'A'],
      },
      {
        confirmedQuestionId: questionId(review, '7'),
        type: 'numeric',
        expectedValue: '0',
      },
      {
        confirmedQuestionId: questionId(review, '1'),
        type: 'single_choice',
        expectedOptionId: 'B',
      },
      {
        confirmedQuestionId: questionId(review, '6'),
        type: 'single_choice',
        expectedOptionId: 'A',
      },
      {
        confirmedQuestionId: questionId(review, '3'),
        type: 'numeric',
        expectedValue: '12.5',
      },
    ],
  };
}

async function confirmedFixture() {
  const prepared = await preparedExam();
  const review = await resolveConfirmedExamReviewFacts(prepared.h.deps, prepared.examSessionId);
  return { ...prepared, review, request: completeKeyRequest(review) };
}

function changedKeyRequest(request: ExamAnswerKeyRequestV1): ExamAnswerKeyRequestV1 {
  const changed = structuredClone(request);
  const single = changed.entries.find((entry) => entry.type === 'single_choice');
  if (!single || single.type !== 'single_choice') throw new Error('missing single-choice fixture');
  single.expectedOptionId = single.expectedOptionId === 'A' ? 'B' : 'A';
  return changed;
}

function semanticReplayRequest(request: ExamAnswerKeyRequestV1): ExamAnswerKeyRequestV1 {
  return {
    schemaVersion: 1,
    entries: [...structuredClone(request.entries)]
      .reverse()
      .map((entry) =>
        entry.type === 'multiple_choice'
          ? { ...entry, expectedOptionIds: [...entry.expectedOptionIds].reverse() }
          : entry,
      ),
  };
}

async function events(h: Harness, examSessionId: string): Promise<ExamEvent[]> {
  const records = await h.baseStore.listRecords(examRuntimeSessionId(examSessionId));
  return records.map((record) => record.payload as ExamEvent);
}

function gradingEvents(history: readonly ExamEvent[]): ExamEvent[] {
  return history.filter(
    (event) =>
      event.eventType.startsWith('exam_answer_key_') || event.eventType.startsWith('exam_grading_'),
  );
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

function failAppendOnce(h: Harness, eventType: ExamEvent['eventType'], committed = false): void {
  let fail = true;
  const append = h.baseStore.appendRecord.bind(h.baseStore);
  h.deps.store = withAppend(h.baseStore, async (record, options) => {
    if (fail && (record.payload as { eventType?: string }).eventType === eventType) {
      fail = false;
      if (committed) await append(record, options);
      throw new Error(committed ? 'injected committed response loss' : 'injected append failure');
    }
    return append(record, options);
  });
}

function assessmentFor(
  artifact: ExamQuestionAssessmentsArtifactV1,
  review: ConfirmedExamReviewFactsV1,
  printedNumber: string,
) {
  const assessment = artifact.assessments.find(
    (candidate) => candidate.confirmedQuestionId === questionId(review, printedNumber),
  );
  if (!assessment) throw new Error(`missing assessment ${printedNumber}`);
  return assessment;
}

describe('Exam grading service authority and deterministic results', () => {
  it('requires a confirmed review and enforces owner authority', async () => {
    const unconfirmed = await preparedExam(false);
    await expect(
      confirmExamAnswerKeyAndGrade(unconfirmed.h.deps, unconfirmed.examSessionId, {
        schemaVersion: 1,
        entries: [],
      }),
    ).rejects.toMatchObject({ code: 'EXAM_GRADING_NOT_READY' });
    expect(gradingEvents(await events(unconfirmed.h, unconfirmed.examSessionId))).toHaveLength(0);

    const confirmed = await confirmedFixture();
    await expect(
      confirmExamAnswerKeyAndGrade(
        { ...confirmed.h.deps, ownerId: 'fictional-foreign-owner' },
        confirmed.examSessionId,
        confirmed.request,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(gradingEvents(await events(confirmed.h, confirmed.examSessionId))).toHaveLength(0);
  });

  it('fails closed when the confirmed-review resolver detects corrupt authority', async () => {
    const fixture = await confirmedFixture();
    const reviewKey = examHumanReviewObjectKey(fixture.examSessionId, 1, 1, 1);
    fixture.h.byteStore.objects.set(reviewKey, Buffer.from('{"corrupt":true}'));

    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).rejects.toMatchObject({ code: 'EXAM_REVIEW_ARTIFACT_CORRUPT' });
    expect(gradingEvents(await events(fixture.h, fixture.examSessionId))).toHaveLength(0);
  });

  it('grades all four objective types, blank/no_response, and explicit unassessed', async () => {
    const fixture = await confirmedFixture();
    const ordinaryBefore = await getExam(fixture.h.deps, fixture.examSessionId);
    const uploadedAnswer = ordinaryBefore.documents.find(
      (document) => document.role === 'answer_key',
    );
    if (!uploadedAnswer) throw new Error('missing uploaded answer-key document');
    const uploadedAnswerSnapshotKey = examSnapshotObjectKey(
      fixture.examSessionId,
      uploadedAnswer.examDocumentId,
    );
    fixture.h.byteStore.getCalls.length = 0;
    fixture.h.byteStore.forbiddenReads.add(uploadedAnswerSnapshotKey);

    const result = await confirmExamAnswerKeyAndGrade(
      fixture.h.deps,
      fixture.examSessionId,
      fixture.request,
    );
    expect(result).toEqual({
      examSessionId: fixture.examSessionId,
      replayed: false,
      grading: {
        status: 'completed',
        assessmentCount: 7,
        evaluatedCount: 6,
        correctCount: 4,
        incorrectCount: 2,
        unassessedCount: 1,
      },
    });
    expect(fixture.h.byteStore.getCalls).not.toContain(uploadedAnswerSnapshotKey);

    const key = await resolveAuthoritativeExamAnswerKey(fixture.h.deps, fixture.examSessionId);
    const assessments = await resolveExamQuestionAssessments(fixture.h.deps, fixture.examSessionId);
    expect(key).toMatchObject({
      authoritySource: 'owner_confirmed_manual_key',
      gradingAlgorithmVersion: 'exam-objective-grading:v1',
      entryCount: 7,
      sourceReview: {
        reviewRef: fixture.review.reviewRef,
        decisionSemanticFingerprint: fixture.review.decisionSemanticFingerprint,
      },
    });
    expect(assessments).toMatchObject({
      assessmentCount: 7,
      evaluatedCount: 6,
      correctCount: 4,
      incorrectCount: 2,
      unassessedCount: 1,
      answerKeyRef: key.answerKeyRef,
      answerKeySemanticFingerprint: key.semanticFingerprint,
      answerKeyArtifactSha256: sha256(serializeAuthoritativeExamAnswerKeyArtifact(key)),
      sourceReview: key.sourceReview,
    });
    for (const number of ['1', '2', '3', '4']) {
      expect(assessmentFor(assessments, fixture.review, number)).toMatchObject({
        status: 'evaluated',
        outcome: 'correct',
      });
    }
    expect(assessmentFor(assessments, fixture.review, '5')).toMatchObject({
      status: 'unassessed',
      reason: 'unsupported_question_type',
    });
    for (const number of ['6', '7']) {
      expect(assessmentFor(assessments, fixture.review, number)).toMatchObject({
        status: 'evaluated',
        outcome: 'incorrect',
      });
    }
    expect(new Set(assessments.assessments.map((item) => item.confirmedQuestionId))).toHaveLength(
      7,
    );
    expect(assessments.assessments.map((item) => item.confirmedQuestionId)).toEqual(
      [...assessments.assessments.map((item) => item.confirmedQuestionId)].sort(),
    );

    const publicJson = JSON.stringify(await getExam(fixture.h.deps, fixture.examSessionId));
    expect(publicJson).not.toMatch(
      /expectedOptionId|correctOptionId|acceptedAnswers|expectedNumericValue|gradingSpecRef|responseRef|rawAnswerText|authoritySource/u,
    );
    expect(serializeAuthoritativeExamAnswerKeyArtifact(key).toString('utf8')).not.toContain(
      'questionText',
    );
    expect(JSON.stringify(assessments)).not.toMatch(/questionText|rawAnswerText|acceptedAnswers/u);
  });

  it('replays a semantically identical full set and rejects changed key facts', async () => {
    const fixture = await confirmedFixture();
    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      confirmExamAnswerKeyAndGrade(
        fixture.h.deps,
        fixture.examSessionId,
        semanticReplayRequest(fixture.request),
      ),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      confirmExamAnswerKeyAndGrade(
        fixture.h.deps,
        fixture.examSessionId,
        changedKeyRequest(fixture.request),
      ),
    ).rejects.toMatchObject({ code: 'EXAM_ANSWER_KEY_CONFLICT' });
    expect(gradingEvents(await events(fixture.h, fixture.examSessionId))).toHaveLength(4);
  });

  it('validates key and assessment artifacts on every private resolver read', async () => {
    const keyFixture = await confirmedFixture();
    await confirmExamAnswerKeyAndGrade(
      keyFixture.h.deps,
      keyFixture.examSessionId,
      keyFixture.request,
    );
    const keyObject = examAuthoritativeAnswerKeyObjectKey(keyFixture.examSessionId, 1);
    const keyBytes = keyFixture.h.byteStore.objects.get(keyObject)!;
    keyFixture.h.byteStore.objects.set(keyObject, Buffer.alloc(keyBytes.byteLength, 0x78));
    await expect(
      resolveAuthoritativeExamAnswerKey(keyFixture.h.deps, keyFixture.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT' });

    const assessmentFixture = await confirmedFixture();
    await confirmExamAnswerKeyAndGrade(
      assessmentFixture.h.deps,
      assessmentFixture.examSessionId,
      assessmentFixture.request,
    );
    const assessmentObject = examQuestionAssessmentsObjectKey(assessmentFixture.examSessionId, 1);
    const assessmentBytes = assessmentFixture.h.byteStore.objects.get(assessmentObject)!;
    assessmentFixture.h.byteStore.objects.set(
      assessmentObject,
      Buffer.alloc(assessmentBytes.byteLength, 0x78),
    );
    await expect(
      resolveExamQuestionAssessments(assessmentFixture.h.deps, assessmentFixture.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT' });
  });

  it('persists both private artifacts event-first and keeps events free of private answers', async () => {
    const fixture = await confirmedFixture();
    const keyObject = examAuthoritativeAnswerKeyObjectKey(fixture.examSessionId, 1);
    const assessmentObject = examQuestionAssessmentsObjectKey(fixture.examSessionId, 1);
    const originalPut = fixture.h.byteStore.put.bind(fixture.h.byteStore);
    fixture.h.byteStore.put = async (key, body, mime) => {
      if (key === keyObject) {
        expect((await events(fixture.h, fixture.examSessionId)).at(-1)?.eventType).toBe(
          'exam_answer_key_started',
        );
      }
      if (key === assessmentObject) {
        expect((await events(fixture.h, fixture.examSessionId)).at(-1)?.eventType).toBe(
          'exam_grading_started',
        );
      }
      return originalPut(key, body, mime);
    };

    await confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request);
    const history = gradingEvents(await events(fixture.h, fixture.examSessionId));
    expect(history.map((event) => event.eventType)).toEqual([
      'exam_answer_key_started',
      'exam_answer_key_confirmed',
      'exam_grading_started',
      'exam_grading_completed',
    ]);
    expect(JSON.stringify(history)).not.toMatch(
      /expectedOptionId|correctOptionId|correctOptionIds|acceptedAnswers|expectedValue|rawAnswerText|\u6c27\u6c14/u,
    );
  });
});

const APPEND_FAILURES = [
  {
    eventType: 'exam_answer_key_started',
    keyWritten: false,
    assessmentWritten: false,
  },
  {
    eventType: 'exam_answer_key_confirmed',
    keyWritten: true,
    assessmentWritten: false,
  },
  { eventType: 'exam_grading_started', keyWritten: true, assessmentWritten: false },
  { eventType: 'exam_grading_completed', keyWritten: true, assessmentWritten: true },
] as const;

describe('Exam grading service persistence recovery', () => {
  it.each(APPEND_FAILURES)(
    'recovers deterministically after an $eventType append failure',
    async ({ eventType, keyWritten, assessmentWritten }) => {
      const fixture = await confirmedFixture();
      failAppendOnce(fixture.h, eventType);
      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).rejects.toMatchObject({ code: 'EXAM_GRADING_FAILED' });
      expect(
        fixture.h.byteStore.objects.has(
          examAuthoritativeAnswerKeyObjectKey(fixture.examSessionId, 1),
        ),
      ).toBe(keyWritten);
      expect(
        fixture.h.byteStore.objects.has(examQuestionAssessmentsObjectKey(fixture.examSessionId, 1)),
      ).toBe(assessmentWritten);
      expect(
        gradingEvents(await events(fixture.h, fixture.examSessionId)).some(
          (event) => event.eventType === 'exam_grading_completed',
        ),
      ).toBe(false);

      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).resolves.toMatchObject({ grading: { status: 'completed' } });
      expect(gradingEvents(await events(fixture.h, fixture.examSessionId))).toHaveLength(4);
    },
  );

  it.each([
    { mode: 'put', suffix: ANSWER_KEY_SUFFIX, object: 'answer-key' },
    { mode: 'read-back', suffix: ANSWER_KEY_SUFFIX, object: 'answer-key' },
    { mode: 'put', suffix: ASSESSMENTS_SUFFIX, object: 'assessment' },
    { mode: 'read-back', suffix: ASSESSMENTS_SUFFIX, object: 'assessment' },
  ] as const)(
    'recovers a private $object artifact after one $mode failure',
    async ({ mode, suffix }) => {
      const fixture = await confirmedFixture();
      if (mode === 'put') fixture.h.byteStore.failPutSuffixOnce = suffix;
      else fixture.h.byteStore.failReadBackSuffixOnce = suffix;

      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).rejects.toMatchObject({ code: 'EXAM_GRADING_FAILED' });
      expect(
        gradingEvents(await events(fixture.h, fixture.examSessionId)).some(
          (event) => event.eventType === 'exam_grading_completed',
        ),
      ).toBe(false);
      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).resolves.toMatchObject({ grading: { status: 'completed' } });
    },
  );

  it('recovers after a deterministic evaluator failure without publishing completion', async () => {
    const fixture = await confirmedFixture();
    let fail = true;
    fixture.h.deps.buildAssessments = (input) => {
      if (fail) {
        fail = false;
        throw new Error('injected evaluator failure');
      }
      return buildExamQuestionAssessmentsArtifact(input);
    };

    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).rejects.toMatchObject({ code: 'EXAM_GRADING_FAILED' });
    expect(
      gradingEvents(await events(fixture.h, fixture.examSessionId)).map((event) => event.eventType),
    ).toEqual(['exam_answer_key_started', 'exam_answer_key_confirmed']);
    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).resolves.toMatchObject({ grading: { status: 'completed' } });
  });

  it.each([
    'exam_answer_key_started',
    'exam_answer_key_confirmed',
    'exam_grading_started',
    'exam_grading_completed',
  ] as const)(
    'recovers committed $eventType response loss without duplicate logical events',
    async (eventType) => {
      const fixture = await confirmedFixture();
      failAppendOnce(fixture.h, eventType, true);

      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).resolves.toMatchObject({ replayed: false, grading: { status: 'completed' } });
      const history = gradingEvents(await events(fixture.h, fixture.examSessionId));
      expect(history.filter((event) => event.eventType === eventType)).toHaveLength(1);
      expect(history).toHaveLength(4);
    },
  );

  it.each([ANSWER_KEY_SUFFIX, ASSESSMENTS_SUFFIX] as const)(
    'recovers when an artifact put for $suffix commits before its response is lost',
    async (suffix) => {
      const fixture = await confirmedFixture();
      fixture.h.byteStore.failPutAfterCommitSuffixOnce = suffix;

      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).resolves.toMatchObject({ grading: { status: 'completed' } });
      expect(gradingEvents(await events(fixture.h, fixture.examSessionId))).toHaveLength(4);
    },
  );

  it.each([
    {
      objectKey: (examSessionId: string) => examAuthoritativeAnswerKeyObjectKey(examSessionId, 1),
      code: 'EXAM_ANSWER_KEY_CONFLICT',
    },
    {
      objectKey: (examSessionId: string) => examQuestionAssessmentsObjectKey(examSessionId, 1),
      code: 'EXAM_GRADING_CONFLICT',
    },
  ] as const)(
    'does not overwrite different bytes at a deterministic private artifact key',
    async ({ objectKey, code }) => {
      const fixture = await confirmedFixture();
      const key = objectKey(fixture.examSessionId);
      const foreignBytes = Buffer.from('different persisted private artifact');
      fixture.h.byteStore.objects.set(key, foreignBytes);

      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).rejects.toMatchObject({ code });
      expect(fixture.h.byteStore.objects.get(key)).toEqual(foreignBytes);
      expect(
        gradingEvents(await events(fixture.h, fixture.examSessionId)).some(
          (event) => event.eventType === 'exam_grading_completed',
        ),
      ).toBe(false);
    },
  );

  it('accepts an identical event CAS winner only after runtime read-back', async () => {
    const fixture = await confirmedFixture();
    let injectWinner = true;
    const append = fixture.h.baseStore.appendRecord.bind(fixture.h.baseStore);
    fixture.h.deps.store = withAppend(fixture.h.baseStore, async (record, options) => {
      if (
        injectWinner &&
        (record.payload as { eventType?: string }).eventType === 'exam_answer_key_started'
      ) {
        injectWinner = false;
        await append(record, options);
      }
      return append(record, options);
    });

    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).resolves.toMatchObject({ grading: { status: 'completed' } });
    expect(gradingEvents(await events(fixture.h, fixture.examSessionId))).toHaveLength(4);
  });
});

describe('Exam grading service concurrency and deletion', () => {
  it('serializes identical keys and conflicts a concurrent changed key', async () => {
    const identical = await confirmedFixture();
    const same = await Promise.all([
      confirmExamAnswerKeyAndGrade(identical.h.deps, identical.examSessionId, identical.request),
      confirmExamAnswerKeyAndGrade(identical.h.deps, identical.examSessionId, identical.request),
    ]);
    expect(same.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(gradingEvents(await events(identical.h, identical.examSessionId))).toHaveLength(4);

    const conflicting = await confirmedFixture();
    const settled = await Promise.allSettled([
      confirmExamAnswerKeyAndGrade(
        conflicting.h.deps,
        conflicting.examSessionId,
        conflicting.request,
      ),
      confirmExamAnswerKeyAndGrade(
        conflicting.h.deps,
        conflicting.examSessionId,
        changedKeyRequest(conflicting.request),
      ),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'EXAM_ANSWER_KEY_CONFLICT' });
    expect(gradingEvents(await events(conflicting.h, conflicting.examSessionId))).toHaveLength(4);
  });

  it.each([
    { partial: 'answer-key', failedEvent: 'exam_answer_key_confirmed', mutationFirst: true },
    { partial: 'answer-key', failedEvent: 'exam_answer_key_confirmed', mutationFirst: false },
    { partial: 'assessment', failedEvent: 'exam_grading_completed', mutationFirst: true },
    { partial: 'assessment', failedEvent: 'exam_grading_completed', mutationFirst: false },
  ] as const)(
    'serializes a partial $partial mutation/delete race (mutationFirst=$mutationFirst)',
    async ({ partial, failedEvent, mutationFirst }) => {
      const fixture = await confirmedFixture();
      failAppendOnce(fixture.h, failedEvent);
      await expect(
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
      ).rejects.toMatchObject({ code: 'EXAM_GRADING_FAILED' });
      const keyObject = examAuthoritativeAnswerKeyObjectKey(fixture.examSessionId, 1);
      const assessmentObject = examQuestionAssessmentsObjectKey(fixture.examSessionId, 1);
      expect(fixture.h.byteStore.objects.has(keyObject)).toBe(true);
      expect(fixture.h.byteStore.objects.has(assessmentObject)).toBe(partial === 'assessment');

      const grade = () =>
        confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request);
      const remove = () => deleteExam(fixture.h.deps, fixture.examSessionId);
      const settled = mutationFirst
        ? await Promise.allSettled([grade(), remove()])
        : await Promise.allSettled([remove(), grade()]);

      if (mutationFirst) {
        expect(settled[0]).toMatchObject({
          status: 'fulfilled',
          value: { grading: { status: 'completed' } },
        });
        expect(settled[1]).toMatchObject({ status: 'fulfilled', value: 'deleted' });
      } else {
        expect(settled[0]).toMatchObject({ status: 'fulfilled', value: 'deleted' });
        expect(settled[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'EXAM_NOT_FOUND' },
        });
      }
      expect(fixture.h.byteStore.objects.has(keyObject)).toBe(false);
      expect(fixture.h.byteStore.objects.has(assessmentObject)).toBe(false);
      await expect(
        resolveAuthoritativeExamAnswerKey(fixture.h.deps, fixture.examSessionId),
      ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    },
  );

  it('deletes partial key and assessment artifacts by exact key without prefix support', async () => {
    const fixture = await confirmedFixture();
    failAppendOnce(fixture.h, 'exam_grading_completed');
    await expect(
      confirmExamAnswerKeyAndGrade(fixture.h.deps, fixture.examSessionId, fixture.request),
    ).rejects.toMatchObject({ code: 'EXAM_GRADING_FAILED' });

    const keyObject = examAuthoritativeAnswerKeyObjectKey(fixture.examSessionId, 1);
    const assessmentObject = examQuestionAssessmentsObjectKey(fixture.examSessionId, 1);
    expect(fixture.h.byteStore.objects.has(keyObject)).toBe(true);
    expect(fixture.h.byteStore.objects.has(assessmentObject)).toBe(true);
    Object.defineProperty(fixture.h.byteStore, 'deletePrefix', { value: undefined });

    await expect(deleteExam(fixture.h.deps, fixture.examSessionId)).resolves.toBe('deleted');
    expect(fixture.h.byteStore.deleteCalls).toEqual(
      expect.arrayContaining([keyObject, assessmentObject]),
    );
    expect(fixture.h.byteStore.objects.has(keyObject)).toBe(false);
    expect(fixture.h.byteStore.objects.has(assessmentObject)).toBe(false);
  });
});
