import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AICallFn } from '@openmaic/generation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialByteStoreError, type MaterialByteStore } from '@/lib/server/materials/bytes';
import { examKnowledgeSuggestionsObjectKey } from '@/lib/server/materials/object-keys';
import {
  buildExamKnowledgeCandidatePool,
  type ExamKnowledgeCandidatePoolV1,
} from '@/lib/server/zhongkao/exam-knowledge-candidate-pool';
import { ExamKnowledgeSuggestionsGeneratorError } from '@/lib/server/zhongkao/exam-knowledge-suggestions-generator';
import type {
  BuildExamKnowledgeSuggestionsArtifactInput,
  ExamKnowledgeSuggestionQuestionDraftV1,
  ExamKnowledgeSuggestionsArtifactV1,
  PublicExamKnowledgeSuggestionsBundleV1,
} from '@/lib/server/zhongkao/exam-knowledge-suggestions-private';
import {
  EXAM_KNOWLEDGE_SUGGESTIONS_MAX_OUTPUT_TOKENS,
  type ExamKnowledgeCandidatePoolResolver,
  type ExamKnowledgeSuggestionDraftGenerator,
  type ExamKnowledgeSuggestionsServiceDeps,
} from '@/lib/server/zhongkao/exam-knowledge-suggestions-service';
import type { ExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const OWNER_ID = 'anon:suggestion-service-test';
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const CREATED_AT = '2026-09-01T08:00:00.000Z';
const REVIEW_SHA = '1'.repeat(64);
const REVIEW_SEMANTIC = '2'.repeat(64);
const SUGGESTION_SUFFIX = 'exam_knowledge_suggestions_v1.json';

const runtimeMocks = vi.hoisted(() => ({
  loadExamRuntime: vi.fn(),
  appendExamRuntimeEvent: vi.fn(),
}));

const sourceMocks = vi.hoisted(() => ({
  resolveReview: vi.fn(),
}));

const privateMocks = vi.hoisted(() => ({
  buildArtifact: vi.fn(),
  parseArtifact: vi.fn(),
  serializeArtifact: vi.fn(),
  toPublicBundle: vi.fn(),
}));

const progressMocks = vi.hoisted(() => ({
  collectEvidence: vi.fn(),
}));

const defaultDepsMocks = vi.hoisted(() => ({
  defaultExamServiceDeps: vi.fn(),
}));

const generationCallMocks = vi.hoisted(() => ({
  createGenerationAiCallFactory: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/generation-ai-call', () => ({
  createGenerationAiCallFactory: generationCallMocks.createGenerationAiCallFactory,
}));

vi.mock('@/lib/server/zhongkao/exam-service', () => ({
  defaultExamServiceDeps: defaultDepsMocks.defaultExamServiceDeps,
}));

vi.mock('@/lib/server/zhongkao/exam-runtime', () => ({
  loadExamRuntime: runtimeMocks.loadExamRuntime,
  appendExamRuntimeEvent: runtimeMocks.appendExamRuntimeEvent,
  createExamOperationFingerprint: () => '8'.repeat(64),
  deriveExamEventId: (operationId: string) => `event:${operationId}`,
  deriveExamKnowledgeSuggestionsGenerationRef: () => 'generation-ref',
  deriveExamKnowledgeSuggestionsArtifactRef: () => 'suggestion-artifact-ref',
  deriveExamKnowledgeSuggestionsStartedOperationId: () => 'suggestions-started-op',
  deriveExamKnowledgeSuggestionsCompletedOperationId: () => 'suggestions-completed-op',
}));

vi.mock('@/lib/server/zhongkao/exam-human-review-service', () => ({
  resolveConfirmedExamReviewFactsFromRuntime: sourceMocks.resolveReview,
}));

vi.mock('@/lib/server/zhongkao/progress-evidence-service', () => ({
  collectKnowledgeProgressEvidence: progressMocks.collectEvidence,
}));

vi.mock('@/lib/server/zhongkao/exam-knowledge-suggestions-private', () => ({
  EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION: 1,
  ExamKnowledgeSuggestionsPrivateError: class ExamKnowledgeSuggestionsPrivateError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  buildExamKnowledgeSuggestionsArtifact: privateMocks.buildArtifact,
  parseExamKnowledgeSuggestionsArtifact: privateMocks.parseArtifact,
  serializeExamKnowledgeSuggestionsArtifact: privateMocks.serializeArtifact,
  toPublicExamKnowledgeSuggestionsBundle: privateMocks.toPublicBundle,
}));

import {
  defaultExamKnowledgeSuggestionsServiceDeps,
  generateExamKnowledgeSuggestions,
  getExamKnowledgeSuggestions,
} from '@/lib/server/zhongkao/exam-knowledge-suggestions-service';

type DraftGeneratorInput = Parameters<ExamKnowledgeSuggestionDraftGenerator>[1];

interface FakeKnowledgeSuggestionsState extends Record<string, unknown> {
  status: 'generating' | 'completed' | 'superseded';
  generationVersion: number;
  subjectId: string;
  generatorVersion: string;
  candidateSchemaVersion: number;
  reviewVersion: number;
  reviewArtifactRef: string;
  sourceReviewArtifactFingerprint: string;
  sourceReviewSemanticFingerprint: string;
  candidatePoolMode: 'observed_existing_ids' | 'label_only';
  candidatePoolFingerprint: string;
  generationRef: string;
  suggestionArtifactRef: string;
  suggestionArtifact?: {
    byteLength: number;
    sha256: string;
    questionCount: number;
    generatedQuestionCount: number;
    noSuggestionQuestionCount: number;
    inputTooLargeQuestionCount: number;
    suggestionCount: number;
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
    status: 'confirmed' | 'reviewing';
    reviewVersion: number;
    reviewArtifactRef: string;
    decisionSemanticFingerprint: string;
    reviewArtifact?: { sha256: string };
  };
  knowledgeSuggestions?: FakeKnowledgeSuggestionsState;
  knowledgeMapping?: { status: 'mapping' | 'confirmed' };
  answerKeyCanary: string;
  progressCanary: string;
}

const REVIEW = {
  schemaVersion: 1,
  artifactVersion: 1,
  reviewVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  reviewRef: 'review-ref',
  reviewArtifactRef: 'review-artifact-ref',
  questionArtifactRef: 'question-artifact-ref',
  questionArtifactSha256: '3'.repeat(64),
  questionExtractionVersion: 1,
  questionSegmentationVersion: 1,
  responseArtifactRef: 'response-artifact-ref',
  responseArtifactSha256: '4'.repeat(64),
  responseCaptureVersion: 1,
  matchingArtifactRef: 'matching-artifact-ref',
  matchingArtifactSha256: '5'.repeat(64),
  matchingVersion: 1,
  decisionSemanticFingerprint: REVIEW_SEMANTIC,
  decisions: [],
  confirmedQuestionCount: 2,
  confirmedResponseCount: 1,
  confirmedMatchCount: 1,
  rejectedQuestionCount: 0,
  rejectedResponseCount: 0,
  confirmedQuestions: [
    {
      confirmedQuestionId: 'confirmed-question-1',
      sourceQuestionCandidateId: 'source-question-1',
      rawLabel: '1.',
      locator: { printedNumber: '1', subquestionPath: [] },
      questionText: 'Solve x + 2 = 5.',
      textSource: 'extracted_confirmed',
      locatorSource: 'extracted_confirmed',
      sourceSpans: [],
      responseCanary: 'PRIVATE_RESPONSE_CANARY',
      correctnessCanary: 'PRIVATE_CORRECTNESS_CANARY',
    },
    {
      confirmedQuestionId: 'confirmed-question-2',
      sourceQuestionCandidateId: 'source-question-2',
      rawLabel: '(1)',
      locator: { printedNumber: '17', subquestionPath: ['1'] },
      questionText: 'Find the triangle area.',
      textSource: 'owner_corrected',
      locatorSource: 'extracted_confirmed',
      sourceSpans: [],
      parentSourceCandidateId: 'source-question-group-17',
      parentContext: {
        sourceQuestionCandidateId: 'source-question-group-17',
        rawLabel: '17.',
        locator: { printedNumber: '17', subquestionPath: [] },
        questionText: 'A triangle has base 4 and height 3.',
        contextSource: 'extracted_confirmed',
        sourceSpans: [],
        answerKeyCanary: 'PRIVATE_ANSWER_KEY_CANARY',
      },
    },
  ],
  confirmedResponses: [
    {
      confirmedResponseId: 'confirmed-response-1',
      confirmedQuestionId: 'confirmed-question-1',
      answerStatus: 'text',
      rawAnswerText: 'PRIVATE_RESPONSE_CANARY',
      answerSource: 'captured_confirmed',
    },
  ],
  confirmedMatches: [
    {
      confirmedMatchId: 'confirmed-match-1',
      confirmedQuestionId: 'confirmed-question-1',
      confirmedResponseId: 'confirmed-response-1',
      relationSource: 'owner_manual_link',
    },
  ],
  rejectedQuestionCandidates: [],
  rejectedResponseCandidates: [],
  ownerCanary: 'PRIVATE_OWNER_CANARY',
  profileCanary: 'PRIVATE_PROFILE_CANARY',
  examCanary: 'PRIVATE_EXAM_CANARY',
} as unknown as ConfirmedExamReviewFactsV1;

const POOL = buildExamKnowledgeCandidatePool({
  subjectId: SUBJECT_ID,
  knowledgePointIds: ['linear-equations'],
});

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function defaultDrafts(input: DraftGeneratorInput): ExamKnowledgeSuggestionQuestionDraftV1[] {
  return input.questions.map((question, index) => ({
    confirmedQuestionId: question.confirmedQuestionId,
    questionText: question.questionText,
    ...(question.parentContext
      ? { parentContext: { questionText: question.parentContext.questionText } }
      : {}),
    generationStatus: 'generated',
    suggestions:
      index === 0
        ? [
            {
              kind: 'existing_knowledge_point',
              knowledgePointId: 'linear-equations',
              confidenceBand: 'high',
              evidencePhrases: ['x + 2 = 5'],
            },
          ]
        : [
            {
              kind: 'proposed_label',
              proposedLabel: 'triangle area',
              confidenceBand: 'medium',
              evidencePhrases: ['triangle area'],
            },
          ],
  }));
}

function fakeArtifact(
  input: BuildExamKnowledgeSuggestionsArtifactInput,
): ExamKnowledgeSuggestionsArtifactV1 {
  const sourceQuestions = new Map(
    input.confirmedReview.confirmedQuestions.map((question) => [
      question.confirmedQuestionId,
      question,
    ]),
  );
  for (const draft of input.questionDrafts) {
    const sourceQuestion = sourceQuestions.get(draft.confirmedQuestionId);
    const sourceTexts = [
      sourceQuestion?.questionText,
      sourceQuestion?.parentContext?.questionText,
    ].filter((text): text is string => typeof text === 'string');
    if (
      !sourceQuestion ||
      draft.questionText !== sourceQuestion.questionText ||
      draft.parentContext?.questionText !== sourceQuestion.parentContext?.questionText ||
      Boolean(draft.parentContext) !== Boolean(sourceQuestion.parentContext) ||
      draft.suggestions.some((suggestion) =>
        suggestion.evidencePhrases.some(
          (phrase) => !sourceTexts.some((sourceText) => sourceText.includes(phrase)),
        ),
      )
    ) {
      throw new Error('source-bound draft mismatch');
    }
  }
  const questions = input.questionDrafts.map((question, questionIndex) => ({
    confirmedQuestionId: question.confirmedQuestionId,
    generationStatus: question.generationStatus,
    suggestions: question.suggestions.map((suggestion, suggestionIndex) => ({
      candidateId: `candidate-${questionIndex}-${suggestionIndex}`,
      ordinal: suggestionIndex,
      ...structuredClone(suggestion),
    })),
  }));
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    generationVersion: 1,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    generationRef: input.generationRef ?? 'generation-ref',
    suggestionArtifactRef: input.suggestionArtifactRef ?? 'suggestion-artifact-ref',
    generationSource: 'model_candidate',
    candidateStatus: 'candidate',
    sourceReview: {
      reviewRef: input.confirmedReview.reviewRef,
      reviewArtifactRef: input.confirmedReview.reviewArtifactRef,
      reviewArtifactSha256: input.confirmedReviewArtifactSha256,
      reviewVersion: input.confirmedReview.reviewVersion,
      reviewArtifactVersion: input.confirmedReview.artifactVersion,
      decisionSemanticFingerprint: input.confirmedReview.decisionSemanticFingerprint,
    },
    pool: structuredClone(input.pool),
    generator: { ...input.generator },
    semanticFingerprint: '6'.repeat(64),
    questionCount: questions.length,
    generatedQuestionCount: questions.filter(
      (question) => question.generationStatus === 'generated',
    ).length,
    noSuggestionQuestionCount: questions.filter(
      (question) => question.generationStatus === 'no_suggestion',
    ).length,
    inputTooLargeQuestionCount: questions.filter(
      (question) => question.generationStatus === 'input_too_large',
    ).length,
    suggestionCount: questions.reduce((count, question) => count + question.suggestions.length, 0),
    questions,
  } as ExamKnowledgeSuggestionsArtifactV1;
}

function parseArtifact(value: unknown): ExamKnowledgeSuggestionsArtifactV1 {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  return JSON.parse(text) as ExamKnowledgeSuggestionsArtifactV1;
}

function toPublicBundle(
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  confirmedReview: ConfirmedExamReviewFactsV1,
): PublicExamKnowledgeSuggestionsBundleV1 {
  const sourceQuestions = new Map(
    confirmedReview.confirmedQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  return {
    schemaVersion: 1,
    examSessionId: artifact.examSessionId,
    subjectId: artifact.subjectId,
    candidateStatus: 'candidate',
    questions: artifact.questions.map((question) => {
      const sourceQuestion = sourceQuestions.get(question.confirmedQuestionId);
      if (!sourceQuestion) throw new Error('missing source question');
      return {
        confirmedQuestionId: question.confirmedQuestionId,
        questionText: sourceQuestion.questionText,
        ...(sourceQuestion.parentContext
          ? { parentContext: { questionText: sourceQuestion.parentContext.questionText } }
          : {}),
        generationStatus: question.generationStatus,
        suggestions: question.suggestions.map((suggestion) => {
          const publicSuggestion = structuredClone(suggestion) as Record<string, unknown>;
          delete publicSuggestion.ordinal;
          return publicSuggestion;
        }),
      };
    }),
  } as PublicExamKnowledgeSuggestionsBundleV1;
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
    answerKeyCanary: 'PRIVATE_ANSWER_KEY_CANARY',
    progressCanary: 'PRIVATE_PROGRESS_CANARY',
  };
}

const PLAN_KEYS = [
  'generationVersion',
  'subjectId',
  'generatorVersion',
  'candidateSchemaVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'candidatePoolMode',
  'candidatePoolFingerprint',
  'generationRef',
  'suggestionArtifactRef',
] as const;

function copyPlan(event: object): Record<string, unknown> {
  const record = event as Record<string, unknown>;
  return Object.fromEntries(PLAN_KEYS.map((key) => [key, record[key]]));
}

class FaultByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  failPutSuffixOnce?: string;
  failPutAfterCommitSuffixOnce?: string;
  failReadBackSuffixOnce?: string;
  onPut?: (key: string) => void;
  private armedReadBackFailure?: string;

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.calls.push(`put:${key}`);
    this.onPut?.(key);
    if (this.failPutSuffixOnce && key.endsWith(this.failPutSuffixOnce)) {
      this.failPutSuffixOnce = undefined;
      throw new MaterialByteStoreError('MATERIAL_BYTE_WRITE_FAILED', 'closed write failure');
    }
    this.objects.set(key, Buffer.from(body));
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
    const value = this.objects.get(key);
    if (!value) throw new MaterialByteStoreError('ENOENT', 'not found');
    return Buffer.from(value);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

interface Harness {
  current: { state: FakeState };
  events: ExamEvent[];
  byteStore: FaultByteStore;
  deps: ExamKnowledgeSuggestionsServiceDeps;
  pool: ExamKnowledgeCandidatePoolV1;
  resolvePool: ReturnType<typeof vi.fn<ExamKnowledgeCandidatePoolResolver>>;
  generateDrafts: ReturnType<typeof vi.fn<ExamKnowledgeSuggestionDraftGenerator>>;
  aiCall: AICallFn;
  lockDepth: number;
  poolLockDepths: number[];
  modelLockDepths: number[];
  failAppendBeforeCommitOnce?: ExamEvent['eventType'];
  failAppendAfterCommitOnce?: ExamEvent['eventType'];
}

function applyEvent(h: Harness, event: ExamEvent): void {
  h.events.push(event);
  h.current.state.revision += 1;
  if (event.eventType === 'exam_knowledge_suggestions_started') {
    h.current.state.knowledgeSuggestions = {
      status: 'generating',
      startedEventId: event.eventId,
      startedAt: event.createdAt,
      ...copyPlan(event),
    } as unknown as FakeKnowledgeSuggestionsState;
  } else if (event.eventType === 'exam_knowledge_suggestions_completed') {
    const suggestions = h.current.state.knowledgeSuggestions;
    if (!suggestions) throw new Error('missing suggestion plan fixture');
    suggestions.status = 'completed';
    suggestions.suggestionArtifact = {
      byteLength: event.artifactByteLength,
      sha256: event.artifactSha256,
      questionCount: event.questionCount,
      generatedQuestionCount: event.generatedQuestionCount,
      noSuggestionQuestionCount: event.noSuggestionQuestionCount,
      inputTooLargeQuestionCount: event.inputTooLargeQuestionCount,
      suggestionCount: event.suggestionCount,
    };
  }
}

function harness(): Harness {
  let lockTail = Promise.resolve();
  const h = {
    current: { state: state() },
    events: [],
    byteStore: new FaultByteStore(),
    deps: undefined as unknown as ExamKnowledgeSuggestionsServiceDeps,
    pool: structuredClone(POOL),
    resolvePool: undefined,
    generateDrafts: undefined,
    aiCall: vi.fn(async () => 'unused') as unknown as AICallFn,
    lockDepth: 0,
    poolLockDepths: [],
    modelLockDepths: [],
  } as unknown as Harness;

  const resolvePool: ExamKnowledgeCandidatePoolResolver = async () => {
    h.poolLockDepths.push(h.lockDepth);
    return structuredClone(h.pool);
  };
  const generateDrafts: ExamKnowledgeSuggestionDraftGenerator = async (_call, input) => {
    h.modelLockDepths.push(h.lockDepth);
    return defaultDrafts(input);
  };
  h.resolvePool = vi.fn(resolvePool);
  h.generateDrafts = vi.fn(generateDrafts);
  h.deps = {
    ownerId: OWNER_ID,
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
      h.lockDepth += 1;
      try {
        return await operation();
      } finally {
        h.lockDepth -= 1;
        release();
      }
    },
    knowledgeSuggestionAiCall: h.aiCall,
    resolveKnowledgeCandidatePool: h.resolvePool,
    generateKnowledgeSuggestionDrafts: h.generateDrafts,
  } as unknown as ExamKnowledgeSuggestionsServiceDeps;

  runtimeMocks.loadExamRuntime.mockImplementation(
    async (deps: ExamServiceDeps, examSessionId: string) => {
      if (deps.ownerId !== OWNER_ID || examSessionId !== EXAM_SESSION_ID) {
        throw new ExamError('EXAM_NOT_FOUND');
      }
      return h.current;
    },
  );
  runtimeMocks.appendExamRuntimeEvent.mockImplementation(
    async (deps: ExamServiceDeps, input: { event: ExamEvent; expectedRevision: number }) => {
      if (deps.ownerId !== OWNER_ID || input.event.examSessionId !== EXAM_SESSION_ID) {
        throw new ExamError('EXAM_NOT_FOUND');
      }
      if (input.expectedRevision !== h.current.state.revision) {
        throw new ExamError('EXAM_EVENT_CONFLICT');
      }
      if (h.failAppendBeforeCommitOnce === input.event.eventType) {
        h.failAppendBeforeCommitOnce = undefined;
        throw new Error('closed append failure');
      }
      applyEvent(h, input.event);
      if (h.failAppendAfterCommitOnce === input.event.eventType) {
        h.failAppendAfterCommitOnce = undefined;
        throw new Error('closed committed append response loss');
      }
      return { snapshot: h.current, replayed: false, eventAppended: true };
    },
  );
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultDepsMocks.defaultExamServiceDeps.mockReset();
  generationCallMocks.createGenerationAiCallFactory.mockReset();
  sourceMocks.resolveReview.mockResolvedValue(REVIEW);
  privateMocks.buildArtifact.mockImplementation(fakeArtifact);
  privateMocks.parseArtifact.mockImplementation(parseArtifact);
  privateMocks.serializeArtifact.mockImplementation((artifact) => bytes(artifact));
  privateMocks.toPublicBundle.mockImplementation(toPublicBundle);
});

describe('Exam knowledge suggestion service generation boundary', () => {
  it('requires a confirmed review before resolving sources, pools, or model drafts', async () => {
    const h = harness();
    h.current.state.humanReview.status = 'reviewing';
    delete h.current.state.humanReview.reviewArtifact;

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY',
    });
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.resolvePool).not.toHaveBeenCalled();
    expect(h.generateDrafts).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('fails closed for a different owner without revealing the Exam', async () => {
    const h = harness();
    const foreignDeps = { ...h.deps, ownerId: 'anon:foreign-owner' };

    await expect(
      generateExamKnowledgeSuggestions(foreignDeps, EXAM_SESSION_ID),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.resolvePool).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it.each([
    ['mapping', 'EXAM_KNOWLEDGE_SUGGESTION_CONFLICT'],
    ['confirmed', 'EXAM_KNOWLEDGE_SUGGESTIONS_ALREADY_CONFIRMED'],
  ] as const)('rejects an Exam whose knowledge map is already %s', async (status, code) => {
    const h = harness();
    h.current.state.knowledgeMapping = { status };

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code,
    });
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.resolvePool).not.toHaveBeenCalled();
    expect(h.generateDrafts).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('writes the started event before model generation and sends only minimal review text', async () => {
    const h = harness();
    const abortController = new AbortController();
    h.deps.abortSignal = abortController.signal;
    h.byteStore.onPut = () => {
      expect(h.events.map((event) => event.eventType)).toEqual([
        'exam_knowledge_suggestions_started',
      ]);
      expect(h.lockDepth).toBe(1);
    };
    h.generateDrafts.mockImplementationOnce(async (call, input, signal) => {
      expect(call).toBe(h.aiCall);
      expect(signal).toBe(abortController.signal);
      expect(h.lockDepth).toBe(0);
      expect(h.events.map((event) => event.eventType)).toEqual([
        'exam_knowledge_suggestions_started',
      ]);
      return defaultDrafts(input);
    });

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      examSessionId: EXAM_SESSION_ID,
      knowledgeSuggestions: {
        schemaVersion: 1,
        examSessionId: EXAM_SESSION_ID,
        subjectId: SUBJECT_ID,
        candidateStatus: 'candidate',
      },
      replayed: false,
    });

    const input = h.generateDrafts.mock.calls[0]?.[1];
    expect(input).toEqual({
      questions: [
        {
          subjectId: SUBJECT_ID,
          confirmedQuestionId: 'confirmed-question-1',
          questionText: 'Solve x + 2 = 5.',
        },
        {
          subjectId: SUBJECT_ID,
          confirmedQuestionId: 'confirmed-question-2',
          questionText: 'Find the triangle area.',
          parentContext: { questionText: 'A triangle has base 4 and height 3.' },
        },
      ],
      existingKnowledgePointIds: ['linear-equations'],
    });
    expect(Object.keys(input ?? {}).sort()).toEqual(['existingKnowledgePointIds', 'questions']);
    expect(input?.questions.map((question) => Object.keys(question).sort())).toEqual([
      ['confirmedQuestionId', 'questionText', 'subjectId'],
      ['confirmedQuestionId', 'parentContext', 'questionText', 'subjectId'],
    ]);
    expect(Object.keys(input?.questions[1]?.parentContext ?? {})).toEqual(['questionText']);
    const serializedInput = JSON.stringify(input);
    expect(serializedInput).not.toContain(EXAM_SESSION_ID);
    expect(serializedInput).not.toContain(PROFILE_ID);
    expect(serializedInput).not.toContain(OWNER_ID);
    expect(serializedInput).not.toMatch(
      /PRIVATE_(?:RESPONSE|CORRECTNESS|ANSWER_KEY|PROGRESS|OWNER|PROFILE|EXAM)_CANARY/u,
    );
    expect(h.poolLockDepths).toEqual([0]);
    expect(h.modelLockDepths).toEqual([]);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
    expect(h.byteStore.calls.some((call) => call.startsWith('put:'))).toBe(true);
  });

  it.each([
    ['provider_unavailable', 'EXAM_KNOWLEDGE_SUGGESTION_PROVIDER_UNAVAILABLE'],
    ['invalid_output', 'EXAM_KNOWLEDGE_SUGGESTION_INVALID'],
  ] as const)('maps %s generator failures to the closed service error', async (reason, code) => {
    const h = harness();
    h.generateDrafts.mockRejectedValueOnce(new ExamKnowledgeSuggestionsGeneratorError(reason));

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code,
    });
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);
    expect(h.byteStore.objects.size).toBe(0);
  });

  it('keeps the started reservation and remains retryable after generation is aborted', async () => {
    const h = harness();
    const abortedRequest = new AbortController();
    h.deps.abortSignal = abortedRequest.signal;
    h.generateDrafts.mockImplementationOnce(async (_call, input, signal) => {
      expect(signal).toBe(abortedRequest.signal);
      abortedRequest.abort();
      signal?.throwIfAborted();
      return defaultDrafts(input);
    });

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    expect(abortedRequest.signal.aborted).toBe(true);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);
    expect(h.byteStore.objects.size).toBe(0);

    const retryRequest = new AbortController();
    h.deps.abortSignal = retryRequest.signal;
    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(2);
    expect(h.generateDrafts.mock.calls[1]?.[2]).toBe(retryRequest.signal);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('keeps manual mapping authoritative after a provider failure', async () => {
    const h = harness();
    h.generateDrafts.mockRejectedValueOnce(
      new ExamKnowledgeSuggestionsGeneratorError('provider_unavailable'),
    );
    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_PROVIDER_UNAVAILABLE',
    });

    const suggestions = h.current.state.knowledgeSuggestions;
    if (!suggestions) throw new Error('missing suggestion plan fixture');
    suggestions.status = 'superseded';
    h.current.state.knowledgeMapping = { status: 'mapping' };

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_CONFLICT',
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.byteStore.objects.size).toBe(0);
  });

  it('retries after a put-before-commit failure without inventing a second started event', async () => {
    const h = harness();
    h.byteStore.failPutSuffixOnce = SUGGESTION_SUFFIX;

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(2);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('recovers a persisted artifact after read-back failure without a second model call', async () => {
    const h = harness();
    h.byteStore.failReadBackSuffixOnce = SUGGESTION_SUFFIX;

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    expect(h.byteStore.objects.size).toBe(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: true,
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.resolvePool).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('recovers committed artifact put response loss in the original request', async () => {
    const h = harness();
    h.byteStore.failPutAfterCommitSuffixOnce = SUGGESTION_SUFFIX;

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.byteStore.objects.size).toBe(1);
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('retries after a started-event append failure without running the model early', async () => {
    const h = harness();
    h.failAppendBeforeCommitOnce = 'exam_knowledge_suggestions_started';

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    expect(h.events).toEqual([]);
    expect(h.generateDrafts).not.toHaveBeenCalled();
    expect(h.byteStore.objects.size).toBe(0);

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('keeps the artifact durable when completed append fails, then finalizes on replay', async () => {
    const h = harness();
    h.failAppendBeforeCommitOnce = 'exam_knowledge_suggestions_completed';

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    const key = examKnowledgeSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    expect(h.byteStore.objects.get(key)).toBeInstanceOf(Buffer);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: true,
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it.each(['exam_knowledge_suggestions_started', 'exam_knowledge_suggestions_completed'] as const)(
    'recovers committed %s response loss without duplicate work',
    async (eventType) => {
      const h = harness();
      h.failAppendAfterCommitOnce = eventType;

      await expect(
        generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID),
      ).resolves.toMatchObject({
        replayed: false,
      });
      await expect(
        generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID),
      ).resolves.toMatchObject({
        replayed: true,
      });
      expect(h.generateDrafts).toHaveBeenCalledTimes(1);
      expect(h.events.filter((event) => event.eventType === eventType)).toHaveLength(1);
      expect(h.events).toHaveLength(2);
    },
  );

  it('shares one owner-and-Exam flight across concurrent identical requests', async () => {
    const h = harness();
    const results = await Promise.all([
      generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID),
      generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(h.resolvePool).toHaveBeenCalledTimes(1);
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
      'exam_knowledge_suggestions_completed',
    ]);
  });

  it('does not persist or finalize if deletion begins during the model call', async () => {
    const h = harness();
    let releaseModel!: () => void;
    let markModelCalled!: () => void;
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    h.generateDrafts.mockImplementationOnce(async (_call, input) => {
      markModelCalled();
      await modelGate;
      return defaultDrafts(input);
    });

    const pending = generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    await modelCalled;
    expect(h.lockDepth).toBe(0);
    h.current.state.status = 'deleting';
    releaseModel();

    await expect(pending).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);
  });

  it('does not persist or finalize if manual mapping becomes authoritative during generation', async () => {
    const h = harness();
    let releaseModel!: () => void;
    let markModelCalled!: () => void;
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    h.generateDrafts.mockImplementationOnce(async (_call, input) => {
      markModelCalled();
      await modelGate;
      return defaultDrafts(input);
    });

    const pending = generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    await modelCalled;
    h.current.state.knowledgeMapping = { status: 'mapping' };
    releaseModel();

    await expect(pending).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_CONFLICT',
    });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_knowledge_suggestions_started',
    ]);
  });

  it('rejects a candidate-pool change after reservation without regenerating', async () => {
    const h = harness();
    h.byteStore.failPutSuffixOnce = SUGGESTION_SUFFIX;
    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    h.pool = buildExamKnowledgeCandidatePool({
      subjectId: SUBJECT_ID,
      knowledgePointIds: ['fractions'],
    });

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED',
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
  });

  it('rejects a review-source change after reservation without persisting stale output', async () => {
    const h = harness();
    let releaseModel!: () => void;
    let markModelCalled!: () => void;
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    h.generateDrafts.mockImplementationOnce(async (_call, input) => {
      markModelCalled();
      await modelGate;
      return defaultDrafts(input);
    });

    const pending = generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    await modelCalled;
    h.current.state.humanReview.reviewArtifact = { sha256: '0'.repeat(64) };
    releaseModel();

    await expect(pending).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED',
    });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events).toHaveLength(1);
  });

  it('rejects a valid candidate pool bound to a different subject before reservation', async () => {
    const h = harness();
    h.pool = buildExamKnowledgeCandidatePool({
      subjectId: 'science',
      knowledgePointIds: ['forces'],
    });

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
    });
    expect(h.events).toEqual([]);
    expect(h.generateDrafts).not.toHaveBeenCalled();
  });
});

describe('default Exam knowledge suggestion service dependencies', () => {
  it('binds the suggestion stage to a fixed provider output-token cap', async () => {
    const abortController = new AbortController();
    const aiCall = vi.fn();
    const bindStage = vi.fn().mockReturnValue(aiCall);
    const baseDeps = { ownerId: OWNER_ID, marker: 'base-exam-service-deps' };
    defaultDepsMocks.defaultExamServiceDeps.mockResolvedValueOnce(baseDeps);
    generationCallMocks.createGenerationAiCallFactory.mockReturnValueOnce(bindStage);

    const result = await defaultExamKnowledgeSuggestionsServiceDeps(
      OWNER_ID,
      abortController.signal,
    );

    expect(defaultDepsMocks.defaultExamServiceDeps).toHaveBeenCalledExactlyOnceWith(OWNER_ID);
    expect(generationCallMocks.createGenerationAiCallFactory).toHaveBeenCalledExactlyOnceWith({
      abortSignal: abortController.signal,
      maxOutputTokens: EXAM_KNOWLEDGE_SUGGESTIONS_MAX_OUTPUT_TOKENS,
    });
    expect(bindStage).toHaveBeenCalledExactlyOnceWith('exam-knowledge-suggestions');
    expect(result).toMatchObject(baseDeps);
    expect(result.knowledgeSuggestionAiCall).toBe(aiCall);
    expect(result.abortSignal).toBe(abortController.signal);
  });
});

describe('Exam knowledge suggestion artifact resolution', () => {
  it('returns the completed public bundle and keeps private artifact fields private', async () => {
    const h = harness();
    const generated = await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    const persisted = parseArtifact(
      h.byteStore.objects.get(examKnowledgeSuggestionsObjectKey(EXAM_SESSION_ID, 1))!,
    );

    await expect(getExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toEqual(
      generated.knowledgeSuggestions,
    );
    expect(persisted.questions.map((question) => Object.keys(question).sort())).toEqual(
      persisted.questions.map(() => ['confirmedQuestionId', 'generationStatus', 'suggestions']),
    );
    expect(generated.knowledgeSuggestions.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confirmedQuestionId: 'confirmed-question-1',
          questionText: 'Solve x + 2 = 5.',
        }),
        expect.objectContaining({
          confirmedQuestionId: 'confirmed-question-2',
          questionText: 'Find the triangle area.',
          parentContext: { questionText: 'A triangle has base 4 and height 3.' },
        }),
      ]),
    );
    expect(privateMocks.toPublicBundle).toHaveBeenLastCalledWith(expect.any(Object), REVIEW);
    const publicJson = JSON.stringify(generated.knowledgeSuggestions);
    expect(publicJson).not.toContain(PROFILE_ID);
    expect(publicJson).not.toMatch(
      /semanticFingerprint|sourceReview|pool|generator|generationRef|suggestionArtifactRef|ordinal/u,
    );
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
  });

  it('fails GET closed when review question identity or evidence source drifts', async () => {
    for (const drift of ['question-id', 'evidence-source'] as const) {
      sourceMocks.resolveReview.mockResolvedValue(REVIEW);
      const h = harness();
      await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
      const changedReview = structuredClone(REVIEW);
      if (drift === 'question-id') {
        changedReview.confirmedQuestions[0]!.confirmedQuestionId = 'changed-question-id';
      } else {
        changedReview.confirmedQuestions[0]!.questionText =
          'Changed source without prior evidence.';
      }
      sourceMocks.resolveReview.mockResolvedValue(changedReview);

      await expect(getExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
        code: 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED',
      });
    }
  });

  it('rejects GET before completion and for a different owner', async () => {
    const h = harness();
    await expect(getExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY',
    });

    await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    const foreignDeps = { ...h.deps, ownerId: 'anon:foreign-owner' };
    await expect(getExamKnowledgeSuggestions(foreignDeps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_NOT_FOUND',
    });
  });

  it('fails closed for corrupt persisted bytes on GET and POST replay', async () => {
    const h = harness();
    await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    const key = examKnowledgeSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    h.byteStore.objects.set(key, Buffer.from('corrupt'));

    await expect(getExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT',
    });
    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT',
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
  });

  it('does not bypass lifecycle or mapping gates when a completed artifact exists', async () => {
    const h = harness();
    await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    h.current.state.knowledgeMapping = { status: 'confirmed' };

    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_KNOWLEDGE_SUGGESTIONS_ALREADY_CONFIRMED',
    });
    h.current.state.knowledgeMapping = undefined;
    h.current.state.status = 'deleted';
    await expect(generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_NOT_FOUND',
    });
    expect(h.generateDrafts).toHaveBeenCalledTimes(1);
  });

  it('uses no mapping, observation-projection, or progress-derivation authority', async () => {
    const h = harness();
    await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);

    expect(progressMocks.collectEvidence).not.toHaveBeenCalled();
    const source = readFileSync(
      'lib/server/zhongkao/exam-knowledge-suggestions-service.ts',
      'utf8',
    );
    expect(source).not.toMatch(
      /from ['"`]\.\/exam-knowledge-mapping-service|from ['"`]\.\/progress-evidence-service|deriveKnowledgeProgress/u,
    );
    expect(JSON.stringify(h.events)).not.toMatch(
      /questionText|rawAnswerText|correctness|answerKey|progressCanary|knowledgePointIds/u,
    );
  });

  it('binds completed artifact facts to the exact persisted bytes', async () => {
    const h = harness();
    await generateExamKnowledgeSuggestions(h.deps, EXAM_SESSION_ID);
    const key = examKnowledgeSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    const stored = h.byteStore.objects.get(key);
    const completed = h.events.find(
      (event) => event.eventType === 'exam_knowledge_suggestions_completed',
    );

    expect(stored).toBeDefined();
    expect(completed).toMatchObject({
      artifactByteLength: stored?.byteLength,
      artifactSha256: stored ? digest(stored) : undefined,
      questionCount: 2,
      generatedQuestionCount: 2,
      noSuggestionQuestionCount: 0,
      inputTooLargeQuestionCount: 0,
      suggestionCount: 2,
    });
  });
});
