import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamServiceDeps: vi.fn(),
  confirmExamAnswerKeyAndGrade: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

vi.mock('@/lib/server/zhongkao/exam-service', () => ({
  defaultExamServiceDeps: mocks.defaultExamServiceDeps,
}));

vi.mock('@/lib/server/zhongkao/exam-grading-service', () => ({
  confirmExamAnswerKeyAndGrade: mocks.confirmExamAnswerKeyAndGrade,
}));

import { POST } from '@/app/api/zhongkao/exams/[examSessionId]/answer-key/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const CONFIRMED_QUESTION_ID = `confirmed-question:v1:${'b'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'answer-key-service-deps' };
const PRIVATE_CANARY = 'PRIVATE_EXPECTED_ANSWER_CANARY_7Q4M';
const REQUEST = {
  schemaVersion: 1,
  entries: [
    {
      confirmedQuestionId: CONFIRMED_QUESTION_ID,
      type: 'exact_short_answer',
      acceptedAnswers: [PRIVATE_CANARY],
    },
  ],
};
const GRADING = {
  status: 'completed',
  assessmentCount: 1,
  evaluatedCount: 1,
  correctCount: 1,
  incorrectCount: 0,
  unassessedCount: 0,
} as const;

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function post(body: BodyInit, contentType = 'application/json', examSessionId = EXAM_SESSION_ID) {
  return POST(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/answer-key`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
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
      responseHeaders.append('Set-Cookie', 'anonymous_id=answer-key-test; Path=/; HttpOnly');
      return 'anon:answer-key-test';
    });
  mocks.defaultExamServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.confirmExamAnswerKeyAndGrade.mockReset().mockResolvedValue({
    examSessionId: EXAM_SESSION_ID,
    grading: GRADING,
    replayed: false,
  });
});

describe('POST /api/zhongkao/exams/[examSessionId]/answer-key', () => {
  it('uses owner-authorized deps and returns only a private counts summary', async () => {
    const response = await post(JSON.stringify(REQUEST), 'application/json; charset=utf-8');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=answer-key-test');
    const body = await response.json();
    expect(body).toEqual({ examSessionId: EXAM_SESSION_ID, grading: GRADING });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_CANARY);
    expect(allKeys(body)).not.toEqual(
      expect.arrayContaining([
        'expectedOptionId',
        'expectedOptionIds',
        'expectedValue',
        'acceptedAnswers',
        'gradingSpec',
        'rawAnswerText',
        'artifactRef',
        'objectKey',
        'sha256',
        'operationId',
        'eventId',
        'learnerKey',
        'ownerId',
        'score',
        'knowledgePointIds',
      ]),
    );
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:answer-key-test');
    expect(mocks.confirmExamAnswerKeyAndGrade).toHaveBeenCalledWith(
      SERVICE_DEPS,
      EXAM_SESSION_ID,
      REQUEST,
    );
  });

  it('returns 200 for a semantic replay', async () => {
    mocks.confirmExamAnswerKeyAndGrade.mockResolvedValueOnce({
      examSessionId: EXAM_SESSION_ID,
      grading: GRADING,
      replayed: true,
    });
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      examSessionId: EXAM_SESSION_ID,
      grading: GRADING,
    });
  });

  it('rejects malformed JSON, non-JSON, missing bodies, and bodies over four MiB', async () => {
    const responses = [
      await post('{'),
      await post('{}', 'text/plain'),
      await POST(
        new NextRequest(`http://localhost/api/zhongkao/exams/${EXAM_SESSION_ID}/answer-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
        params(),
      ),
      await post('x'.repeat(4 * 1024 * 1024 + 1)),
    ];

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        success: false,
        errorCode: 'EXAM_ANSWER_KEY_INPUT_INVALID',
        error: 'invalid exam answer key request',
      });
    }
    expect(mocks.confirmExamAnswerKeyAndGrade).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 and malformed Exam ids before service dispatch', async () => {
    const invalidUtf8 = await post(new Uint8Array([0xc3, 0x28]));
    expect(invalidUtf8.status).toBe(400);
    const malformedId = await post(JSON.stringify(REQUEST), 'application/json', 'foreign');
    expect(malformedId.status).toBe(404);
    expect(malformedId.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.confirmExamAnswerKeyAndGrade).not.toHaveBeenCalled();
  });

  it('makes a foreign Exam indistinguishable from a missing Exam', async () => {
    mocks.confirmExamAnswerKeyAndGrade.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe('Not found');
  });

  it('is hidden before owner resolution when the runtime feature is disabled', async () => {
    mocks.runtimeConfigured = false;
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();
  });

  it.each([
    ['EXAM_GRADING_NOT_READY', 409, 'exam is not ready for grading'],
    ['EXAM_ANSWER_KEY_INPUT_INVALID', 400, 'invalid exam answer key request'],
    ['EXAM_ANSWER_KEY_INCOMPLETE', 422, 'exam answer key is incomplete'],
    ['EXAM_ANSWER_KEY_CONFLICT', 409, 'exam answer key conflicts with persisted facts'],
    ['EXAM_ANSWER_KEY_ARTIFACT_CORRUPT', 409, 'exam answer key artifact failed integrity checks'],
    ['EXAM_GRADING_FAILED', 500, 'exam grading failed'],
    ['EXAM_GRADING_CONFLICT', 409, 'exam grading conflicts with persisted facts'],
    ['EXAM_ASSESSMENT_ARTIFACT_CORRUPT', 409, 'exam assessment artifact failed integrity checks'],
  ] as const)('maps %s to status %i and a stable safe message', async (code, status, message) => {
    mocks.confirmExamAnswerKeyAndGrade.mockRejectedValueOnce(new ExamError(code));
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: code,
      error: message,
    });
  });

  it('closes unknown failures without reflecting private diagnostics', async () => {
    mocks.confirmExamAnswerKeyAndGrade.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} C:\\private\\answers.json materials/v1/exams/private`),
    );
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      errorCode: 'EXAM_SESSION_CONFLICT',
      error: 'exam session changed concurrently',
    });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_CANARY);
  });
});
