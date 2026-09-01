import { createHash } from 'node:crypto';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  examHumanReviewObjectKey,
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
  confirmExamHumanReview,
  getExamHumanReview,
  resolveConfirmedExamReviewFacts,
} from '@/lib/server/zhongkao/exam-human-review-service';
import {
  captureExamStudentResponses,
  resolveExamStudentResponses,
} from '@/lib/server/zhongkao/exam-response-service';
import {
  createExam,
  deleteExam,
  getExam,
  type ExamServiceDeps,
} from '@/lib/server/zhongkao/exam-service';
import { examRuntimeSessionId } from '@/lib/server/zhongkao/exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import type {
  ExamHumanReviewDecision,
  ExamHumanReviewRequest,
} from '@/lib/zhongkao/exam-human-review';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-01T04:00:00.000Z';
const OWNER = 'fictional-human-review-owner';
const PROFILE = 'fictional-human-review-profile';
const MATERIALS = {
  question: `mat_${'9'.repeat(26)}`,
  response: `mat_${'a'.repeat(26)}`,
  answer: `mat_${'b'.repeat(26)}`,
} as const;

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
  failReviewPutOnce = false;
  failReviewReadBackOnce = false;
  private failArmedReviewRead = false;

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    this.putCalls.push(key);
    if (this.failReviewPutOnce && key.includes('/human_review_v')) {
      this.failReviewPutOnce = false;
      throw new Error('private put failure');
    }
    this.objects.set(key, buffered(body));
    if (this.failReviewReadBackOnce && key.includes('/human_review_v')) {
      this.failReviewReadBackOnce = false;
      this.failArmedReviewRead = true;
    }
  }

  async get(key: string): Promise<Buffer> {
    this.getCalls.push(key);
    if (this.failArmedReviewRead && key.includes('/human_review_v')) {
      this.failArmedReviewRead = false;
      throw new Error('private read failure');
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

async function textPdf(): Promise<Buffer> {
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

interface Harness {
  baseStore: RuntimeStore;
  deps: ExamServiceDeps;
  byteStore: FakeByteStore;
}

async function harness(): Promise<Harness> {
  const baseStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-human-review-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FakeByteStore();
  const question = await textPdf();
  const assets = new Map<string, VerifiedOwnerMaterialAsset>([
    [MATERIALS.question, source(MATERIALS.question, question, 'application/pdf', 'paper.pdf')],
    [
      MATERIALS.response,
      source(
        MATERIALS.response,
        Buffer.from('private response image'),
        'text/plain',
        'response.txt',
      ),
    ],
    [
      MATERIALS.answer,
      source(MATERIALS.answer, Buffer.from('private answer key'), 'text/plain', 'answers.txt'),
    ],
  ]);
  let second = 0;
  const deps: ExamServiceDeps = {
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
    mintRecordId: () => 'profile-record-human-review',
  });
  return { baseStore, deps, byteStore };
}

async function preparedExam() {
  const h = await harness();
  const created = await createExam(h.deps, {
    clientRequestId: 'human-review-fixture',
    profileId: PROFILE,
    subjectId: 'math',
    documents: [
      { role: 'question_paper', ownerMaterialId: MATERIALS.question },
      { role: 'student_response', ownerMaterialId: MATERIALS.response },
      { role: 'answer_key', ownerMaterialId: MATERIALS.answer },
    ],
  });
  await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
  await captureExamStudentResponses(h.deps, created.exam.examSessionId, {
    format: 'numbered_text_v1',
    text: '1=B\n2=',
  });
  return { h, examSessionId: created.exam.examSessionId };
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

async function events(h: Harness, examSessionId: string): Promise<ExamEvent[]> {
  const records = await h.baseStore.listRecords(examRuntimeSessionId(examSessionId));
  return records.map((record) => record.payload as ExamEvent);
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

describe('Exam human review service', () => {
  it('requires matching-ready sources and enforces owner authority', async () => {
    const h = await harness();
    const created = await createExam(h.deps, {
      clientRequestId: 'not-ready-review',
      profileId: PROFILE,
      subjectId: 'math',
      documents: [{ role: 'question_paper', ownerMaterialId: MATERIALS.question }],
    });
    await expect(getExamHumanReview(h.deps, created.exam.examSessionId)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_NOT_READY',
    });

    const prepared = await preparedExam();
    await expect(
      getExamHumanReview(
        { ...prepared.h.deps, ownerId: 'fictional-foreign-owner' },
        prepared.examSessionId,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
  });

  it('builds an owner-only review bundle without reading answer-key or response snapshots', async () => {
    const { h, examSessionId } = await preparedExam();
    h.byteStore.getCalls.length = 0;
    const bundle = await getExamHumanReview(h.deps, examSessionId);
    expect(bundle.reviewStatus).toBe('not_started');
    expect(bundle.questions.length).toBeGreaterThan(0);
    expect(bundle.responses.map((response) => response.rawAnswerText)).toEqual(['B', '']);
    expect(bundle.matches).toHaveLength(bundle.responses.length);

    const exam = await getExam(h.deps, examSessionId);
    const protectedKeys = exam.documents
      .filter((document) => document.role !== 'question_paper')
      .map((document) => examSnapshotObjectKey(examSessionId, document.examDocumentId));
    expect(h.byteStore.getCalls).not.toEqual(expect.arrayContaining(protectedKeys));
    expect(JSON.stringify(bundle)).not.toMatch(/objectKey|sha256|artifactRef|runtimeSessionId/u);
  });

  it.each([
    ['question candidate', 'question_candidates_v1.json', 'EXAM_EXTRACTION_CORRUPT'],
    ['student response', 'student_response_candidates_v1.json', 'EXAM_RESPONSE_ARTIFACT_CORRUPT'],
    [
      'question-response match',
      'question_response_matches_v1.json',
      'EXAM_RESPONSE_ARTIFACT_CORRUPT',
    ],
  ] as const)(
    'fails a corrupt %s resolver before review provenance starts',
    async (_name, suffix, code) => {
      const { h, examSessionId } = await preparedExam();
      const request = await reviewRequest(h, examSessionId);
      const key = [...h.byteStore.objects.keys()].find((candidate) => candidate.endsWith(suffix));
      expect(key).toBeDefined();
      h.byteStore.objects.set(key!, Buffer.from('{"corrupt":true}'));

      await expect(confirmExamHumanReview(h.deps, examSessionId, request)).rejects.toMatchObject({
        code,
      });
      expect(
        (await events(h, examSessionId)).some((event) =>
          event.eventType.startsWith('exam_human_review_'),
        ),
      ).toBe(false);
    },
  );

  it('persists event-first confirmed facts and exposes only a safe ordinary summary', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    const reviewKey = examHumanReviewObjectKey(examSessionId, 1, 1, 1);
    const originalPut = h.byteStore.put.bind(h.byteStore);
    h.byteStore.put = async (key, body, mime) => {
      if (key === reviewKey) {
        const history = await events(h, examSessionId);
        expect(history.at(-1)?.eventType).toBe('exam_human_review_started');
      }
      return originalPut(key, body, mime);
    };

    const result = await confirmExamHumanReview(h.deps, examSessionId, request);
    expect(result.replayed).toBe(false);
    expect(result.humanReview).toMatchObject({ status: 'confirmed' });
    const history = await events(h, examSessionId);
    expect(history.slice(-2).map((event) => event.eventType)).toEqual([
      'exam_human_review_started',
      'exam_human_review_completed',
    ]);
    expect(JSON.stringify(history.slice(-2))).not.toContain('rawAnswerText');
    expect(JSON.stringify(history.slice(-2))).not.toContain('questionText');

    const facts = await resolveConfirmedExamReviewFacts(h.deps, examSessionId);
    expect(facts.confirmedQuestionCount).toBeGreaterThan(0);
    expect(facts.confirmedQuestionCount).toBe(facts.confirmedResponseCount);
    expect(facts.confirmedQuestionCount).toBe(facts.confirmedMatchCount);
    expect(JSON.stringify(facts)).not.toMatch(/"correct"|"incorrect"|score|gradingSpec/u);
    const ordinary = await getExam(h.deps, examSessionId);
    expect(ordinary.humanReview).toEqual(result.humanReview);
    expect(JSON.stringify(ordinary)).not.toMatch(/rawAnswerText|questionText|decisionSemantic/u);
  });

  it('replays the same full set and rejects a changed decision set', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      replayed: true,
    });
    const changed: { schemaVersion: 1; decisions: ExamHumanReviewDecision[] } = {
      schemaVersion: 1,
      decisions: request.decisions.map((decision) => structuredClone(decision)),
    };
    const responseIndex = changed.decisions.findIndex(
      (decision) => decision.decisionType === 'confirm_response',
    );
    const response = changed.decisions[responseIndex] as Extract<
      ExamHumanReviewDecision,
      { decisionType: 'confirm_response' }
    >;
    changed.decisions[responseIndex] = {
      decisionType: 'correct_response',
      responseCandidateId: response.responseCandidateId,
      questionCandidateId: response.questionCandidateId,
      responseOverride: { status: 'text', rawAnswerText: '-2' },
    };
    await expect(confirmExamHumanReview(h.deps, examSessionId, changed)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_CONFLICT',
    });
    expect(
      (await events(h, examSessionId)).filter((event) => event.eventType.startsWith('exam_human')),
    ).toHaveLength(2);
  });

  it('does not write an artifact when the started event append fails and retries deterministically', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    let fail = true;
    const append = h.baseStore.appendRecord.bind(h.baseStore);
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      if (
        fail &&
        (record.payload as { eventType?: string }).eventType === 'exam_human_review_started'
      ) {
        fail = false;
        throw new Error('review start append failed');
      }
      return append(record, options);
    });
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_FAILED',
    });
    expect([...h.byteStore.objects.keys()].some((key) => key.includes('/human_review_v'))).toBe(
      false,
    );
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      humanReview: { status: 'confirmed' },
    });
  });

  it('recovers artifact bytes written before a failed completed event', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    let fail = true;
    const append = h.baseStore.appendRecord.bind(h.baseStore);
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      if (
        fail &&
        (record.payload as { eventType?: string }).eventType === 'exam_human_review_completed'
      ) {
        fail = false;
        throw new Error('review completed append failed');
      }
      return append(record, options);
    });
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_FAILED',
    });
    expect([...h.byteStore.objects.keys()].some((key) => key.includes('/human_review_v'))).toBe(
      true,
    );
    expect((await getExam(h.deps, examSessionId)).humanReview.status).toBe('confirming');
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      humanReview: { status: 'confirmed' },
    });
  });

  it('recovers committed completed-event response loss without duplicate logical events', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    let loseResponse = true;
    const append = h.baseStore.appendRecord.bind(h.baseStore);
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      const result = await append(record, options);
      if (
        loseResponse &&
        (record.payload as { eventType?: string }).eventType === 'exam_human_review_completed'
      ) {
        loseResponse = false;
        throw new Error('committed response lost');
      }
      return result;
    });
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      humanReview: { status: 'confirmed' },
    });
    expect(
      (await events(h, examSessionId)).filter(
        (event) => event.eventType === 'exam_human_review_completed',
      ),
    ).toHaveLength(1);
  });

  it('keeps failed artifact writes unconfirmed and permits deterministic retry', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    h.byteStore.failReviewPutOnce = true;
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_FAILED',
    });
    expect((await getExam(h.deps, examSessionId)).humanReview.status).toBe('confirming');
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      humanReview: { status: 'confirmed' },
    });
  });

  it('keeps a failed artifact read-back unconfirmed and verifies it on retry', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    h.byteStore.failReviewReadBackOnce = true;
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_FAILED',
    });
    expect((await getExam(h.deps, examSessionId)).humanReview.status).toBe('confirming');
    expect([...h.byteStore.objects.keys()].some((key) => key.includes('/human_review_v'))).toBe(
      true,
    );
    await expect(confirmExamHumanReview(h.deps, examSessionId, request)).resolves.toMatchObject({
      humanReview: { status: 'confirmed' },
    });
  });

  it('fails closed on confirmed artifact corruption', async () => {
    const { h, examSessionId } = await preparedExam();
    const request = await reviewRequest(h, examSessionId);
    await confirmExamHumanReview(h.deps, examSessionId, request);
    const key = examHumanReviewObjectKey(examSessionId, 1, 1, 1);
    h.byteStore.objects.set(key, Buffer.from('{"private":"tampered"}'));
    await expect(resolveConfirmedExamReviewFacts(h.deps, examSessionId)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_ARTIFACT_CORRUPT',
    });
    await expect(getExamHumanReview(h.deps, examSessionId)).rejects.toMatchObject({
      code: 'EXAM_REVIEW_ARTIFACT_CORRUPT',
    });
  });

  it('serializes concurrent identical reviews and conflicts a different concurrent review', async () => {
    const first = await preparedExam();
    const request = await reviewRequest(first.h, first.examSessionId);
    const same = await Promise.all([
      confirmExamHumanReview(first.h.deps, first.examSessionId, request),
      confirmExamHumanReview(first.h.deps, first.examSessionId, request),
    ]);
    expect(same.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(
      (await events(first.h, first.examSessionId)).filter((event) =>
        event.eventType.startsWith('exam_human_review_'),
      ),
    ).toHaveLength(2);

    const second = await preparedExam();
    const original = await reviewRequest(second.h, second.examSessionId);
    const changed: { schemaVersion: 1; decisions: ExamHumanReviewDecision[] } = {
      schemaVersion: 1,
      decisions: original.decisions.map((decision) => structuredClone(decision)),
    };
    const questionIndex = changed.decisions.findIndex(
      (decision) => decision.decisionType === 'confirm_question',
    );
    const question = changed.decisions[questionIndex] as Extract<
      ExamHumanReviewDecision,
      { decisionType: 'confirm_question' }
    >;
    changed.decisions[questionIndex] = {
      decisionType: 'correct_question',
      questionCandidateId: question.questionCandidateId,
      correctedQuestionText: 'Owner corrected fictional question?',
    };
    const settled = await Promise.allSettled([
      confirmExamHumanReview(second.h.deps, second.examSessionId, original),
      confirmExamHumanReview(second.h.deps, second.examSessionId, changed),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'EXAM_REVIEW_CONFLICT' });
  });

  it('deletes confirmed and partially persisted review artifacts and prevents resurrection', async () => {
    const confirmed = await preparedExam();
    const confirmedRequest = await reviewRequest(confirmed.h, confirmed.examSessionId);
    await confirmExamHumanReview(confirmed.h.deps, confirmed.examSessionId, confirmedRequest);
    const confirmedKey = examHumanReviewObjectKey(confirmed.examSessionId, 1, 1, 1);
    expect(confirmed.h.byteStore.objects.has(confirmedKey)).toBe(true);
    await expect(deleteExam(confirmed.h.deps, confirmed.examSessionId)).resolves.toBe('deleted');
    expect(confirmed.h.byteStore.objects.has(confirmedKey)).toBe(false);
    await expect(
      confirmExamHumanReview(confirmed.h.deps, confirmed.examSessionId, confirmedRequest),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });

    const partial = await preparedExam();
    const partialRequest = await reviewRequest(partial.h, partial.examSessionId);
    let fail = true;
    const append = partial.h.baseStore.appendRecord.bind(partial.h.baseStore);
    partial.h.deps.store = withAppend(partial.h.baseStore, async (record, options) => {
      if (
        fail &&
        (record.payload as { eventType?: string }).eventType === 'exam_human_review_completed'
      ) {
        fail = false;
        throw new Error('leave partial review artifact');
      }
      return append(record, options);
    });
    await expect(
      confirmExamHumanReview(partial.h.deps, partial.examSessionId, partialRequest),
    ).rejects.toMatchObject({ code: 'EXAM_REVIEW_FAILED' });
    const partialKey = examHumanReviewObjectKey(partial.examSessionId, 1, 1, 1);
    expect(partial.h.byteStore.objects.has(partialKey)).toBe(true);
    await expect(deleteExam(partial.h.deps, partial.examSessionId)).resolves.toBe('deleted');
    expect(partial.h.byteStore.objects.has(partialKey)).toBe(false);
  });

  it('serializes review/delete races in both lock orders without resurrection', async () => {
    const reviewFirst = await preparedExam();
    const reviewFirstRequest = await reviewRequest(reviewFirst.h, reviewFirst.examSessionId);
    const [reviewResult, deleteResult] = await Promise.all([
      confirmExamHumanReview(reviewFirst.h.deps, reviewFirst.examSessionId, reviewFirstRequest),
      deleteExam(reviewFirst.h.deps, reviewFirst.examSessionId),
    ]);
    expect(reviewResult.humanReview.status).toBe('confirmed');
    expect(deleteResult).toBe('deleted');
    expect(
      [...reviewFirst.h.byteStore.objects.keys()].some((key) => key.includes('/human_review_v')),
    ).toBe(false);
    await expect(
      resolveConfirmedExamReviewFacts(reviewFirst.h.deps, reviewFirst.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });

    const deleteFirst = await preparedExam();
    const deleteFirstRequest = await reviewRequest(deleteFirst.h, deleteFirst.examSessionId);
    const settled = await Promise.allSettled([
      deleteExam(deleteFirst.h.deps, deleteFirst.examSessionId),
      confirmExamHumanReview(deleteFirst.h.deps, deleteFirst.examSessionId, deleteFirstRequest),
    ]);
    expect(settled[0]).toMatchObject({ status: 'fulfilled', value: 'deleted' });
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'EXAM_NOT_FOUND' },
    });
    expect(
      [...deleteFirst.h.byteStore.objects.keys()].some((key) => key.includes('/human_review_v')),
    ).toBe(false);
  });
});
