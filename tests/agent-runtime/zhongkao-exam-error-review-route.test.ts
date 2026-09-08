import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamErrorReviewServiceDeps: vi.fn(),
  getExamErrorReview: vi.fn(),
  confirmExamErrorReview: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

vi.mock('@/lib/server/zhongkao/exam-error-review-service', () => ({
  defaultExamErrorReviewServiceDeps: mocks.defaultExamErrorReviewServiceDeps,
  getExamErrorReview: mocks.getExamErrorReview,
  confirmExamErrorReview: mocks.confirmExamErrorReview,
}));

import { GET, POST } from '@/app/api/zhongkao/exams/[examSessionId]/error-review/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const CONFIRMED_QUESTION_ID = `exam-confirmed-question:v1:${'b'.repeat(64)}`;
const CANDIDATE_ID = `exam-error-candidate:v1:${'c'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'error-review-service-deps' };
const PRIVATE_CANARY = 'PRIVATE_ERROR_REVIEW_CANARY_8X2Q';
const REQUEST = {
  schemaVersion: 1,
  questions: [
    {
      confirmedQuestionId: CONFIRMED_QUESTION_ID,
      candidateDecisions: [
        {
          candidateId: CANDIDATE_ID,
          decision: 'accept',
        },
      ],
    },
  ],
};
const ERROR_REVIEW = {
  schemaVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  profileId: 'fictional-profile',
  subjectId: 'math',
  status: 'awaiting_confirmation',
  questions: [
    {
      confirmedQuestionId: CONFIRMED_QUESTION_ID,
      outcome: 'incorrect',
      suggestions: [
        {
          candidateId: CANDIDATE_ID,
          kind: 'calculation_error_candidate',
          evidence: [{ evidenceType: 'response_excerpt', text: '2 + 3 = 6' }],
        },
      ],
    },
  ],
};
const SUMMARY = {
  status: 'confirmed',
  reviewedQuestionCount: 1,
  reviewedCandidateCount: 1,
  acceptedCandidateCount: 1,
  rejectedCandidateCount: 0,
  confirmedObservationCount: 1,
} as const;

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function get(examSessionId = EXAM_SESSION_ID) {
  return GET(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/error-review`),
    params(examSessionId),
  );
}

function post(body: BodyInit, contentType = 'application/json', examSessionId = EXAM_SESSION_ID) {
  return POST(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/error-review`, {
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
      responseHeaders.append('Set-Cookie', 'anonymous_id=error-review-test; Path=/; HttpOnly');
      return 'anon:error-review-test';
    });
  mocks.defaultExamErrorReviewServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.getExamErrorReview.mockReset().mockResolvedValue(ERROR_REVIEW);
  mocks.confirmExamErrorReview.mockReset().mockResolvedValue({
    examSessionId: EXAM_SESSION_ID,
    errorReview: SUMMARY,
    replayed: false,
  });
});

describe('GET /api/zhongkao/exams/[examSessionId]/error-review', () => {
  it('returns the owner review bundle with private no-store caching', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=error-review-test');
    await expect(response.json()).resolves.toEqual({ errorReview: ERROR_REVIEW });
    expect(mocks.defaultExamErrorReviewServiceDeps).toHaveBeenCalledWith('anon:error-review-test');
    expect(mocks.getExamErrorReview).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);
  });

  it('fails malformed and foreign Exam identities closed', async () => {
    const malformed = await get('not-an-exam');
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.defaultExamErrorReviewServiceDeps).not.toHaveBeenCalled();

    mocks.getExamErrorReview.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const foreign = await get();
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('cache-control')).toBe('private, no-store');
    await expect(foreign.text()).resolves.toBe('Not found');
  });
});

describe('POST /api/zhongkao/exams/[examSessionId]/error-review', () => {
  it('forwards the closed question decision set and returns only a safe summary', async () => {
    const response = await post(JSON.stringify(REQUEST), 'application/json; charset=utf-8');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=error-review-test');
    const body = await response.json();
    expect(body).toEqual({ examSessionId: EXAM_SESSION_ID, errorReview: SUMMARY });
    expect(allKeys(body)).not.toEqual(
      expect.arrayContaining([
        'questions',
        'candidateId',
        'confirmedQuestionId',
        'kind',
        'evidence',
        'outcome',
        'reason',
        'questionText',
        'rawAnswerText',
        'artifactRef',
        'sha256',
        'operationId',
        'eventId',
        'learnerKey',
        'ownerId',
        'provider',
        'model',
      ]),
    );
    expect(mocks.defaultExamErrorReviewServiceDeps).toHaveBeenCalledWith('anon:error-review-test');
    expect(mocks.confirmExamErrorReview).toHaveBeenCalledWith(
      SERVICE_DEPS,
      EXAM_SESSION_ID,
      REQUEST,
    );
  });

  it('returns 200 for a completed semantic replay', async () => {
    mocks.confirmExamErrorReview.mockResolvedValueOnce({
      examSessionId: EXAM_SESSION_ID,
      errorReview: SUMMARY,
      replayed: true,
    });
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(200);
  });

  it('rejects malformed, non-JSON, missing, oversized, and invalid UTF-8 bodies', async () => {
    const responses = [
      await post('{'),
      await post('{}', 'text/plain'),
      await POST(
        new NextRequest(`http://localhost/api/zhongkao/exams/${EXAM_SESSION_ID}/error-review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
        params(),
      ),
      await post('x'.repeat(2 * 1024 * 1024 + 1)),
      await post(new Uint8Array([0xc3, 0x28])),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        success: false,
        errorCode: 'EXAM_ERROR_REVIEW_INPUT_INVALID',
        error: 'invalid exam error review request',
      });
    }
    expect(mocks.confirmExamErrorReview).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and makes foreign Exams indistinguishable from missing Exams', async () => {
    const malformed = await post(JSON.stringify(REQUEST), 'application/json', 'foreign');
    expect(malformed.status).toBe(404);
    mocks.confirmExamErrorReview.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const foreign = await post(JSON.stringify(REQUEST));
    expect(foreign.status).toBe(404);
    await expect(foreign.text()).resolves.toBe('Not found');
  });

  it.each([
    ['EXAM_ERROR_REVIEW_NOT_READY', 409, 'exam is not ready for error review'],
    ['EXAM_ERROR_REVIEW_INPUT_INVALID', 400, 'invalid exam error review request'],
    ['EXAM_ERROR_REVIEW_INCOMPLETE', 422, 'exam error review decisions are incomplete'],
    ['EXAM_ERROR_REVIEW_CONFLICT', 409, 'exam error review conflicts with persisted facts'],
    ['EXAM_ERROR_REVIEW_SOURCE_CHANGED', 409, 'exam error review sources changed'],
    [
      'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
      409,
      'exam error review artifact failed integrity checks',
    ],
    ['EXAM_ERROR_REVIEW_FAILED', 500, 'exam error review failed'],
  ] as const)('maps %s to status %i and a safe message', async (code, status, message) => {
    mocks.confirmExamErrorReview.mockRejectedValueOnce(new ExamError(code));
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: code,
      error: message,
    });
  });

  it('closes unknown failures without reflecting private diagnostics', async () => {
    mocks.confirmExamErrorReview.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} C:\\private\\error-review.json`),
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

describe('error-review feature boundary', () => {
  it.each([
    ['GET', () => get()],
    ['POST', () => post(JSON.stringify(REQUEST))],
  ])(
    'hides %s before owner resolution when the runtime feature is disabled',
    async (_method, run) => {
      mocks.runtimeConfigured = false;
      const response = await run();
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    },
  );
});
