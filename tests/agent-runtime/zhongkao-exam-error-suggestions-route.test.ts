import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamErrorSuggestionsServiceDeps: vi.fn(),
  generateExamErrorSuggestions: vi.fn(),
  getExamErrorSuggestions: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

vi.mock('@/lib/server/zhongkao/exam-error-suggestions-service', () => ({
  defaultExamErrorSuggestionsServiceDeps: mocks.defaultExamErrorSuggestionsServiceDeps,
  generateExamErrorSuggestions: mocks.generateExamErrorSuggestions,
  getExamErrorSuggestions: mocks.getExamErrorSuggestions,
}));

import { GET, POST } from '@/app/api/zhongkao/exams/[examSessionId]/error-suggestions/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'error-suggestions-service-deps' };
const PRIVATE_CANARY = 'PRIVATE_ERROR_SUGGESTION_CANARY_J8P4';
const ERROR_SUGGESTIONS = {
  schemaVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  subjectId: 'math',
  candidateStatus: 'candidate',
  questions: [
    {
      confirmedQuestionId: `exam-confirmed-question:v1:${'b'.repeat(64)}`,
      questionText: '虚构题目：选择正确选项。',
      confirmedResponse: { answerStatus: 'text', rawAnswerText: 'C' },
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [
        {
          candidateId: `exam-error-suggestion:v1:${'c'.repeat(64)}`,
          kind: 'single_choice_option_mismatch_candidate',
          generationSource: 'deterministic_candidate',
          candidateStatus: 'candidate',
          confidenceBand: 'high',
          evidence: [
            {
              evidenceType: 'option_set_difference',
              missingOptions: ['B'],
              extraOptions: ['C'],
            },
          ],
        },
      ],
    },
  ],
} as const;

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function get(examSessionId = EXAM_SESSION_ID) {
  return GET(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/error-suggestions`),
    params(examSessionId),
  );
}

interface PostOptions {
  body?: BodyInit;
  contentType?: string;
  examSessionId?: string;
}

function postRequest(options: PostOptions = {}): NextRequest {
  const examSessionId = options.examSessionId ?? EXAM_SESSION_ID;
  const headers = new Headers();
  if (options.contentType !== undefined) headers.set('content-type', options.contentType);
  return new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/error-suggestions`, {
    method: 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function post(options: PostOptions = {}) {
  const examSessionId = options.examSessionId ?? EXAM_SESSION_ID;
  return POST(postRequest(options), params(examSessionId));
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
      responseHeaders.append('Set-Cookie', 'anonymous_id=error-suggestions-test; Path=/; HttpOnly');
      return 'anon:error-suggestions-test';
    });
  mocks.defaultExamErrorSuggestionsServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.getExamErrorSuggestions.mockReset().mockResolvedValue(ERROR_SUGGESTIONS);
  mocks.generateExamErrorSuggestions.mockReset().mockResolvedValue({
    examSessionId: EXAM_SESSION_ID,
    errorSuggestions: ERROR_SUGGESTIONS,
    replayed: false,
  });
});

describe('GET /api/zhongkao/exams/[examSessionId]/error-suggestions', () => {
  it('returns only the owner-scoped review bundle with private no-store caching', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=error-suggestions-test');
    const body = await response.json();
    expect(body).toEqual({ errorSuggestions: ERROR_SUGGESTIONS });
    expect(allKeys(body)).not.toEqual(
      expect.arrayContaining([
        'profileId',
        'ownerId',
        'learnerKey',
        'answerKey',
        'gradingSpec',
        'acceptedAnswers',
        'expectedAnswer',
        'authoritySource',
        'mastery',
        'progress',
        'artifactRef',
        'sha256',
        'operationId',
        'eventId',
        'providerId',
        'modelId',
        'usage',
        'reasoning',
      ]),
    );
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).toHaveBeenCalledExactlyOnceWith(
      'anon:error-suggestions-test',
    );
    expect(mocks.getExamErrorSuggestions).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);
  });

  it('fails malformed and foreign exam identities closed', async () => {
    const malformed = await get('not-an-exam');
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).not.toHaveBeenCalled();

    mocks.getExamErrorSuggestions.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const foreign = await get();
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('cache-control')).toBe('private, no-store');
    await expect(foreign.text()).resolves.toBe('Not found');
  });

  it('is hidden before owner resolution when the runtime feature is disabled', async () => {
    mocks.runtimeConfigured = false;
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });
});

describe('POST /api/zhongkao/exams/[examSessionId]/error-suggestions', () => {
  it('accepts no body or closed JSON {} and uses 201 initially and 200 on replay', async () => {
    const firstRequest = postRequest();
    const first = await POST(firstRequest, params());
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(first.headers.get('set-cookie')).toContain('anonymous_id=error-suggestions-test');
    await expect(first.json()).resolves.toEqual({
      examSessionId: EXAM_SESSION_ID,
      errorSuggestions: ERROR_SUGGESTIONS,
    });

    mocks.generateExamErrorSuggestions.mockResolvedValueOnce({
      examSessionId: EXAM_SESSION_ID,
      errorSuggestions: ERROR_SUGGESTIONS,
      replayed: true,
    });
    const replayRequest = postRequest({
      body: '{}',
      contentType: 'Application/JSON; charset=utf-8',
    });
    const replay = await POST(replayRequest, params());
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody).toEqual({
      examSessionId: EXAM_SESSION_ID,
      errorSuggestions: ERROR_SUGGESTIONS,
    });
    expect(replayBody).not.toHaveProperty('replayed');
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).toHaveBeenNthCalledWith(
      1,
      'anon:error-suggestions-test',
      firstRequest.signal,
    );
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).toHaveBeenNthCalledWith(
      2,
      'anon:error-suggestions-test',
      replayRequest.signal,
    );
    expect(mocks.generateExamErrorSuggestions).toHaveBeenNthCalledWith(
      1,
      SERVICE_DEPS,
      EXAM_SESSION_ID,
    );
  });

  it('rejects non-empty, malformed, non-JSON, oversized, and invalid UTF-8 bodies', async () => {
    const responses = [
      await post({ body: '{', contentType: 'application/json' }),
      await post({ body: '[]', contentType: 'application/json' }),
      await post({ body: 'null', contentType: 'application/json' }),
      await post({ body: '{"unexpected":true}', contentType: 'application/json' }),
      await post({ body: '{}', contentType: 'text/plain' }),
      await post({ body: 'x'.repeat(1025), contentType: 'application/json' }),
      await post({ body: new Uint8Array([0xc3, 0x28]), contentType: 'application/json' }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        success: false,
        errorCode: 'EXAM_INPUT_INVALID',
        error: 'invalid exam request',
      });
    }
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).not.toHaveBeenCalled();
    expect(mocks.generateExamErrorSuggestions).not.toHaveBeenCalled();
  });

  it('fails malformed and foreign exam identities closed before generation', async () => {
    const malformed = await post({ examSessionId: 'not-an-exam' });
    expect(malformed.status).toBe(404);
    expect(mocks.defaultExamErrorSuggestionsServiceDeps).not.toHaveBeenCalled();

    mocks.generateExamErrorSuggestions.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
    const foreign = await post();
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('cache-control')).toBe('private, no-store');
    await expect(foreign.text()).resolves.toBe('Not found');
  });

  it('is hidden before owner resolution when the runtime feature is disabled', async () => {
    mocks.runtimeConfigured = false;
    const response = await post();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it.each([
    ['EXAM_ERROR_SUGGESTIONS_NOT_READY', 409, 'exam is not ready for error suggestions'],
    [
      'EXAM_ERROR_SUGGESTION_PROVIDER_UNAVAILABLE',
      503,
      'exam error suggestion provider is unavailable',
    ],
    ['EXAM_ERROR_SUGGESTION_INVALID', 502, 'exam error suggestions were invalid'],
    ['EXAM_ERROR_SUGGESTION_FAILED', 500, 'exam error suggestion generation failed'],
    ['EXAM_ERROR_SUGGESTION_CONFLICT', 409, 'exam error suggestions conflict with persisted facts'],
    [
      'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT',
      409,
      'exam error suggestion artifact failed integrity checks',
    ],
    ['EXAM_ERROR_SUGGESTION_SOURCE_CHANGED', 409, 'exam error suggestion sources changed'],
  ] as const)('maps %s to status %i and a closed safe message', async (code, status, message) => {
    mocks.generateExamErrorSuggestions.mockRejectedValueOnce(new ExamError(code));
    const response = await post();
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: code,
      error: message,
    });
  });

  it('closes unknown failures without reflecting grading or provider diagnostics', async () => {
    mocks.generateExamErrorSuggestions.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} expected=B C:\\private\\provider-response.json`),
    );
    const response = await post();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      errorCode: 'EXAM_SESSION_CONFLICT',
      error: 'exam session changed concurrently',
    });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(body)).not.toContain('expected=B');
  });
});
