import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamServiceDeps: vi.fn(),
  getExamHumanReview: vi.fn(),
  confirmExamHumanReview: vi.fn(),
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

vi.mock('@/lib/server/zhongkao/exam-human-review-service', () => ({
  getExamHumanReview: mocks.getExamHumanReview,
  confirmExamHumanReview: mocks.confirmExamHumanReview,
}));

import { GET, POST } from '@/app/api/zhongkao/exams/[examSessionId]/review/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'review-service-deps' };
const REQUEST = {
  schemaVersion: 1,
  decisions: [
    { decisionType: 'confirm_question', questionCandidateId: 'question-candidate-1' },
    {
      decisionType: 'confirm_response',
      responseCandidateId: 'response-candidate-1',
      questionCandidateId: 'question-candidate-1',
    },
  ],
};
const SUMMARY = {
  status: 'confirmed',
  confirmedQuestionCount: 1,
  confirmedResponseCount: 1,
  confirmedMatchCount: 1,
  rejectedQuestionCount: 0,
  rejectedResponseCount: 0,
} as const;
const REVIEW = {
  schemaVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  profileId: 'fictional-profile',
  subjectId: 'math',
  reviewStatus: 'not_started',
  questions: [
    {
      questionCandidateId: 'question-candidate-1',
      candidateKind: 'leaf',
      rawLabel: '1.',
      locator: { sectionPath: [], printedNumber: '1', subquestionPath: [] },
      text: 'Fictional question?',
      sourceSpans: [{ pageNumber: 1, startBlockIndex: 0, endBlockIndex: 0 }],
      contentStatus: 'complete',
      confidenceBand: 'high',
      diagnosticReasonCodes: ['unique_explicit_top_level_label'],
    },
  ],
  responses: [
    {
      responseCandidateId: 'response-candidate-1',
      rawLabel: '1',
      locator: { sectionPath: [], printedNumber: '1', subquestionPath: [] },
      rawAnswerText: 'x=-2',
      answerStatus: 'text',
    },
  ],
  matches: [
    {
      responseCandidateId: 'response-candidate-1',
      status: 'matched',
      questionCandidateIds: ['question-candidate-1'],
      reasonCodes: [],
    },
  ],
  structuralDiagnostics: [],
};

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function get(examSessionId = EXAM_SESSION_ID) {
  return GET(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/review`),
    params(examSessionId),
  );
}

function post(body: BodyInit, contentType = 'application/json', examSessionId = EXAM_SESSION_ID) {
  return POST(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/review`, {
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
      responseHeaders.append('Set-Cookie', 'anonymous_id=review-test; Path=/; HttpOnly');
      return 'anon:review-test';
    });
  mocks.defaultExamServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.getExamHumanReview.mockReset().mockResolvedValue(REVIEW);
  mocks.confirmExamHumanReview.mockReset().mockResolvedValue({
    examSessionId: EXAM_SESSION_ID,
    humanReview: SUMMARY,
    replayed: false,
  });
});

describe('GET /api/zhongkao/exams/[examSessionId]/review', () => {
  it('returns the owner review bundle with private no-store caching', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=review-test');
    await expect(response.json()).resolves.toEqual({ review: REVIEW });
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:review-test');
    expect(mocks.getExamHumanReview).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);
  });

  it('fails malformed and foreign exam identities closed', async () => {
    const malformed = await get('not-an-exam');
    expect(malformed.status).toBe(404);
    expect(mocks.defaultExamServiceDeps).not.toHaveBeenCalled();

    mocks.getExamHumanReview.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const foreign = await get();
    expect(foreign.status).toBe(404);
    await expect(foreign.text()).resolves.toBe('Not found');
  });

  it('is hidden when the runtime feature is disabled', async () => {
    mocks.runtimeConfigured = false;
    const response = await get();
    expect(response.status).toBe(404);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });
});

describe('POST /api/zhongkao/exams/[examSessionId]/review', () => {
  it('returns only a safe summary with 201 initially and 200 on semantic replay', async () => {
    const first = await post(JSON.stringify(REQUEST));
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const firstBody = await first.json();
    expect(firstBody).toEqual({ examSessionId: EXAM_SESSION_ID, humanReview: SUMMARY });
    expect(allKeys(firstBody)).not.toEqual(
      expect.arrayContaining([
        'rawAnswerText',
        'questionText',
        'artifactRef',
        'sha256',
        'operationId',
        'eventId',
        'learnerKey',
      ]),
    );
    expect(mocks.confirmExamHumanReview).toHaveBeenCalledWith(
      SERVICE_DEPS,
      EXAM_SESSION_ID,
      REQUEST,
    );

    mocks.confirmExamHumanReview.mockResolvedValueOnce({
      examSessionId: EXAM_SESSION_ID,
      humanReview: SUMMARY,
      replayed: true,
    });
    const replay = await post(JSON.stringify(REQUEST));
    expect(replay.status).toBe(200);
  });

  it('rejects malformed JSON, non-JSON, missing bodies, and oversized bodies before dispatch', async () => {
    for (const response of [
      await post('{'),
      await post('{}', 'text/plain'),
      await POST(
        new NextRequest(`http://localhost/api/zhongkao/exams/${EXAM_SESSION_ID}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
        params(),
      ),
      await post('x'.repeat(2 * 1024 * 1024 + 1)),
    ]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        errorCode: 'EXAM_REVIEW_INPUT_INVALID',
        error: 'invalid exam review request',
      });
    }
    expect(mocks.confirmExamHumanReview).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 and malformed exam ids before service dispatch', async () => {
    const invalidUtf8 = await post(new Uint8Array([0xc3, 0x28]));
    expect(invalidUtf8.status).toBe(400);
    const malformedId = await post(JSON.stringify(REQUEST), 'application/json', 'foreign');
    expect(malformedId.status).toBe(404);
    expect(mocks.confirmExamHumanReview).not.toHaveBeenCalled();
  });

  it.each([
    ['EXAM_REVIEW_NOT_READY', 409],
    ['EXAM_REVIEW_INCOMPLETE', 422],
    ['EXAM_REVIEW_CONFLICT', 409],
    ['EXAM_REVIEW_SOURCE_CHANGED', 409],
    ['EXAM_REVIEW_ARTIFACT_CORRUPT', 409],
    ['EXAM_REVIEW_FAILED', 500],
  ] as const)('maps %s to a closed safe response', async (code, status) => {
    mocks.confirmExamHumanReview.mockRejectedValueOnce(new ExamError(code));
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, errorCode: code });
    expect(JSON.stringify(body)).not.toContain('private/path');
  });
});
