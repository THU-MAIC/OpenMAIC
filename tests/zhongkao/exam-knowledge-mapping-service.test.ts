import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialByteStoreError, type MaterialByteStore } from '@/lib/server/materials/bytes';
import {
  examKnowledgeMappingObjectKey,
  examObservationsObjectKey,
} from '@/lib/server/materials/object-keys';
import type { ExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import { ExamKnowledgeMappingPrivateError } from '@/lib/server/zhongkao/exam-knowledge-mapping-private';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const CREATED_AT = '2026-09-01T08:00:00.000Z';
const REVIEW_SHA = '1'.repeat(64);
const REVIEW_SEMANTIC = '2'.repeat(64);
const ASSESSMENT_SHA = '3'.repeat(64);
const ASSESSMENT_SEMANTIC = '4'.repeat(64);
const MAPPING_SEMANTIC = '5'.repeat(64);
const CHANGED_MAPPING_SEMANTIC = '6'.repeat(64);
const OBSERVATION_SEMANTIC = '7'.repeat(64);
const MAPPING_SUFFIX = 'confirmed_exam_knowledge_mapping_v1.json';
const OBSERVATIONS_SUFFIX = 'confirmed_exam_observations_v1.json';

const runtimeMocks = vi.hoisted(() => ({
  loadExamRuntime: vi.fn(),
  appendExamRuntimeEvent: vi.fn(),
}));

const sourceMocks = vi.hoisted(() => ({
  resolveReview: vi.fn(),
  resolveAnswerKey: vi.fn(),
  resolveAssessments: vi.fn(),
}));

const privateMocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  buildMapping: vi.fn(),
  parseMapping: vi.fn(),
  serializeMapping: vi.fn(),
  buildObservations: vi.fn(),
  parseObservations: vi.fn(),
  serializeObservations: vi.fn(),
}));

vi.mock('@/lib/server/zhongkao/exam-runtime', () => ({
  loadExamRuntime: runtimeMocks.loadExamRuntime,
  appendExamRuntimeEvent: runtimeMocks.appendExamRuntimeEvent,
  createExamOperationFingerprint: () => '8'.repeat(64),
  deriveExamEventId: (operationId: string) => `event:${operationId}`,
  deriveExamKnowledgeMappingRef: () => 'mapping-ref',
  deriveExamKnowledgeMappingArtifactRef: () => 'mapping-artifact-ref',
  deriveExamObservationProjectionRef: () => 'observation-ref',
  deriveExamObservationArtifactRef: () => 'observation-artifact-ref',
  deriveExamKnowledgeMappingStartedOperationId: () => 'mapping-started-op',
  deriveExamKnowledgeMappingConfirmedOperationId: () => 'mapping-confirmed-op',
  deriveExamObservationProjectionStartedOperationId: () => 'observation-started-op',
  deriveExamObservationsProjectedOperationId: () => 'observations-projected-op',
}));

vi.mock('@/lib/server/zhongkao/exam-human-review-service', () => ({
  resolveConfirmedExamReviewFactsFromRuntime: sourceMocks.resolveReview,
}));

vi.mock('@/lib/server/zhongkao/exam-grading-service', () => ({
  resolveAuthoritativeExamAnswerKeyFromRuntime: sourceMocks.resolveAnswerKey,
  resolveExamQuestionAssessmentsFromRuntime: sourceMocks.resolveAssessments,
}));

vi.mock('@/lib/server/zhongkao/exam-knowledge-mapping-private', () => ({
  EXAM_KNOWLEDGE_MAPPING_VERSION: 1,
  EXAM_OBSERVATION_PROJECTION_VERSION: 1,
  ExamKnowledgeMappingPrivateError: class ExamKnowledgeMappingPrivateError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  parseExamKnowledgeMappingRequest: privateMocks.parseRequest,
  buildConfirmedExamKnowledgeMappingArtifact: privateMocks.buildMapping,
  parseConfirmedExamKnowledgeMappingArtifact: privateMocks.parseMapping,
  serializeConfirmedExamKnowledgeMappingArtifact: privateMocks.serializeMapping,
  buildConfirmedExamObservationsArtifact: privateMocks.buildObservations,
  parseConfirmedExamObservationsArtifact: privateMocks.parseObservations,
  serializeConfirmedExamObservationsArtifact: privateMocks.serializeObservations,
}));

vi.mock('@/lib/zhongkao/exam-state', () => ({
  toPublicExamSession: (state: FakeState) => ({
    knowledgeMapping:
      state.knowledgeMapping?.status === 'confirmed'
        ? {
            status: 'confirmed',
            mappedQuestionCount: state.knowledgeMapping.mappingArtifact?.mappedQuestionCount,
            unmappedQuestionCount: state.knowledgeMapping.mappingArtifact?.unmappedQuestionCount,
          }
        : { status: state.knowledgeMapping ? 'processing' : 'not_started' },
    observationProjection:
      state.observationProjection?.status === 'completed'
        ? {
            status: 'completed',
            observationCount: state.observationProjection.observationArtifact?.observationCount,
          }
        : { status: state.observationProjection ? 'processing' : 'not_started' },
  }),
}));

import {
  confirmExamKnowledgeMappingAndProjectObservations,
  resolveConfirmedExamKnowledgeMapping,
  resolveConfirmedExamObservations,
} from '@/lib/server/zhongkao/exam-knowledge-mapping-service';

interface FakeKnowledgeMappingState extends Record<string, unknown> {
  status: 'mapping' | 'confirmed';
  assessmentArtifactRef?: string;
  mappingArtifact?: {
    byteLength: number;
    sha256: string;
    entryCount: number;
    mappedQuestionCount: number;
    unmappedQuestionCount: number;
  };
}

interface FakeObservationProjectionState extends Record<string, unknown> {
  status: 'projecting' | 'completed';
  sourceMappingSemanticFingerprint?: string;
  observationArtifact?: {
    byteLength: number;
    sha256: string;
    observationCount: number;
    evaluatedCount: number;
    correctCount: number;
    incorrectCount: number;
    unassessedCount: number;
  };
}

interface FakeState {
  status: 'ready_for_extraction' | 'deleting' | 'deleted';
  revision: number;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  createdAt: string;
  humanReview: {
    status: 'confirmed';
    reviewVersion: number;
    reviewArtifactRef: string;
    decisionSemanticFingerprint: string;
    reviewArtifact: { sha256: string };
  };
  answerKey: {
    status: 'confirmed';
    answerKeyArtifact: { sha256: string };
  };
  grading: {
    status: 'completed';
    gradingVersion: number;
    assessmentArtifactRef: string;
    assessmentArtifact: { sha256: string };
  };
  knowledgeMapping?: FakeKnowledgeMappingState;
  observationProjection?: FakeObservationProjectionState;
}

class FaultByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  failPutSuffixOnce?: string;
  failPutAfterCommitSuffixOnce?: string;
  failReadBackSuffixOnce?: string;
  private armedReadBackFailure?: string;

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    const bytes = Buffer.from(body);
    this.calls.push(`put:${key}`);
    if (this.failPutSuffixOnce && key.endsWith(this.failPutSuffixOnce)) {
      this.failPutSuffixOnce = undefined;
      throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'closed write failure');
    }
    this.objects.set(key, bytes);
    if (this.failReadBackSuffixOnce && key.endsWith(this.failReadBackSuffixOnce)) {
      this.armedReadBackFailure = this.failReadBackSuffixOnce;
      this.failReadBackSuffixOnce = undefined;
    }
    if (this.failPutAfterCommitSuffixOnce && key.endsWith(this.failPutAfterCommitSuffixOnce)) {
      this.failPutAfterCommitSuffixOnce = undefined;
      throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'closed response loss');
    }
  }

  async get(key: string): Promise<Buffer> {
    this.calls.push(`get:${key}`);
    if (this.armedReadBackFailure && key.endsWith(this.armedReadBackFailure)) {
      this.armedReadBackFailure = undefined;
      throw new MaterialByteStoreError('MATERIAL_BYTE_READ_FAILED', 'closed read failure');
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'not found');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const REVIEW = {
  reviewVersion: 1,
  artifactVersion: 1,
  reviewRef: 'review-ref',
  reviewArtifactRef: 'review-artifact-ref',
  decisionSemanticFingerprint: REVIEW_SEMANTIC,
};
const ANSWER_KEY = { answerKeyRef: 'answer-key-ref' };
const ASSESSMENTS = {
  assessmentVersion: 1,
  artifactVersion: 1,
  assessmentRef: 'assessment-ref',
  semanticFingerprint: ASSESSMENT_SEMANTIC,
};
const REQUEST = {
  schemaVersion: 1,
  entries: [
    {
      confirmedQuestionId: 'confirmed-question-1',
      decision: 'mapped',
      knowledgePointIds: ['fractions'],
    },
    {
      confirmedQuestionId: 'confirmed-question-2',
      decision: 'unmapped',
      reason: 'unknown',
    },
  ],
};

function mappingArtifact(
  request = REQUEST,
  sourceAssessmentSemanticFingerprint = ASSESSMENT_SEMANTIC,
  sourceReviewSemanticFingerprint = REVIEW_SEMANTIC,
) {
  const changed =
    JSON.stringify(request).includes('linear-equations') ||
    sourceAssessmentSemanticFingerprint !== ASSESSMENT_SEMANTIC ||
    sourceReviewSemanticFingerprint !== REVIEW_SEMANTIC;
  const entries = structuredClone(request.entries).sort((left, right) =>
    left.confirmedQuestionId.localeCompare(right.confirmedQuestionId),
  );
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    mappingVersion: 1,
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    mappingRef: 'mapping-ref',
    semanticFingerprint: changed ? CHANGED_MAPPING_SEMANTIC : MAPPING_SEMANTIC,
    sourceReview: {
      reviewVersion: 1,
      reviewArtifactRef: 'review-artifact-ref',
      reviewArtifactSha256: REVIEW_SHA,
      decisionSemanticFingerprint: sourceReviewSemanticFingerprint,
    },
    sourceAssessments: {
      assessmentVersion: 1,
      assessmentArtifactSha256: ASSESSMENT_SHA,
      semanticFingerprint: sourceAssessmentSemanticFingerprint,
    },
    authoritySource: 'owner_confirmed_manual_mapping',
    entryCount: 2,
    mappedQuestionCount: 1,
    unmappedQuestionCount: 1,
    entries,
  };
}

function observationsArtifact(mapping = mappingArtifact(), observedAt = CREATED_AT) {
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    observationVersion: 1,
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    observedAt,
    observationRef: 'observation-ref',
    semanticFingerprint: OBSERVATION_SEMANTIC,
    sourceReview: mapping.sourceReview,
    sourceAssessments: mapping.sourceAssessments,
    sourceMapping: {
      mappingRef: mapping.mappingRef,
      mappingArtifactSha256: '',
      mappingVersion: 1,
      mappingArtifactVersion: 1,
      semanticFingerprint: mapping.semanticFingerprint,
      authoritySource: 'owner_confirmed_manual_mapping',
    },
    observationCount: 1,
    evaluatedCount: 1,
    correctCount: 0,
    incorrectCount: 1,
    unassessedCount: 0,
    observations: [
      {
        schemaVersion: 1,
        observationId: 'observation-1',
        profileId: PROFILE_ID,
        examSessionId: EXAM_SESSION_ID,
        confirmedQuestionId: 'confirmed-question-1',
        subjectId: SUBJECT_ID,
        knowledgePointIds: ['fractions'],
        occasionId: 'exam-occasion-1',
        observedAt: CREATED_AT,
        mappingSource: 'owner_confirmed_manual_mapping',
        assessmentStatus: 'evaluated',
        outcome: 'incorrect',
      },
    ],
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function state(): FakeState {
  return {
    status: 'ready_for_extraction',
    revision: 17,
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    createdAt: CREATED_AT,
    humanReview: {
      status: 'confirmed',
      reviewVersion: 1,
      reviewArtifactRef: 'review-artifact-ref',
      decisionSemanticFingerprint: REVIEW_SEMANTIC,
      reviewArtifact: { sha256: REVIEW_SHA },
    },
    answerKey: { status: 'confirmed', answerKeyArtifact: { sha256: '9'.repeat(64) } },
    grading: {
      status: 'completed',
      gradingVersion: 1,
      assessmentArtifactRef: 'assessment-artifact-ref',
      assessmentArtifact: { sha256: ASSESSMENT_SHA },
    },
  };
}

function copyPlan(event: object, keys: readonly string[]) {
  const record = event as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

const MAPPING_PLAN_KEYS = [
  'mappingVersion',
  'subjectId',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'assessmentVersion',
  'assessmentArtifactRef',
  'sourceAssessmentArtifactFingerprint',
  'sourceAssessmentSemanticFingerprint',
  'mappingSemanticFingerprint',
  'mappingRef',
  'mappingArtifactRef',
] as const;
const OBSERVATION_PLAN_KEYS = [
  'observationVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'assessmentVersion',
  'assessmentArtifactRef',
  'sourceAssessmentArtifactFingerprint',
  'sourceAssessmentSemanticFingerprint',
  'mappingVersion',
  'mappingRef',
  'mappingArtifactRef',
  'sourceMappingArtifactFingerprint',
  'sourceMappingSemanticFingerprint',
  'observationSemanticFingerprint',
  'observationRef',
  'observationArtifactRef',
] as const;

interface Harness {
  current: { state: FakeState };
  events: ExamEvent[];
  byteStore: FaultByteStore;
  deps: ExamServiceDeps;
  failAppendOnce?: string;
  failAppendAfterCommitOnce?: string;
  runtimeReplayOnce?: string;
}

function applyEvent(h: Harness, event: ExamEvent): void {
  h.events.push(event);
  h.current.state.revision += 1;
  if (event.eventType === 'exam_knowledge_mapping_started') {
    h.current.state.knowledgeMapping = {
      status: 'mapping',
      startedEventId: event.eventId,
      startedAt: event.createdAt,
      ...copyPlan(event, MAPPING_PLAN_KEYS),
    };
  } else if (event.eventType === 'exam_knowledge_mapping_confirmed') {
    h.current.state.knowledgeMapping!.status = 'confirmed';
    h.current.state.knowledgeMapping!.mappingArtifact = {
      byteLength: event.artifactByteLength,
      sha256: event.artifactSha256,
      entryCount: event.entryCount,
      mappedQuestionCount: event.mappedQuestionCount,
      unmappedQuestionCount: event.unmappedQuestionCount,
    };
  } else if (event.eventType === 'exam_observation_projection_started') {
    h.current.state.observationProjection = {
      status: 'projecting',
      startedEventId: event.eventId,
      startedAt: event.createdAt,
      ...copyPlan(event, OBSERVATION_PLAN_KEYS),
    };
  } else if (event.eventType === 'exam_observations_projected') {
    h.current.state.observationProjection!.status = 'completed';
    h.current.state.observationProjection!.observationArtifact = {
      byteLength: event.artifactByteLength,
      sha256: event.artifactSha256,
      observationCount: event.observationCount,
      evaluatedCount: event.evaluatedCount,
      correctCount: event.correctCount,
      incorrectCount: event.incorrectCount,
      unassessedCount: event.unassessedCount,
    };
  }
}

function harness(): Harness {
  let lockTail = Promise.resolve();
  const h: Harness = {
    current: { state: state() },
    events: [],
    byteStore: new FaultByteStore(),
    deps: undefined as unknown as ExamServiceDeps,
  };
  h.deps = {
    ownerId: 'anon:knowledge-service-test',
    store: {},
    byteStore: h.byteStore,
    now: () => '2026-09-01T08:05:00.000Z',
    withExamMutationLock: async (_examSessionId: string, operation: () => Promise<unknown>) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  } as unknown as ExamServiceDeps;
  runtimeMocks.loadExamRuntime.mockImplementation(async () => h.current);
  runtimeMocks.appendExamRuntimeEvent.mockImplementation(async (_deps, input) => {
    const event = input.event as ExamEvent;
    if (h.failAppendOnce === event.eventType) {
      h.failAppendOnce = undefined;
      throw new Error('closed append failure');
    }
    applyEvent(h, event);
    if (h.failAppendAfterCommitOnce === event.eventType) {
      h.failAppendAfterCommitOnce = undefined;
      throw new Error('closed committed append response loss');
    }
    const replayed = h.runtimeReplayOnce === event.eventType;
    if (replayed) h.runtimeReplayOnce = undefined;
    return { snapshot: h.current, replayed, eventAppended: !replayed };
  });
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
  sourceMocks.resolveReview.mockResolvedValue(REVIEW);
  sourceMocks.resolveAnswerKey.mockResolvedValue(ANSWER_KEY);
  sourceMocks.resolveAssessments.mockResolvedValue(ASSESSMENTS);
  privateMocks.parseRequest.mockImplementation((request) => structuredClone(request));
  privateMocks.buildMapping.mockImplementation((input) =>
    mappingArtifact(
      input.request,
      input.assessments.semanticFingerprint,
      input.confirmedReview.decisionSemanticFingerprint,
    ),
  );
  privateMocks.parseMapping.mockImplementation((value) =>
    JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value)),
  );
  privateMocks.serializeMapping.mockImplementation((value) => bytes(value));
  privateMocks.buildObservations.mockImplementation((input) => {
    const artifact = observationsArtifact(input.mapping, input.observedAt);
    artifact.sourceMapping.mappingArtifactSha256 = input.mappingArtifactSha256;
    return artifact;
  });
  privateMocks.parseObservations.mockImplementation((value) =>
    JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value)),
  );
  privateMocks.serializeObservations.mockImplementation((value) => bytes(value));
});

describe('Exam knowledge mapping service authority and persistence', () => {
  it('maps closed request validation failures before loading any Exam or source', async () => {
    const h = harness();
    privateMocks.parseRequest.mockImplementationOnce(() => {
      throw new ExamKnowledgeMappingPrivateError('EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID');
    });
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, {
        schemaVersion: 1,
        outcome: 'correct',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID' });
    expect(runtimeMocks.loadExamRuntime).not.toHaveBeenCalled();
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('uses the three authoritative FromRuntime sources and persists both artifacts event-first', async () => {
    const h = harness();
    h.byteStore.put = vi
      .fn(h.byteStore.put.bind(h.byteStore))
      .mockImplementation(async (key, body) => {
        expect(h.events.at(-1)?.eventType).toBe(
          key.includes('confirmed_exam_knowledge_mapping')
            ? 'exam_knowledge_mapping_started'
            : 'exam_observation_projection_started',
        );
        h.byteStore.objects.set(key, Buffer.from(body));
      });

    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).resolves.toEqual({
      examSessionId: EXAM_SESSION_ID,
      knowledgeMapping: {
        status: 'confirmed',
        mappedQuestionCount: 1,
        unmappedQuestionCount: 1,
      },
      observationProjection: { status: 'completed', observationCount: 1 },
      replayed: false,
    });
    expect(sourceMocks.resolveReview).toHaveBeenCalled();
    expect(sourceMocks.resolveAnswerKey).toHaveBeenCalledWith(h.deps, h.current, REVIEW);
    expect(sourceMocks.resolveAssessments).toHaveBeenCalledWith(h.deps, h.current, {
      confirmedReview: REVIEW,
      answerKey: ANSWER_KEY,
    });
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_mapping_started',
      'exam_knowledge_mapping_confirmed',
      'exam_observation_projection_started',
      'exam_observations_projected',
    ]);
    expect(JSON.stringify(h.events)).not.toMatch(
      /knowledgePointIds|outcome|questionText|rawAnswerText|correctAnswer|provider|llm/iu,
    );
  });

  it('fails before durable mapping facts when any authoritative source resolver fails', async () => {
    const failures = [
      [sourceMocks.resolveReview, 'EXAM_REVIEW_ARTIFACT_CORRUPT'],
      [sourceMocks.resolveAnswerKey, 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT'],
      [sourceMocks.resolveAssessments, 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT'],
    ] as const;

    for (const [resolver, code] of failures) {
      const h = harness();
      resolver.mockRejectedValueOnce(new ExamError(code));
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).rejects.toMatchObject({ code });
      expect(h.events).toEqual([]);
      expect(h.byteStore.objects.size).toBe(0);
    }
  });

  it('requires a ready, reviewed, and authoritatively graded Exam before parsing sources', async () => {
    const h = harness();
    h.current.state.grading.status = 'processing' as never;
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_NOT_READY' });
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.byteStore.calls).toEqual([]);
  });

  it('semantically replays the completed workflow and rejects a different immutable mapping', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).resolves.toMatchObject({ replayed: true });
    expect(h.events).toHaveLength(4);

    const changed = structuredClone(REQUEST);
    const mapped = changed.entries[0]!;
    if (mapped.decision !== 'mapped') throw new Error('fixture mismatch');
    mapped.knowledgePointIds = ['linear-equations'];
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, changed),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_CONFLICT' });
    expect(h.events).toHaveLength(4);
  });

  it('treats canonical input order as the same immutable mapping', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    const reordered = { ...REQUEST, entries: [...REQUEST.entries].reverse() };
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, reordered),
    ).resolves.toMatchObject({ replayed: true });
    expect(h.events).toHaveLength(4);
  });

  it.each([
    ['exam_knowledge_mapping_started', 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    ['exam_knowledge_mapping_confirmed', 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    ['exam_observation_projection_started', 'EXAM_OBSERVATION_PROJECTION_FAILED'],
    ['exam_observations_projected', 'EXAM_OBSERVATION_PROJECTION_FAILED'],
  ] as const)(
    'recovers deterministically after a one-shot %s append failure',
    async (event, code) => {
      const h = harness();
      h.failAppendOnce = event;
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).rejects.toMatchObject({ code });
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
      expect(new Set(h.events.map((item) => item.eventType)).size).toBe(4);
      expect(h.events).toHaveLength(4);
    },
  );

  it.each([
    ['exam_knowledge_mapping_started', 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    ['exam_knowledge_mapping_confirmed', 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    ['exam_observation_projection_started', 'EXAM_OBSERVATION_PROJECTION_FAILED'],
    ['exam_observations_projected', 'EXAM_OBSERVATION_PROJECTION_FAILED'],
  ] as const)(
    'recovers a committed %s response loss without duplicating logical events',
    async (eventType, code) => {
      const h = harness();
      h.failAppendAfterCommitOnce = eventType;
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).rejects.toMatchObject({ code });
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
      expect(h.events.filter((event) => event.eventType === eventType)).toHaveLength(1);
      expect(h.events).toHaveLength(4);
    },
  );

  it.each([
    'exam_knowledge_mapping_started',
    'exam_knowledge_mapping_confirmed',
    'exam_observation_projection_started',
    'exam_observations_projected',
  ] as const)('accepts Runtime CAS replay recovery for %s', async (eventType) => {
    const h = harness();
    h.runtimeReplayOnce = eventType;
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
    expect(h.events.filter((event) => event.eventType === eventType)).toHaveLength(1);
    expect(h.events).toHaveLength(4);
  });

  it.each([
    [MAPPING_SUFFIX, 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    [OBSERVATIONS_SUFFIX, 'EXAM_OBSERVATION_PROJECTION_FAILED'],
  ] as const)('recovers after a one-shot %s artifact put failure', async (suffix, code) => {
    const h = harness();
    h.byteStore.failPutSuffixOnce = suffix;
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code });
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
  });

  it.each([
    [MAPPING_SUFFIX, 'EXAM_KNOWLEDGE_MAPPING_FAILED'],
    [OBSERVATIONS_SUFFIX, 'EXAM_OBSERVATION_PROJECTION_FAILED'],
  ] as const)('recovers after a one-shot %s artifact read-back failure', async (suffix, code) => {
    const h = harness();
    h.byteStore.failReadBackSuffixOnce = suffix;
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code });
    expect(h.events.at(-1)?.eventType).toBe(
      suffix === MAPPING_SUFFIX
        ? 'exam_knowledge_mapping_started'
        : 'exam_observation_projection_started',
    );
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
    expect(h.events).toHaveLength(4);
  });

  it.each([MAPPING_SUFFIX, OBSERVATIONS_SUFFIX] as const)(
    'recovers committed artifact response loss for %s',
    async (suffix) => {
      const h = harness();
      h.byteStore.failPutAfterCommitSuffixOnce = suffix;
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).resolves.toMatchObject({ observationProjection: { status: 'completed' } });
      expect(h.events).toHaveLength(4);
    },
  );

  it('serializes concurrent semantic duplicates into one logical workflow', async () => {
    const h = harness();
    const results = await Promise.all([
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_mapping_started',
      'exam_knowledge_mapping_confirmed',
      'exam_observation_projection_started',
      'exam_observations_projected',
    ]);
    expect(h.byteStore.objects.size).toBe(2);
  });
});

describe('Exam knowledge private resolvers and deletion boundary', () => {
  it('rebuilds both source-bound artifacts before returning private facts', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    await expect(
      resolveConfirmedExamKnowledgeMapping(h.deps, EXAM_SESSION_ID),
    ).resolves.toMatchObject({
      authoritySource: 'owner_confirmed_manual_mapping',
    });
    await expect(resolveConfirmedExamObservations(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      observationCount: 1,
    });
    expect(privateMocks.buildMapping).toHaveBeenCalled();
    expect(privateMocks.buildObservations).toHaveBeenCalled();
  });

  it.each([
    ['mapping', MAPPING_SUFFIX, 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT'],
    ['observations', OBSERVATIONS_SUFFIX, 'EXAM_OBSERVATION_ARTIFACT_CORRUPT'],
  ] as const)('fails closed when persisted %s bytes are corrupt', async (kind, suffix, code) => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    const [key] = [...h.byteStore.objects.keys()].filter((candidate) => candidate.endsWith(suffix));
    if (!key) throw new Error(`missing ${kind} fixture object`);
    h.byteStore.objects.set(key, Buffer.from('corrupt'));
    const resolution =
      kind === 'mapping'
        ? resolveConfirmedExamKnowledgeMapping(h.deps, EXAM_SESSION_ID)
        : resolveConfirmedExamObservations(h.deps, EXAM_SESSION_ID);
    await expect(resolution).rejects.toMatchObject({ code });
  });

  it('rejects an observation whose durable runtime source binding changes', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    h.current.state.observationProjection!.sourceMappingSemanticFingerprint = '0'.repeat(64);
    await expect(resolveConfirmedExamObservations(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_OBSERVATION_SOURCE_CHANGED',
    });
  });

  it('rejects a mapping whose runtime assessment artifact ref no longer matches grading', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    h.current.state.knowledgeMapping!.assessmentArtifactRef = 'changed-assessment-artifact-ref';
    await expect(
      resolveConfirmedExamKnowledgeMapping(h.deps, EXAM_SESSION_ID),
    ).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT',
    });
  });

  it('reconstructs mapping semantics instead of trusting matching object/event digests alone', async () => {
    const h = harness();
    await confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST);
    const key = examKnowledgeMappingObjectKey(EXAM_SESSION_ID, 1);
    const tampered = JSON.parse(h.byteStore.objects.get(key)!.toString('utf8'));
    tampered.entries[0].knowledgePointIds = ['linear-equations'];
    const tamperedBytes = bytes(tampered);
    h.byteStore.objects.set(key, tamperedBytes);
    h.current.state.knowledgeMapping!.mappingArtifact!.byteLength = tamperedBytes.byteLength;
    h.current.state.knowledgeMapping!.mappingArtifact!.sha256 = digest(tamperedBytes);
    await expect(
      resolveConfirmedExamKnowledgeMapping(h.deps, EXAM_SESSION_ID),
    ).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT',
    });
  });

  it('rejects deterministic mapping-key conflicts without overwriting bytes', async () => {
    const h = harness();
    const mappingKey = examKnowledgeMappingObjectKey(EXAM_SESSION_ID, 1);
    const foreign = Buffer.from('foreign mapping bytes');
    h.byteStore.objects.set(mappingKey, foreign);
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_CONFLICT' });
    expect(h.byteStore.objects.get(mappingKey)).toEqual(foreign);
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_knowledge_mapping_started']);
  });

  it('rejects deterministic observation-key conflicts without overwriting bytes', async () => {
    const h = harness();
    h.failAppendOnce = 'exam_observation_projection_started';
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_OBSERVATION_PROJECTION_FAILED' });
    const observationKey = examObservationsObjectKey(EXAM_SESSION_ID, 1, 1);
    const foreign = Buffer.from('foreign observation bytes');
    h.byteStore.objects.set(observationKey, foreign);
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_OBSERVATION_SOURCE_CHANGED' });
    expect(h.byteStore.objects.get(observationKey)).toEqual(foreign);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_mapping_started',
      'exam_knowledge_mapping_confirmed',
      'exam_observation_projection_started',
    ]);
  });

  it('rejects source changes after the durable mapping plan and leaves that plan pending', async () => {
    const h = harness();
    h.byteStore.failPutSuffixOnce = MAPPING_SUFFIX;
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_FAILED' });
    sourceMocks.resolveAssessments.mockResolvedValue({
      ...ASSESSMENTS,
      semanticFingerprint: '0'.repeat(64),
    });
    await expect(
      confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
    ).rejects.toMatchObject({ code: 'EXAM_KNOWLEDGE_MAPPING_CONFLICT' });
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_knowledge_mapping_started']);
    expect(h.byteStore.objects.size).toBe(0);
  });

  it.each(['deleting', 'deleted'] as const)(
    'fails mapping while the Exam is %s and never resurrects state',
    async (status) => {
      const h = harness();
      h.current.state.status = status;
      await expect(
        confirmExamKnowledgeMappingAndProjectObservations(h.deps, EXAM_SESSION_ID, REQUEST),
      ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
      expect(h.events).toHaveLength(0);
      expect(h.byteStore.calls).toEqual([]);
      expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    },
  );

  it('contains no provider, model, OCR, question-text inference, or uploaded answer-key access path', () => {
    const source = readFileSync('lib/server/zhongkao/exam-knowledge-mapping-service.ts', 'utf8');
    expect(source).not.toMatch(/\b(?:AICallFn|provider|OpenAI|embedding|OCR|vision)\b/iu);
    expect(source).not.toMatch(
      /questionText[\s\S]*knowledgePointIds|outcome[\s\S]*knowledgePointIds/iu,
    );
    expect(source).not.toContain('examSnapshotObjectKey');
  });
});
