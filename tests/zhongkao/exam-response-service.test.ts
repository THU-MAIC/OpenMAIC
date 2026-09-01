import { createHash } from 'node:crypto';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  examSnapshotObjectKey,
  examQuestionResponseMatchesObjectKey,
  examStudentResponseCandidatesObjectKey,
} from '@/lib/server/materials/object-keys';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';
import { extractExamQuestionCandidates } from '@/lib/server/zhongkao/exam-extraction-service';
import {
  captureExamStudentResponses,
  resolveExamQuestionResponseMatches,
  resolveExamStudentResponseCandidates,
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
import {
  EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
  EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
} from '@/lib/zhongkao/exam-student-response';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-01T00:00:00.000Z';
const OWNER = 'fictional-response-owner';
const PROFILE = 'fictional-response-profile';
const MATERIALS = {
  question: `mat_${'6'.repeat(26)}`,
  response: `mat_${'7'.repeat(26)}`,
  answer: `mat_${'8'.repeat(26)}`,
} as const;
const INPUT = { format: 'numbered_text_v1', text: '1=B\n2=' } as const;

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
  readonly deletePrefixCalls: string[] = [];

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    this.putCalls.push(key);
    this.objects.set(key, buffered(body));
  }

  async get(key: string): Promise<Buffer> {
    this.getCalls.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'material bytes are unavailable');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletePrefixCalls.push(prefix);
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
    dbName: `exam-response-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FakeByteStore();
  const question = await textPdf();
  const assets = new Map<string, VerifiedOwnerMaterialAsset>([
    [MATERIALS.question, source(MATERIALS.question, question, 'application/pdf', 'paper.pdf')],
    [
      MATERIALS.response,
      source(MATERIALS.response, Buffer.from('scanned response'), 'text/plain', 'response.txt'),
    ],
    [
      MATERIALS.answer,
      source(MATERIALS.answer, Buffer.from('answer material'), 'text/plain', 'answer.txt'),
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
    mintRecordId: () => 'profile-record-response',
  });
  return { baseStore, deps, byteStore };
}

async function intakeExam() {
  const h = await harness();
  const created = await createExam(h.deps, {
    clientRequestId: 'response-capture-fixture',
    profileId: PROFILE,
    subjectId: 'math',
    documents: [
      { role: 'question_paper', ownerMaterialId: MATERIALS.question },
      { role: 'student_response', ownerMaterialId: MATERIALS.response },
      { role: 'answer_key', ownerMaterialId: MATERIALS.answer },
    ],
  });
  return { h, exam: created.exam };
}

async function preparedExam() {
  const prepared = await intakeExam();
  await extractExamQuestionCandidates(prepared.h.deps, prepared.exam.examSessionId);
  return prepared;
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

describe('Exam structured response capture service', () => {
  it('requires verified question candidates and fails cross-owner capture as not found', async () => {
    const intake = await intakeExam();
    await expect(
      captureExamStudentResponses(intake.h.deps, intake.exam.examSessionId, INPUT),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSES_NOT_READY' });
    expect(
      (await events(intake.h, intake.exam.examSessionId)).some((event) =>
        event.eventType.startsWith('exam_student_response'),
      ),
    ).toBe(false);

    const prepared = await preparedExam();
    await expect(
      captureExamStudentResponses(
        { ...prepared.h.deps, ownerId: 'fictional-foreign-owner' },
        prepared.exam.examSessionId,
        INPUT,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
  });

  it('maps request line limits to the stable input-too-large error', async () => {
    const { h, exam } = await preparedExam();
    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, {
        format: 'numbered_text_v1',
        text: Array.from({ length: 2_001 }, () => '').join('\n'),
      }),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSE_INPUT_TOO_LARGE' });
  });

  it('persists one exact capture, replays it, conflicts on changed facts, and never reads raw answer documents', async () => {
    const { h, exam } = await preparedExam();
    const responseDocument = exam.documents.find(
      (document) => document.role === 'student_response',
    )!;
    const answerDocument = exam.documents.find((document) => document.role === 'answer_key')!;
    const responseSnapshotKey = examSnapshotObjectKey(
      exam.examSessionId,
      responseDocument.examDocumentId,
    );
    const answerSnapshotKey = examSnapshotObjectKey(
      exam.examSessionId,
      answerDocument.examDocumentId,
    );
    h.byteStore.getCalls.length = 0;

    const first = await captureExamStudentResponses(h.deps, exam.examSessionId, INPUT);
    const firstEvents = await events(h, exam.examSessionId);
    const candidates = await resolveExamStudentResponseCandidates(h.deps, exam.examSessionId);
    const matches = await resolveExamQuestionResponseMatches(h.deps, exam.examSessionId);

    expect(first).toMatchObject({
      replayed: false,
      exam: {
        studentResponseMatching: {
          status: 'matching_ready',
          responseCount: 2,
          matchedCount: 2,
          ambiguousCount: 0,
          unmatchedCount: 0,
          needsReview: true,
        },
      },
    });
    expect(candidates.candidates.map((candidate) => candidate.rawAnswerText)).toEqual(['B', '']);
    expect(matches.matches.map((match) => match.status)).toEqual(['matched', 'matched']);
    expect(firstEvents.map((event) => event.eventType).slice(-3)).toEqual([
      'exam_student_response_capture_started',
      'exam_response_candidates_recorded',
      'exam_response_matching_completed',
    ]);
    expect(JSON.stringify(firstEvents)).not.toContain('rawAnswerText');
    expect(JSON.stringify(firstEvents)).not.toContain('x=2');
    expect(h.byteStore.getCalls).not.toContain(responseSnapshotKey);
    expect(h.byteStore.getCalls).not.toContain(answerSnapshotKey);

    const replay = await captureExamStudentResponses(h.deps, exam.examSessionId, INPUT);
    expect(replay.replayed).toBe(true);
    expect(await events(h, exam.examSessionId)).toHaveLength(firstEvents.length);
    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, {
        ...INPUT,
        text: '1=C\n2=',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSE_CAPTURE_CONFLICT' });
  });

  it.each([
    {
      label: 'response candidate',
      expectedError: 'EXAM_RESPONSE_CAPTURE_FAILED',
      expectedPriorEvent: 'exam_student_response_capture_started',
      key: (examSessionId: string) =>
        examStudentResponseCandidatesObjectKey(
          examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
        ),
    },
    {
      label: 'matching',
      expectedError: 'EXAM_RESPONSE_MATCHING_FAILED',
      expectedPriorEvent: 'exam_response_candidates_recorded',
      key: (examSessionId: string) =>
        examQuestionResponseMatchesObjectKey(
          examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
          EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
        ),
    },
  ] as const)(
    'recovers $label artifact put and read-back failures without a false ready state',
    async ({ expectedError, expectedPriorEvent, key }) => {
      for (const failureMode of ['put', 'read-back'] as const) {
        const { h, exam } = await preparedExam();
        const targetKey = key(exam.examSessionId);
        let injected = false;
        let targetReads = 0;
        const originalPut = h.byteStore.put.bind(h.byteStore);
        const originalGet = h.byteStore.get.bind(h.byteStore);
        const spy =
          failureMode === 'put'
            ? vi.spyOn(h.byteStore, 'put').mockImplementation(async (objectKey, body, mime) => {
                if (!injected && objectKey === targetKey) {
                  injected = true;
                  throw new Error('injected private put failure');
                }
                await originalPut(objectKey, body, mime);
              })
            : vi.spyOn(h.byteStore, 'get').mockImplementation(async (objectKey) => {
                if (objectKey === targetKey && ++targetReads === 2) {
                  throw new Error('injected private read-back failure');
                }
                return originalGet(objectKey);
              });

        await expect(
          captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
        ).rejects.toMatchObject({ code: expectedError });
        expect((await events(h, exam.examSessionId)).at(-1)?.eventType).toBe(expectedPriorEvent);

        spy.mockRestore();
        await expect(
          captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
        ).resolves.toMatchObject({
          exam: { studentResponseMatching: { status: 'matching_ready' } },
        });
      }
    },
  );

  it('fails closed when the verified question artifact becomes unavailable', async () => {
    const { h, exam } = await preparedExam();
    const questionArtifactKey = [...h.byteStore.objects.keys()].find((key) =>
      key.includes('/question_candidates_v1.json'),
    );
    expect(questionArtifactKey).toBeDefined();
    h.byteStore.objects.delete(questionArtifactKey!);

    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_CORRUPT' });
    expect(
      (await events(h, exam.examSessionId)).some(
        (event) => event.eventType === 'exam_student_response_capture_started',
      ),
    ).toBe(false);
  });

  it('converges concurrent identical captures through Runtime CAS replay', async () => {
    const { h, exam } = await preparedExam();
    const unlockedDeps: ExamServiceDeps = {
      ...h.deps,
      withExamMutationLock: async (_key, work) => work(),
    };

    const results = await Promise.all([
      captureExamStudentResponses(unlockedDeps, exam.examSessionId, INPUT),
      captureExamStudentResponses(unlockedDeps, exam.examSessionId, INPUT),
    ]);
    expect(
      results.every((result) => result.exam.studentResponseMatching?.status === 'matching_ready'),
    ).toBe(true);
    const responseEvents = (await events(h, exam.examSessionId)).filter(
      (event) =>
        event.eventType.startsWith('exam_student_response') ||
        event.eventType === 'exam_response_candidates_recorded' ||
        event.eventType === 'exam_response_matching_completed',
    );
    expect(responseEvents.map((event) => event.eventType)).toEqual([
      'exam_student_response_capture_started',
      'exam_response_candidates_recorded',
      'exam_response_matching_completed',
    ]);
  });

  it('writes no response artifact when capture-start append fails before commit', async () => {
    const { h, exam } = await preparedExam();
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let failed = false;
    const store = withAppend(h.baseStore, async (init, options) => {
      if (
        !failed &&
        (init.payload as { eventType?: string }).eventType ===
          'exam_student_response_capture_started'
      ) {
        failed = true;
        throw new Error('injected capture-start append failure');
      }
      return originalAppend(init, options);
    });

    await expect(
      captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSE_CAPTURE_FAILED' });
    expect(
      h.byteStore.objects.has(
        examStudentResponseCandidatesObjectKey(
          exam.examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
        ),
      ),
    ).toBe(false);
    expect(
      h.byteStore.objects.has(
        examQuestionResponseMatchesObjectKey(
          exam.examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
          EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
        ),
      ),
    ).toBe(false);

    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ exam: { studentResponseMatching: { status: 'matching_ready' } } });
  });

  it('recovers a committed capture-start response loss', async () => {
    const { h, exam } = await preparedExam();
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let lost = false;
    const store = withAppend(h.baseStore, async (init, options) => {
      const record = await originalAppend(init, options);
      if (
        !lost &&
        (init.payload as { eventType?: string }).eventType ===
          'exam_student_response_capture_started'
      ) {
        lost = true;
        throw new Error('injected committed capture-start response loss');
      }
      return record;
    });

    await expect(
      captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ exam: { studentResponseMatching: { status: 'matching_ready' } } });
    expect(
      (await events(h, exam.examSessionId)).filter(
        (event) => event.eventType === 'exam_student_response_capture_started',
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      eventType: 'exam_response_candidates_recorded',
      expectedError: 'EXAM_RESPONSE_CAPTURE_FAILED',
      key: (examSessionId: string) =>
        examStudentResponseCandidatesObjectKey(
          examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
        ),
      expectedPriorEvent: 'exam_student_response_capture_started',
    },
    {
      eventType: 'exam_response_matching_completed',
      expectedError: 'EXAM_RESPONSE_MATCHING_FAILED',
      key: (examSessionId: string) =>
        examQuestionResponseMatchesObjectKey(
          examSessionId,
          EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
          EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
        ),
      expectedPriorEvent: 'exam_response_candidates_recorded',
    },
  ] as const)(
    'recovers $eventType when artifact bytes exist before the event',
    async ({ eventType, expectedError, key, expectedPriorEvent }) => {
      const { h, exam } = await preparedExam();
      const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
      let failed = false;
      const store = withAppend(h.baseStore, async (init, options) => {
        if (!failed && (init.payload as { eventType?: string }).eventType === eventType) {
          failed = true;
          throw new Error('injected append failure');
        }
        return originalAppend(init, options);
      });
      await expect(
        captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
      ).rejects.toMatchObject({ code: expectedError });
      expect(h.byteStore.objects.has(key(exam.examSessionId))).toBe(true);
      expect((await events(h, exam.examSessionId)).at(-1)?.eventType).toBe(expectedPriorEvent);

      await expect(
        captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
      ).resolves.toMatchObject({ exam: { studentResponseMatching: { status: 'matching_ready' } } });
      expect(
        (await events(h, exam.examSessionId)).filter((event) => event.eventType === eventType),
      ).toHaveLength(1);
    },
  );

  it('recovers a committed response-candidate event response loss', async () => {
    const { h, exam } = await preparedExam();
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let lost = false;
    const store = withAppend(h.baseStore, async (init, options) => {
      const record = await originalAppend(init, options);
      if (
        !lost &&
        (init.payload as { eventType?: string }).eventType === 'exam_response_candidates_recorded'
      ) {
        lost = true;
        throw new Error('injected committed response loss');
      }
      return record;
    });

    await expect(
      captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ exam: { studentResponseMatching: { status: 'matching_ready' } } });
    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ replayed: true });
    expect(
      (await events(h, exam.examSessionId)).filter(
        (event) => event.eventType === 'exam_response_candidates_recorded',
      ),
    ).toHaveLength(1);
  });

  it('recovers a committed completion response loss and rejects missing or corrupt completed artifacts', async () => {
    const { h, exam } = await preparedExam();
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let lost = false;
    const store = withAppend(h.baseStore, async (init, options) => {
      const record = await originalAppend(init, options);
      if (
        !lost &&
        (init.payload as { eventType?: string }).eventType === 'exam_response_matching_completed'
      ) {
        lost = true;
        throw new Error('injected committed response loss');
      }
      return record;
    });
    await expect(
      captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ exam: { studentResponseMatching: { status: 'matching_ready' } } });
    await expect(
      captureExamStudentResponses(h.deps, exam.examSessionId, INPUT),
    ).resolves.toMatchObject({ replayed: true });
    expect(
      (await events(h, exam.examSessionId)).filter(
        (event) => event.eventType === 'exam_response_matching_completed',
      ),
    ).toHaveLength(1);

    const responseKey = examStudentResponseCandidatesObjectKey(
      exam.examSessionId,
      EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    );
    const matchingKey = examQuestionResponseMatchesObjectKey(
      exam.examSessionId,
      EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
      EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
    );
    const responseBytes = h.byteStore.objects.get(responseKey)!;
    h.byteStore.objects.delete(responseKey);
    await expect(
      resolveExamStudentResponseCandidates(h.deps, exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSE_ARTIFACT_CORRUPT' });
    h.byteStore.objects.set(responseKey, responseBytes);
    h.byteStore.objects.set(matchingKey, Buffer.from('{}'));
    await expect(
      resolveExamQuestionResponseMatches(h.deps, exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_RESPONSE_ARTIFACT_CORRUPT' });
  });

  it.each([
    {
      eventType: 'exam_response_candidates_recorded',
      expectedError: 'EXAM_RESPONSE_CAPTURE_FAILED',
      matchingBytesExist: false,
    },
    {
      eventType: 'exam_response_matching_completed',
      expectedError: 'EXAM_RESPONSE_MATCHING_FAILED',
      matchingBytesExist: true,
    },
  ] as const)(
    'deletes partial response artifacts before $eventType has completed',
    async ({ eventType, expectedError, matchingBytesExist }) => {
      const { h, exam } = await preparedExam();
      const responseKey = examStudentResponseCandidatesObjectKey(
        exam.examSessionId,
        EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
      );
      const matchingKey = examQuestionResponseMatchesObjectKey(
        exam.examSessionId,
        EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
        EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
      );
      const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
      let failed = false;
      const store = withAppend(h.baseStore, async (init, options) => {
        if (!failed && (init.payload as { eventType?: string }).eventType === eventType) {
          failed = true;
          throw new Error('injected response append failure');
        }
        return originalAppend(init, options);
      });

      await expect(
        captureExamStudentResponses({ ...h.deps, store }, exam.examSessionId, INPUT),
      ).rejects.toMatchObject({ code: expectedError });
      expect(h.byteStore.objects.has(responseKey)).toBe(true);
      expect(h.byteStore.objects.has(matchingKey)).toBe(matchingBytesExist);

      await expect(deleteExam(h.deps, exam.examSessionId)).resolves.toBe('deleted');
      expect(h.byteStore.objects.has(responseKey)).toBe(false);
      expect(h.byteStore.objects.has(matchingKey)).toBe(false);
    },
  );

  it('deletes exact response derivatives after the durable delete request and remains recoverably deleting', async () => {
    const { h, exam } = await preparedExam();
    await captureExamStudentResponses(h.deps, exam.examSessionId, INPUT);
    const responseKey = examStudentResponseCandidatesObjectKey(
      exam.examSessionId,
      EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    );
    const matchingKey = examQuestionResponseMatchesObjectKey(
      exam.examSessionId,
      EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
      EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
    );
    const originalDelete = h.byteStore.delete.bind(h.byteStore);
    let failed = false;
    vi.spyOn(h.byteStore, 'delete').mockImplementation(async (key) => {
      if (!failed && key === responseKey) {
        failed = true;
        throw new MaterialByteStoreError('MATERIAL_BYTE_DELETE_FAILED', 'private delete failure');
      }
      await originalDelete(key);
    });

    await expect(deleteExam(h.deps, exam.examSessionId)).rejects.toMatchObject({
      code: 'EXAM_DELETE_FAILED',
    });
    expect((await getExam(h.deps, exam.examSessionId)).status).toBe('deleting');
    expect((await events(h, exam.examSessionId)).at(-1)?.eventType).toBe('exam_delete_requested');

    vi.mocked(h.byteStore.delete).mockImplementation(originalDelete);
    await expect(deleteExam(h.deps, exam.examSessionId)).resolves.toBe('deleted');
    expect(h.byteStore.deleteCalls).toContain(responseKey);
    expect(h.byteStore.deleteCalls).toContain(matchingKey);
    expect(h.byteStore.objects.has(responseKey)).toBe(false);
    expect(h.byteStore.objects.has(matchingKey)).toBe(false);
    expect((await events(h, exam.examSessionId)).at(-1)?.eventType).toBe('exam_deleted');
  });

  it('linearizes capture and delete in both directions without orphaning or resurrecting derivatives', async () => {
    const captureFirst = await preparedExam();
    const capture = captureExamStudentResponses(
      captureFirst.h.deps,
      captureFirst.exam.examSessionId,
      INPUT,
    );
    const deletion = deleteExam(captureFirst.h.deps, captureFirst.exam.examSessionId);
    await expect(capture).resolves.toMatchObject({
      exam: { studentResponseMatching: { status: 'matching_ready' } },
    });
    await expect(deletion).resolves.toBe('deleted');
    expect(
      [...captureFirst.h.byteStore.objects.keys()].some((key) =>
        key.includes('response_capture_v1'),
      ),
    ).toBe(false);

    const deleteFirst = await preparedExam();
    const firstDeletion = deleteExam(deleteFirst.h.deps, deleteFirst.exam.examSessionId);
    const lateCapture = captureExamStudentResponses(
      deleteFirst.h.deps,
      deleteFirst.exam.examSessionId,
      INPUT,
    );
    await expect(firstDeletion).resolves.toBe('deleted');
    await expect(lateCapture).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(
      [...deleteFirst.h.byteStore.objects.keys()].some((key) =>
        key.includes('response_capture_v1'),
      ),
    ).toBe(false);
  });
});
