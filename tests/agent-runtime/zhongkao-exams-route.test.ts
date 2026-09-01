import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { PublicExamSession } from '@/lib/zhongkao/exam';
import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamServiceDeps: vi.fn(),
  createExam: vi.fn(),
  getExam: vi.fn(),
  deleteExam: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

vi.mock('@/lib/server/zhongkao/exam-service', () => ({
  defaultExamServiceDeps: mocks.defaultExamServiceDeps,
  createExam: mocks.createExam,
  getExam: mocks.getExam,
  deleteExam: mocks.deleteExam,
}));

import { POST } from '@/app/api/zhongkao/exams/route';
import { DELETE, GET } from '@/app/api/zhongkao/exams/[examSessionId]/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const NOW = '2026-08-31T08:00:00.000Z';
const SERVICE_DEPS = { marker: 'exam-service-deps' };

const CREATE_INPUT = {
  clientRequestId: 'exam-request-1',
  profileId: 'student-alpha',
  subjectId: 'math',
  title: 'August mock exam',
  documents: [
    {
      role: 'question_paper',
      ownerMaterialId: 'mat_00000000000000000000000000',
    },
    {
      role: 'answer_key',
      ownerMaterialId: 'mat_11111111111111111111111111',
    },
  ],
} as const;

function publicExam(overrides: Partial<PublicExamSession> = {}): PublicExamSession {
  return {
    schemaVersion: 1,
    examSessionId: EXAM_SESSION_ID,
    profileId: 'student-alpha',
    subjectId: 'math',
    title: 'August mock exam',
    status: 'ready_for_extraction',
    createdAt: NOW,
    documents: [
      {
        examDocumentId: 'exam-document-question-paper',
        role: 'question_paper',
        displayName: 'paper.pdf',
        mimeType: 'application/pdf',
        byteLength: 42,
        snapshotStatus: 'snapshotted',
      },
      {
        examDocumentId: 'exam-document-answer-key',
        role: 'answer_key',
        displayName: 'answers.pdf',
        mimeType: 'application/pdf',
        byteLength: 21,
        snapshotStatus: 'snapshotted',
      },
    ],
    ...overrides,
  };
}

function post(body: BodyInit, contentType = 'application/json') {
  return POST(
    new NextRequest('http://localhost/api/zhongkao/exams', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }),
  );
}

function postJson(body: unknown) {
  return post(JSON.stringify(body));
}

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function get(examSessionId = EXAM_SESSION_ID) {
  return GET(
    new NextRequest(`http://localhost/api/zhongkao/exams/${encodeURIComponent(examSessionId)}`),
    params(examSessionId),
  );
}

function remove(examSessionId = EXAM_SESSION_ID) {
  return DELETE(
    new NextRequest(`http://localhost/api/zhongkao/exams/${encodeURIComponent(examSessionId)}`, {
      method: 'DELETE',
    }),
    params(examSessionId),
  );
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

beforeEach(() => {
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId
    .mockReset()
    .mockImplementation((_request: NextRequest, responseHeaders: Headers) => {
      responseHeaders.append('Set-Cookie', 'anonymous_id=exam-test; Path=/; HttpOnly');
      return 'anon:exam-test';
    });
  mocks.defaultExamServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.createExam.mockReset().mockResolvedValue({ exam: publicExam(), replayed: false });
  mocks.getExam.mockReset().mockResolvedValue(publicExam());
  mocks.deleteExam.mockReset().mockResolvedValue('deleted');
});

describe('POST /api/zhongkao/exams', () => {
  it('returns 201 for a new Exam and 200 for an idempotent replay', async () => {
    const created = await postJson(CREATE_INPUT);
    expect(created.status).toBe(201);
    expect(created.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    await expect(created.json()).resolves.toEqual({ exam: publicExam() });
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:exam-test');
    expect(mocks.createExam).toHaveBeenCalledWith(SERVICE_DEPS, CREATE_INPUT);

    mocks.createExam.mockResolvedValueOnce({ exam: publicExam(), replayed: true });
    const replay = await postJson(CREATE_INPUT);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    await expect(replay.json()).resolves.toEqual({ exam: publicExam() });
  });

  it('maps malformed JSON to a closed input error and preserves the owner cookie', async () => {
    const response = await post('{"documents":');

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: 'EXAM_INPUT_INVALID',
      error: 'invalid exam request',
    });
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
    expect(mocks.createExam).not.toHaveBeenCalled();
  });

  it('rejects non-JSON and oversized request bodies before service dispatch', async () => {
    const wrongType = await post('{}', 'text/plain');
    expect(wrongType.status).toBe(400);
    await expect(wrongType.json()).resolves.toMatchObject({
      errorCode: 'EXAM_INPUT_INVALID',
    });

    const oversized = await postJson({ padding: 'x'.repeat(33 * 1024) });
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({
      errorCode: 'EXAM_INPUT_INVALID',
    });
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
    expect(mocks.createExam).not.toHaveBeenCalled();
  });

  it('closes unknown service failures without returning their message or storage locator', async () => {
    const privateDiagnostic =
      'provider stderr C:\\private\\student\\paper.pdf materials/v1/exams/exm_secret/raw';
    mocks.createExam.mockRejectedValueOnce(new Error(privateDiagnostic));

    const response = await postJson(CREATE_INPUT);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      errorCode: 'EXAM_SESSION_CONFLICT',
      error: 'exam session changed concurrently',
    });
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    expect(JSON.stringify(body)).not.toContain(privateDiagnostic);
    expect(JSON.stringify(body)).not.toMatch(/provider stderr|C:\\private|materials\/v1\/exams/);
  });

  it('keeps the dedicated endpoint behind the configured runtime gate', async () => {
    mocks.runtimeConfigured = false;

    const response = await postJson(CREATE_INPUT);

    expect(response.status).toBe(404);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
    expect(mocks.createExam).not.toHaveBeenCalled();
  });
});

describe('GET /api/zhongkao/exams/[examSessionId]', () => {
  it('returns the owner-authorized public Exam detail with its owner cookie', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    await expect(response.json()).resolves.toEqual({ exam: publicExam() });
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:exam-test');
    expect(mocks.getExam).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);
  });

  it('returns a locator- and authority-free public payload, including for answer_key', async () => {
    const response = await get();
    const body = await response.json();
    const keys = new Set(allKeys(body));
    const forbiddenKeys = [
      'sha256',
      'sourceSha256',
      'snapshotSha256',
      'snapshotObjectKey',
      'objectKey',
      'ossKey',
      'ownerId',
      'ownerMaterialId',
      'learnerKey',
      'runtimeSessionId',
      'eventId',
      'operationId',
      'operationFingerprint',
      'clientRequestId',
      'gradingSpec',
      'authoritative',
      'verified',
      'correctAnswer',
      'expectedAnswer',
      'answers',
    ];

    expect(response.status).toBe(200);
    for (const key of forbiddenKeys) expect(keys.has(key), key).toBe(false);
    expect(
      body.exam.documents.find((document: { role: string }) => document.role === 'answer_key'),
    ).toEqual({
      examDocumentId: 'exam-document-answer-key',
      role: 'answer_key',
      displayName: 'answers.pdf',
      mimeType: 'application/pdf',
      byteLength: 21,
      snapshotStatus: 'snapshotted',
    });
  });

  it('makes malformed, missing, foreign, and deleted Exam ids indistinguishable', async () => {
    const malformed = await get('../not-an-exam');
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toBe('Not found');
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
    expect(mocks.getExam).not.toHaveBeenCalled();

    for (const ownerId of ['anon:missing', 'anon:foreign', 'anon:deleted']) {
      mocks.resolveRequestOwnerId.mockImplementationOnce(
        (_request: NextRequest, responseHeaders: Headers) => {
          responseHeaders.append('Set-Cookie', `anonymous_id=${ownerId}; Path=/; HttpOnly`);
          return ownerId;
        },
      );
      mocks.getExam.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));

      const response = await get();

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      expect(response.headers.get('set-cookie')).toContain(`anonymous_id=${ownerId}`);
      expect(mocks.defaultExamServiceDeps).toHaveBeenLastCalledWith(ownerId);
    }
  });
});

describe('DELETE /api/zhongkao/exams/[examSessionId]', () => {
  it('returns 204 for both deletion and an idempotent already-deleted replay', async () => {
    const deleted = await remove();
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    expect(await deleted.text()).toBe('');
    expect(mocks.deleteExam).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);

    mocks.deleteExam.mockResolvedValueOnce('already_deleted');
    const replay = await remove();
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe('');
    expect(mocks.deleteExam).toHaveBeenCalledTimes(2);
  });

  it('fails a cross-owner delete as the same closed 404', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce(
      (_request: NextRequest, responseHeaders: Headers) => {
        responseHeaders.append('Set-Cookie', 'anonymous_id=foreign; Path=/; HttpOnly');
        return 'anon:foreign';
      },
    );
    mocks.deleteExam.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));

    const response = await remove();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=foreign');
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:foreign');
  });

  it('rejects malformed ids before resolving service dependencies', async () => {
    const response = await remove('not-an-exam');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=exam-test');
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
    expect(mocks.deleteExam).not.toHaveBeenCalled();
  });
});
