import { createHash } from 'node:crypto';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  examErrorReviewObjectKey,
  examErrorSuggestionsObjectKey,
} from '@/lib/server/materials/object-keys';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';
import * as detectorModule from '@/lib/server/zhongkao/exam-error-observable-detector';
import {
  confirmExamErrorReview,
  getExamErrorReview,
  resolveConfirmedExamErrorPatternObservations,
  resolveConfirmedExamErrorPatternReview,
} from '@/lib/server/zhongkao/exam-error-review-service';
import * as aiBindingModule from '@/lib/server/zhongkao/exam-error-suggestions-ai-call';
import * as generatorModule from '@/lib/server/zhongkao/exam-error-suggestions-generator';
import * as suggestionsModule from '@/lib/server/zhongkao/exam-error-suggestions-service';
import { extractExamQuestionCandidates } from '@/lib/server/zhongkao/exam-extraction-service';
import {
  confirmExamAnswerKeyAndGrade,
  resolveAuthoritativeExamAnswerKey,
  resolveExamQuestionAssessments,
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
import { examRuntimeSessionId, loadExamRuntime } from '@/lib/server/zhongkao/exam-runtime';
import {
  createExam,
  deleteExam,
  getExam,
  type ExamServiceDeps,
} from '@/lib/server/zhongkao/exam-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { ExamErrorReviewRequestV1 } from '@/lib/zhongkao/exam-error-review';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import type { ExamHumanReviewDecision } from '@/lib/zhongkao/exam-human-review';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-06T06:00:00.000Z';
const OWNER = 'fictional-error-review-owner';
const PROFILE = 'fictional-error-review-profile';
const MATERIAL = `mat_${'c'.repeat(26)}`;
const REVIEW_SUFFIX = 'confirmed_exam_error_pattern_review_v1.json';

beforeAll(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));
afterEach(() => vi.restoreAllMocks());

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FaultByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly reads: string[] = [];
  readonly deletes: string[] = [];
  failPut = false;
  putResponseLoss = false;
  failReadBack = false;
  corruptReadBack = false;
  failDelete = false;
  onReviewPut?: () => Promise<void>;
  onReviewDelete?: () => Promise<void>;
  private armedRead = false;

  async put(key: string, body: MaterialByteInput): Promise<void> {
    if (!(Buffer.isBuffer(body) || body instanceof Uint8Array)) throw new Error('buffer required');
    this.puts.push(key);
    if (key.endsWith(REVIEW_SUFFIX)) {
      await this.onReviewPut?.();
      if (this.failPut) {
        this.failPut = false;
        throw new Error('PRIVATE_WRITE_PATH_CANARY');
      }
    }
    this.objects.set(key, Buffer.from(body));
    if (key.endsWith(REVIEW_SUFFIX)) {
      this.armedRead = this.failReadBack;
      this.failReadBack = false;
      if (this.corruptReadBack) {
        this.corruptReadBack = false;
        this.objects.set(key, Buffer.from('CORRUPT_REVIEW_CANARY'));
      }
      if (this.putResponseLoss) {
        this.putResponseLoss = false;
        throw new Error('PRIVATE_COMMITTED_PUT_CANARY');
      }
    }
  }

  async get(key: string): Promise<Buffer> {
    this.reads.push(key);
    if (key.endsWith(REVIEW_SUFFIX) && this.armedRead) {
      this.armedRead = false;
      throw new Error('PRIVATE_READ_PATH_CANARY');
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'not found');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (key.endsWith(REVIEW_SUFFIX)) {
      await this.onReviewDelete?.();
      if (this.failDelete) {
        this.failDelete = false;
        throw new Error('PRIVATE_DELETE_PATH_CANARY');
      }
    }
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

function keyedMutex(): ExamServiceDeps['withExamMutationLock'] {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const gate = deferred();
    const tail = previous.then(() => gate.promise);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      gate.resolve();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

async function fixture(options: { generate?: boolean; model?: boolean; requestId?: string } = {}) {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-error-review-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FaultByteStore();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([500, 700])
    .drawText(
      [
        '1. Fictional single-choice question with enough native text',
        '2. Give the final length in metres with enough native text',
        '3. Fictional exact-short question with enough native text',
        '4. Fictional correct-choice question with enough native text',
        '5. Fictional unsupported question with enough native text',
      ].join('\n'),
      { x: 36, y: 650, size: 11, lineHeight: 18, font },
    );
  const bytes = Buffer.from(await pdf.save());
  const asset: VerifiedOwnerMaterialAsset = {
    ownerMaterialId: MATERIAL,
    bytes,
    sha256: sha256(bytes),
    mimeType: 'application/pdf',
    byteLength: bytes.byteLength,
    record: {
      id: MATERIAL,
      ownerId: OWNER,
      kind: 'source',
      derivedFrom: null,
      mime: 'application/pdf',
      bytes: bytes.byteLength,
      originalName: 'fictional-paper.pdf',
      ossKey: 'private-test-source',
      sha256: sha256(bytes),
      status: 'ready',
      extraction: { status: 'idle' },
      createdAt: Date.parse(NOW),
      deletedAt: null,
    },
  };
  let second = 0;
  const deps: ExamServiceDeps = {
    store,
    ownerId: OWNER,
    byteStore,
    withExamMutationLock: keyedMutex(),
    captureSources: async (ownerId, ids) =>
      ownerId === OWNER && ids.every((id) => id === MATERIAL)
        ? { ok: true, assets: [asset] }
        : { ok: false, reason: 'unavailable' },
    now: () => new Date(Date.parse(NOW) + second++ * 1_000).toISOString(),
  };
  await saveStudentProfile(createInitialStudentProfile({ profileId: PROFILE, createdAt: NOW }), {
    store,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER),
    now: () => NOW,
    mintRecordId: () => 'fictional-error-review-profile-record',
  });
  const created = await createExam(deps, {
    clientRequestId: options.requestId ?? 'error-review-fixture',
    profileId: PROFILE,
    subjectId: 'math',
    documents: [{ role: 'question_paper', ownerMaterialId: MATERIAL }],
  });
  const examSessionId = created.exam.examSessionId;
  await extractExamQuestionCandidates(deps, examSessionId);
  await captureExamStudentResponses(deps, examSessionId, {
    format: 'numbered_text_v1',
    text: '1=C\n2=5 cm\n3=wrong\n4=B\n5=fictional proof',
  });
  const candidateReview = await getExamHumanReview(deps, examSessionId);
  const responses = await resolveExamStudentResponses(deps, examSessionId);
  const decisions: ExamHumanReviewDecision[] = candidateReview.questions.map((question) => ({
    decisionType: 'confirm_question',
    questionCandidateId: question.questionCandidateId,
  }));
  for (const response of responses.responseCandidates.candidates) {
    const match = responses.questionResponseMatches.matches.find(
      (entry) => entry.responseCandidateId === response.candidateId,
    );
    if (!match || match.status !== 'matched' || match.questionCandidateIds.length !== 1)
      throw new Error('fixture match failed');
    decisions.push({
      decisionType: 'confirm_response',
      responseCandidateId: response.candidateId,
      questionCandidateId: match.questionCandidateIds[0],
    });
  }
  await confirmExamHumanReview(deps, examSessionId, { schemaVersion: 1, decisions });
  const confirmed = await resolveConfirmedExamReviewFacts(deps, examSessionId);
  const questionId = (number: string) => {
    const question = confirmed.confirmedQuestions.find(
      (entry) => entry.locator.printedNumber === number,
    );
    if (!question) throw new Error(`fixture question missing: ${number}`);
    return question.confirmedQuestionId;
  };
  await confirmExamAnswerKeyAndGrade(deps, examSessionId, {
    schemaVersion: 1,
    entries: [
      { confirmedQuestionId: questionId('1'), type: 'single_choice', expectedOptionId: 'B' },
      { confirmedQuestionId: questionId('2'), type: 'numeric', expectedValue: '5' },
      {
        confirmedQuestionId: questionId('3'),
        type: 'exact_short_answer',
        acceptedAnswers: ['fixture expected answer'],
      },
      { confirmedQuestionId: questionId('4'), type: 'single_choice', expectedOptionId: 'B' },
      {
        confirmedQuestionId: questionId('5'),
        type: 'unassessed',
        reason: 'unsupported_question_type',
      },
    ],
  });
  const aiCall = vi.fn(async () => {
    throw new Error('real provider must never run');
  });
  const modelGenerator = vi.fn<suggestionsModule.ExamErrorSuggestionModelGenerator>(
    async (_ai, input) =>
      input.questions.map((question) => ({
        confirmedQuestionId: question.confirmedQuestionId,
        assessmentOutcome: 'incorrect',
        generationStatus: options.model === false ? 'no_suggestion' : 'generated',
        suggestions:
          options.model === false
            ? []
            : [
                {
                  kind: 'unit_error_candidate',
                  generationSource: 'model_candidate',
                  candidateStatus: 'candidate',
                  confidenceBand: 'medium',
                  evidence: [
                    { evidenceType: 'text_span', source: 'question', text: 'metres' },
                    { evidenceType: 'text_span', source: 'response', text: 'cm' },
                  ],
                },
              ],
      })),
  );
  if (options.generate !== false)
    await suggestionsModule.generateExamErrorSuggestions(
      {
        ...deps,
        errorSuggestionAiCall: aiCall,
        getErrorSuggestionModelExecution: () => ({
          status: 'used',
          stage: 'exam-error-suggestions',
          providerId: 'fictional-provider',
          modelId: 'fictional-model',
        }),
        generateModelErrorSuggestionDrafts: modelGenerator,
      },
      examSessionId,
    );
  const reviewKey = examErrorReviewObjectKey(examSessionId, 1, 1);
  const candidateKey = examErrorSuggestionsObjectKey(examSessionId, 1);
  return {
    deps,
    store,
    byteStore,
    examSessionId,
    reviewKey,
    candidateKey,
    questionId,
    aiCall,
    modelGenerator,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function requestFor(
  h: Fixture,
  decision: 'accept' | 'reject' = 'accept',
): Promise<ExamErrorReviewRequestV1> {
  const bundle = await getExamErrorReview(h.deps, h.examSessionId);
  return {
    schemaVersion: 1,
    questions: bundle.questions.map((question) => ({
      confirmedQuestionId: question.confirmedQuestionId,
      candidateDecisions: question.suggestions.map((candidate) => ({
        candidateId: candidate.candidateId,
        decision,
      })),
    })),
  };
}

async function reviewEvents(h: Fixture): Promise<ExamEvent[]> {
  const records = await h.store.listRecords(examRuntimeSessionId(h.examSessionId));
  return records
    .map((record) => record.payload as ExamEvent)
    .filter((event) => event.eventType.startsWith('exam_error_review_'));
}

function overrideAppend(h: Fixture, append: RuntimeStore['appendRecord']): void {
  h.deps.store = new Proxy(h.store, {
    get(target, property, receiver) {
      if (property === 'appendRecord') return append;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function failAppendOnce(h: Fixture, eventType: ExamEvent['eventType'], committed = false): void {
  let armed = true;
  overrideAppend(h, async (record, options) => {
    if (armed && (record.payload as ExamEvent).eventType === eventType) {
      armed = false;
      if (committed) await h.store.appendRecord(record, options);
      throw new Error('PRIVATE_APPEND_CAUSE_CANARY');
    }
    return h.store.appendRecord(record, options);
  });
}

function preservedObjects(h: Fixture): Map<string, string> {
  return new Map(
    [...h.byteStore.objects]
      .filter(([key]) => key !== h.reviewKey)
      .map(([key, bytes]) => [key, sha256(bytes)]),
  );
}

describe('Exam error review service with real RuntimeStore and complete source chain', () => {
  it('requires explicit confirmation for both generation sources and retains zero-candidate questions', async () => {
    const h = await fixture();
    const before = await getExamErrorReview(h.deps, h.examSessionId);
    expect(before.status).toBe('not_started');
    expect(before.confirmedPatternObservations).toBeUndefined();
    expect(before.questions).toHaveLength(3);
    expect(
      before.questions.find((question) => question.confirmedQuestionId === h.questionId('3'))
        ?.suggestions,
    ).toEqual([]);
    expect(
      new Set(
        before.questions.flatMap((question) =>
          question.suggestions.map((candidate) => candidate.generationSource),
        ),
      ),
    ).toEqual(new Set(['deterministic_candidate', 'model_candidate']));
    await expect(
      resolveConfirmedExamErrorPatternObservations(h.deps, h.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_ERROR_REVIEW_NOT_READY' });
    const request = await requestFor(h);
    const accepted = request.questions.flatMap((question) => question.candidateDecisions).length;
    const candidateBytes = Buffer.from(h.byteStore.objects.get(h.candidateKey)!);
    const result = await confirmExamErrorReview(h.deps, h.examSessionId, request);
    expect(result).toMatchObject({
      replayed: false,
      errorReview: {
        status: 'confirmed',
        reviewedQuestionCount: 3,
        acceptedCandidateCount: accepted,
        rejectedCandidateCount: 0,
        confirmedObservationCount: accepted,
      },
    });
    const observations = await resolveConfirmedExamErrorPatternObservations(
      h.deps,
      h.examSessionId,
    );
    expect(observations).toHaveLength(accepted);
    expect(
      observations.every(
        (observation) => observation.authoritySource === 'owner_confirmed_error_pattern',
      ),
    ).toBe(true);
    expect(
      new Set(observations.map((observation) => observation.candidateGenerationSource)),
    ).toEqual(new Set(['deterministic_candidate', 'model_candidate']));
    expect(h.byteStore.objects.get(h.candidateKey)).toEqual(candidateBytes);
    expect(JSON.parse(candidateBytes.toString()).candidateStatus).toBe('candidate');
    expect((await reviewEvents(h)).map((event) => event.eventType)).toEqual([
      'exam_error_review_started',
      'exam_error_review_completed',
    ]);
  });

  it('reject-all creates no observations while preserving explicit decisions and incorrect assessments', async () => {
    const h = await fixture();
    const assessments = await resolveExamQuestionAssessments(h.deps, h.examSessionId);
    const request = await requestFor(h, 'reject');
    // Exercise a noncanonical request order regardless of the PDF-derived candidate IDs.
    for (const question of request.questions) {
      question.candidateDecisions.sort((left, right) =>
        right.candidateId.localeCompare(left.candidateId, 'en'),
      );
    }
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    const artifact = await resolveConfirmedExamErrorPatternReview(h.deps, h.examSessionId);
    expect(artifact.confirmedPatternObservations).toEqual([]);
    expect(artifact.rejectedCandidateCount).toBeGreaterThan(0);
    expect(
      artifact.questionResults.every((question) => question.hasConfirmedPattern === false),
    ).toBe(true);
    expect(artifact.questions).toHaveLength(request.questions.length);
    for (const question of request.questions) {
      const saved = artifact.questions.find(
        (entry) => entry.confirmedQuestionId === question.confirmedQuestionId,
      );
      expect(saved?.candidateDecisions).toHaveLength(question.candidateDecisions.length);
      expect(
        new Map(saved!.candidateDecisions.map((entry) => [entry.candidateId, entry.decision])),
      ).toEqual(
        new Map(question.candidateDecisions.map((entry) => [entry.candidateId, entry.decision])),
      );
    }
    expect(await resolveExamQuestionAssessments(h.deps, h.examSessionId)).toEqual(assessments);
    expect(JSON.stringify(artifact)).not.toMatch(
      /no_error|no_cause|no_problem|careless|anxiety|intelligence/,
    );
  });

  it('supports a mixed accepted/rejected overlay without changing source candidate facts', async () => {
    const h = await fixture();
    const request = await requestFor(h, 'reject');
    const acceptedQuestion = request.questions.find(
      (question) => question.candidateDecisions.length > 0,
    )!;
    acceptedQuestion.candidateDecisions[0].decision = 'accept';
    const original = preservedObjects(h);
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    const result = await getExamErrorReview(h.deps, h.examSessionId);
    expect(result.confirmedPatternObservations).toHaveLength(1);
    expect(
      result.questions
        .flatMap((question) => question.suggestions)
        .filter((candidate) => candidate.decision === 'accept'),
    ).toHaveLength(1);
    expect(preservedObjects(h)).toEqual(original);
  });

  it.each([
    'missing-question',
    'missing-zero-question',
    'missing-candidate',
    'unknown-question',
    'unknown-candidate',
    'wrong-question',
  ] as const)('rejects %s coverage before reserving any durable review', async (kind) => {
    const h = await fixture();
    const request = await requestFor(h);
    const valid = structuredClone(request);
    const populated = request.questions.find((question) => question.candidateDecisions.length > 0)!;
    if (kind === 'missing-question')
      request.questions = request.questions.filter((question) => question !== populated);
    if (kind === 'missing-zero-question')
      request.questions = request.questions.filter(
        (question) => question.candidateDecisions.length > 0,
      );
    if (kind === 'missing-candidate') populated.candidateDecisions.pop();
    if (kind === 'unknown-question')
      request.questions.push({ confirmedQuestionId: 'unknown-question', candidateDecisions: [] });
    if (kind === 'unknown-candidate')
      populated.candidateDecisions.push({ candidateId: 'unknown-candidate', decision: 'accept' });
    if (kind === 'wrong-question') {
      const empty = request.questions.find((question) => question.candidateDecisions.length === 0)!;
      empty.candidateDecisions.push(populated.candidateDecisions.pop()!);
    }
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
      code: expect.stringMatching(/^EXAM_ERROR_REVIEW_(INPUT_INVALID|INCOMPLETE)$/),
    });
    expect(await reviewEvents(h)).toHaveLength(0);
    expect(h.byteStore.objects.has(h.reviewKey)).toBe(false);
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, valid)).resolves.toMatchObject({
      errorReview: { status: 'confirmed' },
    });
  });

  it('replays reordered requests with stable observation IDs and refuses changed decisions', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    const before = await resolveConfirmedExamErrorPatternReview(h.deps, h.examSessionId);
    const bytes = Buffer.from(h.byteStore.objects.get(h.reviewKey)!);
    request.questions.reverse().forEach((question) => question.candidateDecisions.reverse());
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject({
      replayed: true,
    });
    expect(await resolveConfirmedExamErrorPatternReview(h.deps, h.examSessionId)).toEqual(before);
    request.questions.find(
      (question) => question.candidateDecisions.length > 0,
    )!.candidateDecisions[0].decision = 'reject';
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_ERROR_REVIEW_CONFLICT',
    });
    expect(h.byteStore.objects.get(h.reviewKey)).toEqual(bytes);
    expect(await reviewEvents(h)).toHaveLength(2);
  });

  it('denies cross-owner, guessed-ID and missing-profile reads and writes without source disclosure', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    const other = { ...h.deps, ownerId: 'fictional-other-owner' };
    for (const operation of [
      () => getExamErrorReview(other, h.examSessionId),
      () => confirmExamErrorReview(other, h.examSessionId, request),
      () => resolveConfirmedExamErrorPatternObservations(other, h.examSessionId),
      () => getExamErrorReview(h.deps, `exam:v1:${'f'.repeat(64)}`),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(await reviewEvents(h)).toEqual([]);
  });

  it('requires the completed candidate artifact before review starts', async () => {
    const h = await fixture({ generate: false });
    await expect(getExamErrorReview(h.deps, h.examSessionId)).rejects.toMatchObject({
      code: 'EXAM_ERROR_REVIEW_NOT_READY',
    });
    await expect(
      confirmExamErrorReview(h.deps, h.examSessionId, { schemaVersion: 1, questions: [] }),
    ).rejects.toMatchObject({ code: 'EXAM_ERROR_REVIEW_NOT_READY' });
    expect(await reviewEvents(h)).toEqual([]);
  });

  it.each(['exam_error_review_started', 'exam_error_review_completed'] as const)(
    'recovers %s append failure without duplicate logical events',
    async (eventType) => {
      const h = await fixture();
      const request = await requestFor(h);
      failAppendOnce(h, eventType);
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
        code: 'EXAM_ERROR_REVIEW_FAILED',
      });
      const state = (await loadExamRuntime(h.deps, h.examSessionId)).state;
      expect(state.errorReview?.status).not.toBe('confirmed');
      expect(h.byteStore.objects.has(h.reviewKey)).toBe(
        eventType === 'exam_error_review_completed',
      );
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject(
        { errorReview: { status: 'confirmed' } },
      );
      expect(await reviewEvents(h)).toHaveLength(2);
      expect(h.byteStore.puts.filter((key) => key === h.reviewKey)).toHaveLength(1);
    },
  );

  it.each(['exam_error_review_started', 'exam_error_review_completed'] as const)(
    'recovers committed %s response loss in the same request',
    async (eventType) => {
      const h = await fixture();
      const request = await requestFor(h);
      failAppendOnce(h, eventType, true);
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject(
        { errorReview: { status: 'confirmed' } },
      );
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject(
        { replayed: true },
      );
      expect(await reviewEvents(h)).toHaveLength(2);
    },
  );

  it.each(['failPut', 'failReadBack'] as const)(
    'recovers %s after a durable started event and reserves the original decisions',
    async (fault) => {
      const h = await fixture();
      const request = await requestFor(h);
      h.byteStore[fault] = true;
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
        code: 'EXAM_ERROR_REVIEW_FAILED',
      });
      expect((await loadExamRuntime(h.deps, h.examSessionId)).state.errorReview?.status).toBe(
        'confirming',
      );
      const changed = structuredClone(request);
      changed.questions.find(
        (question) => question.candidateDecisions.length > 0,
      )!.candidateDecisions[0].decision = 'reject';
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, changed)).rejects.toMatchObject({
        code: 'EXAM_ERROR_REVIEW_CONFLICT',
      });
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject(
        { errorReview: { status: 'confirmed' } },
      );
      expect(await reviewEvents(h)).toHaveLength(2);
    },
  );

  it('recovers a committed artifact write response loss without overwriting the artifact', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    h.byteStore.putResponseLoss = true;
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).resolves.toMatchObject({
      errorReview: { status: 'confirmed' },
    });
    expect(h.byteStore.puts.filter((key) => key === h.reviewKey)).toHaveLength(1);
  });

  it('rejects corrupt read-back bytes and never claims confirmation or overwrites them on retry', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    h.byteStore.corruptReadBack = true;
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_ERROR_REVIEW_CONFLICT',
    });
    expect((await loadExamRuntime(h.deps, h.examSessionId)).state.errorReview?.status).toBe(
      'confirming',
    );
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_ERROR_REVIEW_CONFLICT',
    });
    expect(h.byteStore.puts.filter((key) => key === h.reviewKey)).toHaveLength(1);
  });

  it('serializes same-decision concurrency to one review and replays the loser', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        confirmExamErrorReview(h.deps, h.examSessionId, structuredClone(request)),
      ),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await reviewEvents(h)).toHaveLength(2);
    expect(h.byteStore.puts.filter((key) => key === h.reviewKey)).toHaveLength(1);
  });

  it('serializes conflicting concurrent decisions and preserves the winning complete set', async () => {
    const h = await fixture();
    const accept = await requestFor(h);
    const reject = await requestFor(h, 'reject');
    const results = await Promise.allSettled([
      confirmExamErrorReview(h.deps, h.examSessionId, accept),
      confirmExamErrorReview(h.deps, h.examSessionId, reject),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'EXAM_ERROR_REVIEW_CONFLICT' },
    });
    expect(
      (await resolveConfirmedExamErrorPatternReview(h.deps, h.examSessionId))
        .acceptedCandidateCount,
    ).toBeGreaterThan(0);
    expect(await reviewEvents(h)).toHaveLength(2);
  });

  it('keeps ordinary Exam DTO and Runtime events aggregate-only and private artifacts source-bound', async () => {
    const h = await fixture();
    await confirmExamErrorReview(h.deps, h.examSessionId, await requestFor(h));
    const ordinary = await getExam(h.deps, h.examSessionId);
    const events = await reviewEvents(h);
    const serialized = JSON.stringify({ ordinary, events });
    for (const value of [
      '5 cm',
      'fixture expected answer',
      'metres',
      'unit_error_candidate',
      'owner_confirmed_error_pattern',
      'private-test-source',
      REVIEW_SUFFIX,
    ])
      expect(serialized).not.toContain(value);
    const publicSerialized = JSON.stringify(ordinary);
    for (const field of [
      'sha256',
      'learnerKey',
      'errorReviewRef',
      'clientRequestId',
      'operationId',
      'candidateId',
    ])
      expect(publicSerialized).not.toContain(field);
    const dedicated = await getExamErrorReview(h.deps, h.examSessionId);
    expect(JSON.stringify(dedicated)).toContain('5 cm');
    for (const field of [
      'expectedValue',
      'expectedOptionId',
      'acceptedAnswers',
      'sourceSuggestions',
      'generationRef',
      'semanticFingerprint',
      'providerId',
      'modelId',
    ])
      expect(JSON.stringify(dedicated)).not.toContain(field);
  });

  it('runs no provider, generator, detector, grading or mapping writes during POST, GET and resolver replay', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    const before = preservedObjects(h);
    const history = await h.store.listRecords(examRuntimeSessionId(h.examSessionId));
    const detector = vi
      .spyOn(detectorModule, 'detectExamObservableErrorSuggestions')
      .mockImplementation(() => {
        throw new Error('detector rerun');
      });
    const generator = vi
      .spyOn(generatorModule, 'generateExamErrorSuggestionDrafts')
      .mockImplementation(async () => {
        throw new Error('generator rerun');
      });
    const generation = vi
      .spyOn(suggestionsModule, 'generateExamErrorSuggestions')
      .mockImplementation(async () => {
        throw new Error('candidate regeneration');
      });
    const binding = vi
      .spyOn(aiBindingModule, 'createExamErrorSuggestionAiCall')
      .mockImplementation(() => {
        throw new Error('provider binding');
      });
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    await getExamErrorReview(h.deps, h.examSessionId);
    await resolveConfirmedExamErrorPatternObservations(h.deps, h.examSessionId);
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    for (const spy of [detector, generator, generation, binding, h.aiCall])
      expect(spy).not.toHaveBeenCalled();
    expect(h.modelGenerator).toHaveBeenCalledTimes(1);
    expect(preservedObjects(h)).toEqual(before);
    const after = await h.store.listRecords(examRuntimeSessionId(h.examSessionId));
    expect(after.slice(0, history.length)).toEqual(history);
    expect(
      after.slice(history.length).map((record) => (record.payload as ExamEvent).eventType),
    ).toEqual(['exam_error_review_started', 'exam_error_review_completed']);
  });

  it.each(['missing', 'truncated', 'same-length-tamper'] as const)(
    'fails closed on %s candidate artifact with no regeneration or unrelated read failure',
    async (kind) => {
      const h = await fixture();
      const request = await requestFor(h);
      const key = await resolveAuthoritativeExamAnswerKey(h.deps, h.examSessionId);
      const assessments = await resolveExamQuestionAssessments(h.deps, h.examSessionId);
      const original = Buffer.from(h.byteStore.objects.get(h.candidateKey)!);
      if (kind === 'missing') h.byteStore.objects.delete(h.candidateKey);
      if (kind === 'truncated')
        h.byteStore.objects.set(h.candidateKey, original.subarray(0, original.length - 1));
      if (kind === 'same-length-tamper') {
        original[original.length - 2] ^= 1;
        h.byteStore.objects.set(h.candidateKey, original);
      }
      for (const operation of [
        () => getExamErrorReview(h.deps, h.examSessionId),
        () => confirmExamErrorReview(h.deps, h.examSessionId, request),
      ])
        await expect(operation()).rejects.toMatchObject({
          code: 'EXAM_ERROR_REVIEW_SOURCE_CHANGED',
        });
      expect(await resolveAuthoritativeExamAnswerKey(h.deps, h.examSessionId)).toEqual(key);
      expect(await resolveExamQuestionAssessments(h.deps, h.examSessionId)).toEqual(assessments);
      await expect(getExam(h.deps, h.examSessionId)).resolves.toBeDefined();
      expect(await reviewEvents(h)).toEqual([]);
    },
  );

  it.each(['missing', 'same-length-tamper'] as const)(
    'isolates %s review artifact corruption from candidates and upstream facts',
    async (kind) => {
      const h = await fixture();
      await confirmExamErrorReview(h.deps, h.examSessionId, await requestFor(h));
      const candidates = Buffer.from(h.byteStore.objects.get(h.candidateKey)!);
      if (kind === 'missing') h.byteStore.objects.delete(h.reviewKey);
      else {
        const corrupt = Buffer.from(h.byteStore.objects.get(h.reviewKey)!);
        corrupt[corrupt.length - 2] ^= 1;
        h.byteStore.objects.set(h.reviewKey, corrupt);
      }
      await expect(
        resolveConfirmedExamErrorPatternObservations(h.deps, h.examSessionId),
      ).rejects.toMatchObject({ code: 'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT' });
      await expect(getExamErrorReview(h.deps, h.examSessionId)).rejects.toMatchObject({
        code: 'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
      });
      expect(h.byteStore.objects.get(h.candidateKey)).toEqual(candidates);
      await expect(resolveExamQuestionAssessments(h.deps, h.examSessionId)).resolves.toBeDefined();
      await expect(getExam(h.deps, h.examSessionId)).resolves.toBeDefined();
    },
  );

  it.each([false, true])(
    'deletes the review artifact after partial=%s and makes repeated deletion idempotent',
    async (partial) => {
      const h = await fixture();
      const request = await requestFor(h);
      if (partial) failAppendOnce(h, 'exam_error_review_completed');
      if (partial)
        await expect(
          confirmExamErrorReview(h.deps, h.examSessionId, request),
        ).rejects.toBeDefined();
      else await confirmExamErrorReview(h.deps, h.examSessionId, request);
      expect(h.byteStore.objects.has(h.reviewKey)).toBe(true);
      const unrelatedKey = examErrorReviewObjectKey(`exam:v1:${'9'.repeat(64)}`, 1, 1);
      h.byteStore.objects.set(unrelatedKey, Buffer.from('other-exam-canary'));
      await deleteExam(h.deps, h.examSessionId);
      await deleteExam(h.deps, h.examSessionId);
      expect(h.byteStore.objects.has(h.reviewKey)).toBe(false);
      expect(h.byteStore.objects.get(unrelatedKey)?.toString()).toBe('other-exam-canary');
      await expect(getExamErrorReview(h.deps, h.examSessionId)).rejects.toMatchObject({
        code: 'EXAM_NOT_FOUND',
      });
      await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
        code: 'EXAM_NOT_FOUND',
      });
    },
  );

  it('retries a delete byte failure with safe errors and keeps review writes fenced', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    h.byteStore.failDelete = true;
    await expect(deleteExam(h.deps, h.examSessionId)).rejects.toMatchObject({
      code: 'EXAM_DELETE_FAILED',
    });
    expect((await loadExamRuntime(h.deps, h.examSessionId)).state.status).toBe('deleting');
    await expect(confirmExamErrorReview(h.deps, h.examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_NOT_FOUND',
    });
    await deleteExam(h.deps, h.examSessionId);
    expect(h.byteStore.objects.has(h.reviewKey)).toBe(false);
  });

  it('linearizes a review before deletion and leaves no review bytes behind', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    const entered = deferred();
    const release = deferred();
    h.byteStore.onReviewPut = async () => {
      entered.resolve();
      await release.promise;
    };
    const confirming = confirmExamErrorReview(h.deps, h.examSessionId, request);
    await entered.promise;
    const deleting = deleteExam(h.deps, h.examSessionId);
    release.resolve();
    await expect(confirming).resolves.toMatchObject({ errorReview: { status: 'confirmed' } });
    await deleting;
    expect(h.byteStore.objects.has(h.reviewKey)).toBe(false);
    await expect(
      resolveConfirmedExamErrorPatternObservations(h.deps, h.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
  });

  it('linearizes deletion before a later review and prevents artifact resurrection', async () => {
    const h = await fixture();
    const request = await requestFor(h);
    await confirmExamErrorReview(h.deps, h.examSessionId, request);
    const entered = deferred();
    const release = deferred();
    h.byteStore.onReviewDelete = async () => {
      entered.resolve();
      await release.promise;
    };
    const deleting = deleteExam(h.deps, h.examSessionId);
    await entered.promise;
    const confirming = confirmExamErrorReview(h.deps, h.examSessionId, request);
    const rejected = expect(confirming).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    release.resolve();
    await deleting;
    await rejected;
    expect(h.byteStore.objects.has(h.reviewKey)).toBe(false);
  });
});
