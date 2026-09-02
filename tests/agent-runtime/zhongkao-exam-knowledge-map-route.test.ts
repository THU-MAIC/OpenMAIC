import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExamError } from '@/lib/zhongkao/exam-errors';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  defaultExamServiceDeps: vi.fn(),
  confirmExamKnowledgeMappingAndProjectObservations: vi.fn(),
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

vi.mock('@/lib/server/zhongkao/exam-knowledge-mapping-service', () => ({
  confirmExamKnowledgeMappingAndProjectObservations:
    mocks.confirmExamKnowledgeMappingAndProjectObservations,
}));

import { POST } from '@/app/api/zhongkao/exams/[examSessionId]/knowledge-map/route';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const CONFIRMED_QUESTION_ID = `exam-confirmed-question:v1:${'b'.repeat(64)}`;
const SERVICE_DEPS = { marker: 'knowledge-map-service-deps' };
const PRIVATE_CANARY = 'PRIVATE_KNOWLEDGE_MAPPING_CANARY_8X2Q';
const REQUEST = {
  schemaVersion: 1,
  entries: [
    {
      confirmedQuestionId: CONFIRMED_QUESTION_ID,
      decision: 'mapped',
      knowledgePointIds: ['fictional-linear-equations'],
    },
  ],
};
const RESULT = {
  examSessionId: EXAM_SESSION_ID,
  knowledgeMapping: {
    status: 'confirmed',
    mappedQuestionCount: 1,
    unmappedQuestionCount: 0,
  },
  observationProjection: { status: 'completed', observationCount: 1 },
  replayed: false,
} as const;

function params(examSessionId = EXAM_SESSION_ID) {
  return { params: Promise.resolve({ examSessionId }) };
}

function post(body: BodyInit, contentType = 'application/json', examSessionId = EXAM_SESSION_ID) {
  return POST(
    new NextRequest(`http://localhost/api/zhongkao/exams/${examSessionId}/knowledge-map`, {
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
      responseHeaders.append('Set-Cookie', 'anonymous_id=knowledge-map-test; Path=/; HttpOnly');
      return 'anon:knowledge-map-test';
    });
  mocks.defaultExamServiceDeps.mockReset().mockResolvedValue(SERVICE_DEPS);
  mocks.confirmExamKnowledgeMappingAndProjectObservations.mockReset().mockResolvedValue(RESULT);
});

describe('POST /api/zhongkao/exams/[examSessionId]/knowledge-map', () => {
  it('uses owner-authorized deps and returns only safe counts', async () => {
    const response = await post(JSON.stringify(REQUEST), 'application/json; charset=utf-8');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=knowledge-map-test');
    const body = await response.json();
    expect(body).toEqual({
      examSessionId: EXAM_SESSION_ID,
      knowledgeMapping: RESULT.knowledgeMapping,
      observationProjection: RESULT.observationProjection,
    });
    expect(allKeys(body)).not.toEqual(
      expect.arrayContaining([
        'knowledgePointIds',
        'confirmedQuestionId',
        'outcome',
        'assessmentStatus',
        'observationId',
        'occasionId',
        'mappingSource',
        'artifactRef',
        'sha256',
        'operationId',
        'eventId',
        'learnerKey',
        'ownerId',
      ]),
    );
    expect(mocks.defaultExamServiceDeps).toHaveBeenCalledWith('anon:knowledge-map-test');
    expect(mocks.confirmExamKnowledgeMappingAndProjectObservations).toHaveBeenCalledWith(
      SERVICE_DEPS,
      EXAM_SESSION_ID,
      REQUEST,
    );
  });

  it('returns 200 for a completed semantic replay', async () => {
    mocks.confirmExamKnowledgeMappingAndProjectObservations.mockResolvedValueOnce({
      ...RESULT,
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
        new NextRequest(`http://localhost/api/zhongkao/exams/${EXAM_SESSION_ID}/knowledge-map`, {
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
      await expect(response.json()).resolves.toEqual({
        success: false,
        errorCode: 'EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID',
        error: 'invalid exam knowledge mapping request',
      });
    }
    expect(mocks.confirmExamKnowledgeMappingAndProjectObservations).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and makes foreign Exams indistinguishable from missing Exams', async () => {
    const malformed = await post(JSON.stringify(REQUEST), 'application/json', 'foreign');
    expect(malformed.status).toBe(404);
    mocks.confirmExamKnowledgeMappingAndProjectObservations.mockRejectedValueOnce(
      new ExamError('EXAM_NOT_FOUND'),
    );
    const foreign = await post(JSON.stringify(REQUEST));
    expect(foreign.status).toBe(404);
    await expect(foreign.text()).resolves.toBe('Not found');
  });

  it('is hidden before owner resolution when the runtime feature is disabled', async () => {
    mocks.runtimeConfigured = false;
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it.each([
    ['EXAM_KNOWLEDGE_MAPPING_NOT_READY', 409, 'exam is not ready for knowledge mapping'],
    ['EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID', 400, 'invalid exam knowledge mapping request'],
    ['EXAM_KNOWLEDGE_MAPPING_INCOMPLETE', 422, 'exam knowledge mapping is incomplete'],
    [
      'EXAM_KNOWLEDGE_MAPPING_CONFLICT',
      409,
      'exam knowledge mapping conflicts with persisted facts',
    ],
    ['EXAM_KNOWLEDGE_MAPPING_FAILED', 500, 'exam knowledge mapping failed'],
    [
      'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT',
      409,
      'exam knowledge mapping artifact failed integrity checks',
    ],
    ['EXAM_OBSERVATION_PROJECTION_FAILED', 500, 'exam observation projection failed'],
    ['EXAM_OBSERVATION_ARTIFACT_CORRUPT', 409, 'exam observation artifact failed integrity checks'],
    ['EXAM_OBSERVATION_SOURCE_CHANGED', 409, 'exam observation sources changed'],
  ] as const)('maps %s to status %i and a safe message', async (code, status, message) => {
    mocks.confirmExamKnowledgeMappingAndProjectObservations.mockRejectedValueOnce(
      new ExamError(code),
    );
    const response = await post(JSON.stringify(REQUEST));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      success: false,
      errorCode: code,
      error: message,
    });
  });

  it('closes unknown failures without reflecting private diagnostics', async () => {
    mocks.confirmExamKnowledgeMappingAndProjectObservations.mockRejectedValueOnce(
      new Error(`${PRIVATE_CANARY} C:\\private\\mapping.json`),
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
