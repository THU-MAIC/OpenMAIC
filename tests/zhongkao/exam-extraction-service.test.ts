import { createHash } from 'node:crypto';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  extractExamQuestionCandidates,
  resolveExamDocumentArtifact,
  resolveExamQuestionCandidates,
} from '@/lib/server/zhongkao/exam-extraction-service';
import { createExam, deleteExam, type ExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { EXAM_EXTRACTION_VERSION } from '@/lib/zhongkao/exam-document-artifact';
import {
  EXAM_QUESTION_SEGMENTATION_VERSION,
  parseExamQuestionCandidatesArtifact,
  serializeExamQuestionCandidatesArtifact,
} from '@/lib/zhongkao/exam-question-candidate';
import {
  examDocumentArtifactObjectKey,
  examQuestionCandidatesObjectKey,
  examSnapshotObjectKey,
} from '@/lib/server/materials/object-keys';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import type { VerifiedOwnerMaterialAsset } from '@/lib/server/materials/owner-assets';
import {
  createExamOperationFingerprint,
  examRuntimeSessionId,
} from '@/lib/server/zhongkao/exam-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-01T00:00:00.000Z';
const OWNER = 'fictional-extraction-owner';
const OTHER_OWNER = 'fictional-foreign-owner';
const PROFILE = 'fictional-extraction-profile';
const MATERIALS = {
  question: `mat_${'3'.repeat(26)}`,
  response: `mat_${'4'.repeat(26)}`,
  answer: `mat_${'5'.repeat(26)}`,
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

async function textPdf(lines: readonly string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 700]);
  page.drawText(lines.join('\n'), { x: 36, y: 650, size: 12, lineHeight: 18, font });
  return Buffer.from(await pdf.save());
}

async function blankPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]);
  return Buffer.from(await pdf.save());
}

interface Harness {
  baseStore: RuntimeStore;
  deps: ExamServiceDeps;
  byteStore: FakeByteStore;
  sources: Map<string, VerifiedOwnerMaterialAsset>;
}

async function harness(questionBytes?: Buffer, questionMime = 'application/pdf'): Promise<Harness> {
  const baseStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `exam-extraction-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const byteStore = new FakeByteStore();
  const question =
    questionBytes ??
    (await textPdf([
      '1. Fictional algebra question with enough native text',
      '2. Fictional geometry question with enough native text',
    ]));
  const sources = new Map<string, VerifiedOwnerMaterialAsset>([
    [MATERIALS.question, source(MATERIALS.question, question, questionMime, 'paper.pdf')],
    [
      MATERIALS.response,
      source(MATERIALS.response, Buffer.from('fictional response'), 'text/plain', 'response.txt'),
    ],
    [
      MATERIALS.answer,
      source(
        MATERIALS.answer,
        Buffer.from('fictional answer material'),
        'text/plain',
        'answer.txt',
      ),
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
      const assets = ids.map((id) => sources.get(id)).filter((asset) => asset !== undefined);
      return assets.length === ids.length
        ? { ok: true, assets }
        : { ok: false, reason: 'unavailable' };
    },
    now: () => new Date(Date.parse(NOW) + second++ * 1000).toISOString(),
  };
  await saveStudentProfile(createInitialStudentProfile({ profileId: PROFILE, createdAt: NOW }), {
    store: baseStore,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(OWNER),
    now: () => NOW,
    mintRecordId: () => 'profile-record-extraction',
  });
  return { baseStore, deps, byteStore, sources };
}

async function createReadyExam(h: Harness, allDocuments = false) {
  return createExam(h.deps, {
    clientRequestId: `extract-${allDocuments ? 'all' : 'question'}`,
    profileId: PROFILE,
    subjectId: 'math',
    documents: allDocuments
      ? [
          { role: 'question_paper', ownerMaterialId: MATERIALS.question },
          { role: 'student_response', ownerMaterialId: MATERIALS.response },
          { role: 'answer_key', ownerMaterialId: MATERIALS.answer },
        ]
      : [{ role: 'question_paper', ownerMaterialId: MATERIALS.question }],
  });
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

function withEventTransform(
  backing: RuntimeStore,
  transform: (event: ExamEvent) => ExamEvent,
): RuntimeStore {
  return new Proxy(backing, {
    get(target, property, receiver) {
      if (property === 'listRecords') {
        return async (sessionId: string) =>
          (await backing.listRecords(sessionId)).map((record) => ({
            ...record,
            payload: transform(record.payload as ExamEvent),
          }));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Exam question extraction service', () => {
  it('creates two deterministic server-only derivatives and replays without duplicate events', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const first = await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    const firstEvents = await events(h, created.exam.examSessionId);
    const documentArtifact = await resolveExamDocumentArtifact(h.deps, created.exam.examSessionId);
    const candidates = await resolveExamQuestionCandidates(h.deps, created.exam.examSessionId);

    expect(first.replayed).toBe(false);
    expect(first.exam.questionExtraction).toEqual({
      status: 'question_candidates_ready',
      pageCount: 1,
      candidateCount: 2,
      needsReview: false,
    });
    expect(documentArtifact.pages[0]?.blocks.map((block) => block.blockIndex)).toEqual([0, 1]);
    expect(candidates.candidates.map((candidate) => candidate.locator.printedNumber)).toEqual([
      '1',
      '2',
    ]);
    expect(firstEvents.map((event) => event.eventType).slice(-4)).toEqual([
      'exam_question_extraction_started',
      'exam_document_artifact_extracted',
      'exam_question_segmentation_started',
      'exam_question_candidates_extracted',
    ]);

    const replay = await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    expect(replay.replayed).toBe(true);
    expect(await events(h, created.exam.examSessionId)).toHaveLength(firstEvents.length);
    expect(await resolveExamQuestionCandidates(h.deps, created.exam.examSessionId)).toEqual(
      candidates,
    );
  });

  it('reads only question_paper even when response and answer-key snapshots exist', async () => {
    const h = await harness();
    const created = await createReadyExam(h, true);
    const questionDocument = created.exam.documents.find(
      (document) => document.role === 'question_paper',
    )!;
    const responseDocument = created.exam.documents.find(
      (document) => document.role === 'student_response',
    )!;
    const answerDocument = created.exam.documents.find(
      (document) => document.role === 'answer_key',
    )!;
    const responseKey = examSnapshotObjectKey(
      created.exam.examSessionId,
      responseDocument.examDocumentId,
    );
    const answerKey = examSnapshotObjectKey(
      created.exam.examSessionId,
      answerDocument.examDocumentId,
    );
    h.byteStore.getCalls.length = 0;

    await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);

    expect(h.byteStore.getCalls).toContain(
      examSnapshotObjectKey(created.exam.examSessionId, questionDocument.examDocumentId),
    );
    expect(h.byteStore.getCalls).not.toContain(responseKey);
    expect(h.byteStore.getCalls).not.toContain(answerKey);
  });

  it('rejects unsupported, scanned/no-text, malformed, and foreign Exams with stable errors', async () => {
    const unsupported = await harness(Buffer.from('fictional image bytes'), 'image/png');
    const unsupportedExam = await createReadyExam(unsupported);
    await expect(
      extractExamQuestionCandidates(unsupported.deps, unsupportedExam.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_QUESTION_PAPER_UNSUPPORTED' });

    const scanned = await harness(await blankPdf());
    const scannedExam = await createReadyExam(scanned);
    await expect(
      extractExamQuestionCandidates(scanned.deps, scannedExam.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_TEXT_EXTRACTION_UNAVAILABLE' });
    expect(
      (await events(scanned, scannedExam.exam.examSessionId)).some((event) =>
        event.eventType.startsWith('exam_question_'),
      ),
    ).toBe(false);

    const malformed = await harness(Buffer.from('%PDF malformed private path C:\\student'));
    const malformedExam = await createReadyExam(malformed);
    await expect(
      extractExamQuestionCandidates(malformed.deps, malformedExam.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_DOCUMENT_EXTRACTION_FAILED' });
    expect(
      (await events(malformed, malformedExam.exam.examSessionId)).some((event) =>
        event.eventType.startsWith('exam_question_'),
      ),
    ).toBe(false);

    await expect(
      extractExamQuestionCandidates(
        { ...malformed.deps, ownerId: OTHER_OWNER },
        malformedExam.exam.examSessionId,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
  });

  it('persists extraction-started before an artifact write failure and recovers on retry', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const originalPut = h.byteStore.put.bind(h.byteStore);
    vi.spyOn(h.byteStore, 'put').mockRejectedValueOnce(
      new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'private failure'),
    );

    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_DOCUMENT_EXTRACTION_FAILED' });
    expect((await events(h, created.exam.examSessionId)).at(-1)?.eventType).toBe(
      'exam_question_extraction_started',
    );

    vi.mocked(h.byteStore.put).mockImplementation(originalPut);
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });
  });

  it('recovers bytes written before the document completion event and rejects different bytes', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let failCompletion = true;
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      if (
        failCompletion &&
        (record.payload as { eventType?: string }).eventType === 'exam_document_artifact_extracted'
      ) {
        failCompletion = false;
        throw new Error('private append failure');
      }
      return originalAppend(record, options);
    });

    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_DOCUMENT_EXTRACTION_FAILED' });
    const extractionStarted = (await events(h, created.exam.examSessionId)).at(-1);
    expect(extractionStarted?.eventType).toBe('exam_question_extraction_started');
    const documentId = created.exam.documents[0]!.examDocumentId;
    const key = examDocumentArtifactObjectKey(
      created.exam.examSessionId,
      documentId,
      EXAM_EXTRACTION_VERSION,
    );
    expect(h.byteStore.objects.has(key)).toBe(true);

    h.byteStore.objects.set(key, Buffer.from('{"different":true}'));
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_CONFLICT' });

    h.byteStore.objects.delete(key);
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });
  });

  it('recovers candidate bytes before their event and a committed response-loss event', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const originalAppend = h.baseStore.appendRecord.bind(h.baseStore);
    let failCandidatesBeforeCommit = true;
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      const eventType = (record.payload as { eventType?: string }).eventType;
      if (failCandidatesBeforeCommit && eventType === 'exam_question_candidates_extracted') {
        failCandidatesBeforeCommit = false;
        throw new Error('private candidate event failure');
      }
      return originalAppend(record, options);
    });

    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_QUESTION_SEGMENTATION_FAILED' });
    expect((await events(h, created.exam.examSessionId)).at(-1)?.eventType).toBe(
      'exam_question_segmentation_started',
    );

    let commitThenThrow = true;
    h.deps.store = withAppend(h.baseStore, async (record, options) => {
      const result = await originalAppend(record, options);
      if (
        commitThenThrow &&
        (record.payload as { eventType?: string }).eventType ===
          'exam_question_candidates_extracted'
      ) {
        commitThenThrow = false;
        throw new Error('response lost after commit');
      }
      return result;
    });
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });
    expect(
      (await events(h, created.exam.examSessionId)).filter(
        (event) => event.eventType === 'exam_question_candidates_extracted',
      ),
    ).toHaveLength(1);
  });

  it('does not publish ready after artifact read-back or candidate put failures', async () => {
    const artifactRead = await harness();
    const artifactExam = await createReadyExam(artifactRead);
    const originalGet = artifactRead.byteStore.get.bind(artifactRead.byteStore);
    let artifactReads = 0;
    vi.spyOn(artifactRead.byteStore, 'get').mockImplementation(async (key) => {
      if (key.endsWith('/document_artifact_v1.json')) {
        artifactReads += 1;
        if (artifactReads === 2) {
          throw new MaterialByteStoreError('MATERIAL_BYTE_READ_FAILED', 'private read failure');
        }
      }
      return originalGet(key);
    });
    await expect(
      extractExamQuestionCandidates(artifactRead.deps, artifactExam.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_DOCUMENT_EXTRACTION_FAILED' });
    expect((await events(artifactRead, artifactExam.exam.examSessionId)).at(-1)?.eventType).toBe(
      'exam_question_extraction_started',
    );
    vi.mocked(artifactRead.byteStore.get).mockImplementation(originalGet);
    await expect(
      extractExamQuestionCandidates(artifactRead.deps, artifactExam.exam.examSessionId),
    ).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });

    const candidatePut = await harness();
    const candidateExam = await createReadyExam(candidatePut);
    const originalPut = candidatePut.byteStore.put.bind(candidatePut.byteStore);
    vi.spyOn(candidatePut.byteStore, 'put').mockImplementation(async (key, body, mime) => {
      if (key.endsWith('/question_candidates_v1.json')) {
        throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'private write failure');
      }
      return originalPut(key, body, mime);
    });
    await expect(
      extractExamQuestionCandidates(candidatePut.deps, candidateExam.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_QUESTION_SEGMENTATION_FAILED' });
    expect((await events(candidatePut, candidateExam.exam.examSessionId)).at(-1)?.eventType).toBe(
      'exam_question_segmentation_started',
    );
    vi.mocked(candidatePut.byteStore.put).mockImplementation(originalPut);
    await expect(
      extractExamQuestionCandidates(candidatePut.deps, candidateExam.exam.examSessionId),
    ).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });
  });

  it('fails closed when a completed derivative is missing or corrupt', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    const documentId = created.exam.documents[0]!.examDocumentId;
    const documentKey = examDocumentArtifactObjectKey(
      created.exam.examSessionId,
      documentId,
      EXAM_EXTRACTION_VERSION,
    );
    const candidateKey = examQuestionCandidatesObjectKey(
      created.exam.examSessionId,
      documentId,
      EXAM_EXTRACTION_VERSION,
      EXAM_QUESTION_SEGMENTATION_VERSION,
    );

    const documentBytes = h.byteStore.objects.get(documentKey)!;
    h.byteStore.objects.delete(documentKey);
    await expect(
      resolveExamDocumentArtifact(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_CORRUPT' });
    h.byteStore.objects.set(documentKey, documentBytes);
    h.byteStore.objects.set(candidateKey, Buffer.from('{"corrupt":true}'));
    await expect(
      resolveExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_CORRUPT' });
  });

  it('re-derives candidates and rejects a forged field even with matching event integrity facts', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    const documentId = created.exam.documents[0]!.examDocumentId;
    const candidateKey = examQuestionCandidatesObjectKey(
      created.exam.examSessionId,
      documentId,
      EXAM_EXTRACTION_VERSION,
      EXAM_QUESTION_SEGMENTATION_VERSION,
    );
    const original = parseExamQuestionCandidatesArtifact(h.byteStore.objects.get(candidateKey)!);
    const forgedBytes = serializeExamQuestionCandidatesArtifact({
      ...original,
      candidates: [
        { ...original.candidates[0]!, rawLabel: 'forged' },
        ...original.candidates.slice(1),
      ],
    });
    h.byteStore.objects.set(candidateKey, forgedBytes);
    const forgedSha256 = sha256(forgedBytes);
    h.deps.store = withEventTransform(h.baseStore, (event) => {
      if (event.eventType !== 'exam_question_candidates_extracted') return event;
      const forged = {
        ...event,
        artifactByteLength: forgedBytes.byteLength,
        artifactSha256: forgedSha256,
      };
      return {
        ...forged,
        operationFingerprint: createExamOperationFingerprint({
          action: 'exam_question_candidates_extracted',
          schemaVersion: forged.schemaVersion,
          examSessionId: forged.examSessionId,
          profileId: forged.profileId,
          extractionVersion: forged.extractionVersion,
          segmentationVersion: forged.segmentationVersion,
          examDocumentId: forged.examDocumentId,
          sourceArtifactFingerprint: forged.sourceArtifactFingerprint,
          documentArtifactRef: forged.documentArtifactRef,
          candidateArtifactRef: forged.candidateArtifactRef,
          artifactByteLength: forged.artifactByteLength,
          artifactSha256: forged.artifactSha256,
          candidateCount: forged.candidateCount,
          needsReview: forged.needsReview,
        }),
      };
    });

    await expect(
      resolveExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_CORRUPT' });
  });

  it('deletes exact raw and derivative objects and cannot resurrect a deleted Exam', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    await extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    const documentId = created.exam.documents[0]!.examDocumentId;
    const derivativeKeys = [
      examDocumentArtifactObjectKey(
        created.exam.examSessionId,
        documentId,
        EXAM_EXTRACTION_VERSION,
      ),
      examQuestionCandidatesObjectKey(
        created.exam.examSessionId,
        documentId,
        EXAM_EXTRACTION_VERSION,
        EXAM_QUESTION_SEGMENTATION_VERSION,
      ),
    ];

    await expect(deleteExam(h.deps, created.exam.examSessionId)).resolves.toBe('deleted');
    for (const key of derivativeKeys) {
      expect(h.byteStore.deleteCalls).toContain(key);
      expect(h.byteStore.objects.has(key)).toBe(false);
    }
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
  });

  it('linearizes extraction before DELETE and leaves no late derivative', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const originalPut = h.byteStore.put.bind(h.byteStore);
    let releasePut!: () => void;
    let artifactPutStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      artifactPutStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    vi.spyOn(h.byteStore, 'put').mockImplementation(async (key, body, mime) => {
      if (key.includes('/extraction_v1/')) {
        artifactPutStarted();
        await release;
      }
      return originalPut(key, body, mime);
    });

    const extracting = extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    await started;
    const deleting = deleteExam(h.deps, created.exam.examSessionId);
    releasePut();
    await expect(extracting).resolves.toMatchObject({
      exam: { questionExtraction: { status: 'question_candidates_ready' } },
    });
    await expect(deleting).resolves.toBe('deleted');
    expect([...h.byteStore.objects.keys()].some((key) => key.includes('/extraction_v1/'))).toBe(
      false,
    );
  });

  it('linearizes DELETE before extraction and performs no derivative write', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    const originalDelete = h.byteStore.delete.bind(h.byteStore);
    let releaseDelete!: () => void;
    let deleteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    vi.spyOn(h.byteStore, 'delete').mockImplementation(async (key) => {
      deleteStarted();
      await release;
      return originalDelete(key);
    });

    const deleting = deleteExam(h.deps, created.exam.examSessionId);
    await started;
    const extracting = extractExamQuestionCandidates(h.deps, created.exam.examSessionId);
    releaseDelete();

    await expect(deleting).resolves.toBe('deleted');
    await expect(extracting).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(h.byteStore.putCalls.some((key) => key.includes('/extraction_v1/'))).toBe(false);
  });

  it('does not extract from a durable deleting state after byte cleanup fails', async () => {
    const h = await harness();
    const created = await createReadyExam(h);
    vi.spyOn(h.byteStore, 'delete').mockRejectedValueOnce(
      new MaterialByteStoreError('MATERIAL_BYTE_DELETE_FAILED', 'private delete failure'),
    );

    await expect(deleteExam(h.deps, created.exam.examSessionId)).rejects.toMatchObject({
      code: 'EXAM_DELETE_FAILED',
    });
    await expect(
      extractExamQuestionCandidates(h.deps, created.exam.examSessionId),
    ).rejects.toMatchObject({ code: 'EXAM_EXTRACTION_NOT_READY' });
    expect(h.byteStore.putCalls.some((key) => key.includes('/extraction_v1/'))).toBe(false);
  });
});
