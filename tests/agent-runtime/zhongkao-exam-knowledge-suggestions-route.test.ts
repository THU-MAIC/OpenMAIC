import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamKnowledgeSuggestionsServiceDeps: vi.fn(),
  generateExamKnowledgeSuggestions: vi.fn(),
  getExamKnowledgeSuggestions: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

vi.mock('@/lib/server/zhongkao/exam-knowledge-suggestions-service', () => ({
  defaultExamKnowledgeSuggestionsServiceDeps: mocks.defaultExamKnowledgeSuggestionsServiceDeps,
  generateExamKnowledgeSuggestions: mocks.generateExamKnowledgeSuggestions,
  getExamKnowledgeSuggestions: mocks.getExamKnowledgeSuggestions,
}));

import { GET, POST } from '@/app/api/zhongkao/exams/[examSessionId]/knowledge-suggestions/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'knowledge-suggestions-service-deps' };
const PRIVATE_CANARY = 'PRIVATE_KNOWLEDGE_SUGGESTION_CANARY_H7K2';
const KNOWLEDGE_SUGGESTIONS = {
  schemaVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  subjectId: 'math',
  candidateStatus: 'candidate',
  questions: [
    {
      confirmedQuestionId: `exam-confirmed-question:v1:${'b'.repeat(64)}`,
      questionText: '虚构题目：解方程 2x = 8。',
      generationStatus: 'generated',
      suggestions: [
        {
          candidateId: `exam-knowledge-suggestion:v1:${'c'.repeat(64)}`,
          kind: 'existing_knowledge_point',
          knowledgePointId: 'fictional-linear-equations',
          confidenceBand: 'high',
          evidencePhrases: ['解方程'],
        },
      ],
    },
    {
      confirmedQuestionId: `exam-confirmed-question:v1:${'d'.repeat(64)}`,
      questionText: '虚构题目：说明推理过程。',
      generationStatus: 'no_suggestion',
      suggestions: [],
    },
  ],
} as const;

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function get(examSessionId = EXAM_SESSION_ID) {
  return GET(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/knowledge-suggestions`),
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
  return new NextRequest(
    `http://localhost/api/zhongkao/exams/${examSessionId}/knowledge-suggestions`,
    {
      method: 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  );
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
      responseHeaders.append(
        'Set-Cookie',
        'anonymous_id=knowledge-suggestions-test; Path=/; HttpOnly',
      );
      return 'anon:knowledge-suggestions-test';
    });
  mocks.defaultExamKnowledgeSuggestionsServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.getExamKnowledgeSuggestions.mockReset().mockResolvedValue(KNOWLEDGE_SUGGESTIONS);
  mocks.generateExamKnowledgeSuggestions.mockReset().mockResolvedValue({
    examSessionId: EXAM_SESSION_ID,
    knowledgeSuggestions: KNOWLEDGE_SUGGESTIONS,
    replayed: false,
  });
});

describe('GET /api/zhongkao/exams/[examSessionId]/knowledge-suggestions', () => {
  it('returns only the owner-scoped public candidate bundle with private no-store caching', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=knowledge-suggestions-test');
    const body = await response.json();
    expect(body).toEqual({ knowledgeSuggestions: KNOWLEDGE_SUGGESTIONS });
    expect(allKeys(body)).not.toEqual(
      expect.arrayContaining([
        'profileId',
        'ownerId',
        'learnerKey',
        'authoritySource',
        'correctness',
        'outcome',
        'studentResponse',
        'answerKey',
        'gradingSpec',
        'mastery',
        'progress',
        'errorType',
        'artifactRef',
        'sha256',
        'operationId',
        'eventId',
        'providerId',
        'modelId',
        'usage',
      ]),
    );
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).toHaveBeenCalledExactlyOnceWith(
      'anon:knowledge-suggestions-test',
    );
    expect(mocks.getExamKnowledgeSuggestions).toHaveBeenCalledWith(SERVICE_DEPS, EXAM_SESSION_ID);
  });

  it('fails malformed and foreign exam identities closed', async () => {
    const malformed = await get('not-an-exam');
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).not.toHaveBeenCalled();

    mocks.getExamKnowledgeSuggestions.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
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

describe('POST /api/zhongkao/exams/[examSessionId]/knowledge-suggestions', () => {
  it('accepts no body or closed JSON {} and uses 201 initially and 200 on replay', async () => {
    const firstRequest = postRequest();
    const first = await POST(firstRequest, params());
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(first.headers.get('set-cookie')).toContain('anonymous_id=knowledge-suggestions-test');
    await expect(first.json()).resolves.toEqual({
      examSessionId: EXAM_SESSION_ID,
      knowledgeSuggestions: KNOWLEDGE_SUGGESTIONS,
    });

    mocks.generateExamKnowledgeSuggestions.mockResolvedValueOnce({
      examSessionId: EXAM_SESSION_ID,
      knowledgeSuggestions: KNOWLEDGE_SUGGESTIONS,
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
      knowledgeSuggestions: KNOWLEDGE_SUGGESTIONS,
    });
    expect(replayBody).not.toHaveProperty('replayed');
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).toHaveBeenNthCalledWith(
      1,
      'anon:knowledge-suggestions-test',
      firstRequest.signal,
    );
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).toHaveBeenNthCalledWith(
      2,
      'anon:knowledge-suggestions-test',
      replayRequest.signal,
    );
    expect(mocks.generateExamKnowledgeSuggestions).toHaveBeenNthCalledWith(
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
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).not.toHaveBeenCalled();
    expect(mocks.generateExamKnowledgeSuggestions).not.toHaveBeenCalled();
  });

  it('fails malformed and foreign exam identities closed before generation', async () => {
    const malformed = await post({ examSessionId: 'not-an-exam' });
    expect(malformed.status).toBe(404);
    expect(mocks.defaultExamKnowledgeSuggestionsServiceDeps).not.toHaveBeenCalled();

    mocks.generateExamKnowledgeSuggestions.mockRejectedValueOnce(new ExamError('EXAM_NOT_FOUND'));
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
    ['EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY', 409, 'exam is not ready for knowledge suggestions'],
    [
      'EXAM_KNOWLEDGE_SUGGESTIONS_ALREADY_CONFIRMED',
      409,
      'exam knowledge mapping has already been confirmed',
    ],
    [
      'EXAM_KNOWLEDGE_SUGGESTION_PROVIDER_UNAVAILABLE',
      503,
      'exam knowledge suggestion provider is unavailable',
    ],
    ['EXAM_KNOWLEDGE_SUGGESTION_INVALID', 502, 'exam knowledge suggestions were invalid'],
    ['EXAM_KNOWLEDGE_SUGGESTION_FAILED', 500, 'exam knowledge suggestion generation failed'],
    [
      'EXAM_KNOWLEDGE_SUGGESTION_CONFLICT',
      409,
      'exam knowledge suggestions conflict with persisted facts',
    ],
    [
      'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT',
      409,
      'exam knowledge suggestion artifact failed integrity checks',
    ],
    ['EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED', 409, 'exam knowledge suggestion sources changed'],
  ] as const)('maps %s to status %i and a closed safe message', async (code, status, message) => {
    mocks.generateExamKnowledgeSuggestions.mockRejectedValueOnce(new ExamError(code));
    const response = await post();
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: code,
      error: message,
    });
  });

  it('closes unknown failures without reflecting private diagnostics', async () => {
    mocks.generateExamKnowledgeSuggestions.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} C:\\private\\provider-response.json`),
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
  });
});
