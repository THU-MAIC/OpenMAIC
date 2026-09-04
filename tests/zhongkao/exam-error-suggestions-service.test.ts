import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AICallFn } from '@openmaic/generation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialByteStoreError, type MaterialByteStore } from '@/lib/server/materials/bytes';
import { examErrorSuggestionsObjectKey } from '@/lib/server/materials/object-keys';
import { ExamErrorObservableDetectorError } from '@/lib/server/zhongkao/exam-error-observable-detector';
import { ExamErrorSuggestionsGeneratorError } from '@/lib/server/zhongkao/exam-error-suggestions-generator';
import type {
  BuildExamErrorSuggestionsArtifactInput,
  ExamErrorDiagnosisCandidatesArtifactV1,
} from '@/lib/server/zhongkao/exam-error-suggestions-private';
import {
  EXAM_ERROR_SUGGESTIONS_MAX_OUTPUT_TOKENS,
  type ExamErrorSuggestionModelGenerator,
  type ExamErrorSuggestionsServiceDeps,
  type ExamObservableErrorDetector,
} from '@/lib/server/zhongkao/exam-error-suggestions-service';
import type { ExamServiceDeps } from '@/lib/server/zhongkao/exam-service';
import type {
  ExamErrorSuggestionQuestionDraftV1,
  PublicExamErrorSuggestionsBundleV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import { ExamError } from '@/lib/zhongkao/exam-errors';
import type { ExamEvent } from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';

const EXAM_SESSION_ID = `exam:v1:${'a'.repeat(64)}`;
const OWNER_ID = 'anon:error-suggestion-service-test';
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const CREATED_AT = '2026-09-01T08:00:00.000Z';
const REVIEW_SHA = '1'.repeat(64);
const REVIEW_SEMANTIC = '2'.repeat(64);
const ANSWER_KEY_SHA = '3'.repeat(64);
const ANSWER_KEY_SEMANTIC = '4'.repeat(64);
const ASSESSMENT_SHA = '5'.repeat(64);
const ASSESSMENT_SEMANTIC = '6'.repeat(64);
const ARTIFACT_SUFFIX = 'exam_error_diagnosis_candidates_v1.json';

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

const aiCallBindingMocks = vi.hoisted(() => ({
  createExamErrorSuggestionAiCall: vi.fn(),
}));

vi.mock('@/lib/server/zhongkao/exam-error-suggestions-ai-call', () => ({
  createExamErrorSuggestionAiCall: aiCallBindingMocks.createExamErrorSuggestionAiCall,
}));

vi.mock('@/lib/server/zhongkao/exam-service', () => ({
  defaultExamServiceDeps: defaultDepsMocks.defaultExamServiceDeps,
}));

vi.mock('@/lib/server/zhongkao/exam-runtime', () => ({
  loadExamRuntime: runtimeMocks.loadExamRuntime,
  appendExamRuntimeEvent: runtimeMocks.appendExamRuntimeEvent,
  createExamOperationFingerprint: () => '7'.repeat(64),
  deriveExamEventId: (operationId: string) => `event:${operationId}`,
  deriveExamErrorSuggestionsGenerationRef: () => 'error-generation-ref',
  deriveExamErrorSuggestionsArtifactRef: () => 'error-artifact-ref',
  deriveExamErrorSuggestionsStartedOperationId: () => 'error-suggestions-started-op',
  deriveExamErrorSuggestionsCompletedOperationId: () => 'error-suggestions-completed-op',
}));

vi.mock('@/lib/server/zhongkao/exam-human-review-service', () => ({
  resolveConfirmedExamReviewFactsFromRuntime: sourceMocks.resolveReview,
}));

vi.mock('@/lib/server/zhongkao/exam-grading-service', () => ({
  resolveAuthoritativeExamAnswerKeyFromRuntime: sourceMocks.resolveAnswerKey,
  resolveExamQuestionAssessmentsFromRuntime: sourceMocks.resolveAssessments,
}));

vi.mock('@/lib/server/zhongkao/progress-evidence-service', () => ({
  collectKnowledgeProgressEvidence: progressMocks.collectEvidence,
}));

vi.mock('@/lib/server/zhongkao/exam-error-suggestions-private', () => ({
  EXAM_ERROR_SUGGESTION_GENERATION_VERSION: 1,
  EXAM_ERROR_SUGGESTION_MODEL_STAGE: 'exam-error-suggestions',
  ExamErrorSuggestionsPrivateError: class ExamErrorSuggestionsPrivateError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  buildExamErrorSuggestionsArtifact: privateMocks.buildArtifact,
  parseExamErrorSuggestionsArtifact: privateMocks.parseArtifact,
  serializeExamErrorSuggestionsArtifact: privateMocks.serializeArtifact,
  toPublicExamErrorSuggestionsBundle: privateMocks.toPublicBundle,
}));

import {
  defaultExamErrorSuggestionsServiceDeps,
  generateExamErrorSuggestions,
  getExamErrorSuggestions,
} from '@/lib/server/zhongkao/exam-error-suggestions-service';

interface FakeErrorSuggestionsState extends Record<string, unknown> {
  status: 'generating' | 'completed';
  generationVersion: number;
  suggestionArtifact?: {
    byteLength: number;
    sha256: string;
    eligibleQuestionCount: number;
    candidateQuestionCount: number;
    noSuggestionQuestionCount: number;
    inputTooLargeQuestionCount: number;
    suggestionCount: number;
    deterministicSuggestionCount: number;
    modelSuggestionCount: number;
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
  answerKey: {
    status: 'confirmed' | 'confirming';
    answerKeyVersion: number;
    answerKeyRef: string;
    answerKeyArtifactRef: string;
    answerKeySemanticFingerprint: string;
    answerKeyArtifact?: { sha256: string };
  };
  grading: {
    status: 'completed' | 'grading';
    gradingVersion: number;
    gradingAlgorithmVersion: 'exam-objective-grading:v1';
    gradingRef: string;
    assessmentArtifactRef: string;
    assessmentArtifact?: {
      sha256: string;
      incorrectCount: number;
    };
  };
  errorSuggestions?: FakeErrorSuggestionsState;
  observationCanary: string;
  progressCanary: string;
  studyAttemptCanary: string;
  coachCanary: string;
}

const REVIEW = {
  schemaVersion: 1,
  artifactVersion: 1,
  reviewVersion: 1,
  examSessionId: EXAM_SESSION_ID,
  reviewRef: 'review-ref',
  reviewArtifactRef: 'review-artifact-ref',
  decisionSemanticFingerprint: REVIEW_SEMANTIC,
  confirmedQuestionCount: 4,
  confirmedResponseCount: 4,
  confirmedMatchCount: 4,
  rejectedQuestionCount: 0,
  rejectedResponseCount: 0,
  confirmedQuestions: [
    {
      confirmedQuestionId: 'question-choice-incorrect',
      questionText: 'Choose the value of x.',
    },
    {
      confirmedQuestionId: 'question-numeric-incorrect',
      questionText: 'Give the final length in metres.',
      parentContext: { questionText: 'Use SI units for the final result.' },
    },
    {
      confirmedQuestionId: 'question-correct',
      questionText: 'Choose the correct identity.',
    },
    {
      confirmedQuestionId: 'question-unassessed',
      questionText: 'Explain your proof.',
    },
  ],
  confirmedResponses: [
    {
      confirmedResponseId: 'response-choice-incorrect',
      confirmedQuestionId: 'question-choice-incorrect',
      answerStatus: 'text',
      rawAnswerText: 'C',
    },
    {
      confirmedResponseId: 'response-numeric-incorrect',
      confirmedQuestionId: 'question-numeric-incorrect',
      answerStatus: 'text',
      rawAnswerText: '5 cm',
    },
    {
      confirmedResponseId: 'response-correct',
      confirmedQuestionId: 'question-correct',
      answerStatus: 'text',
      rawAnswerText: 'B',
    },
    {
      confirmedResponseId: 'response-unassessed',
      confirmedQuestionId: 'question-unassessed',
      answerStatus: 'text',
      rawAnswerText: 'PRIVATE_UNASSESSED_RESPONSE_CANARY',
    },
  ],
  confirmedMatches: [],
  decisions: [],
  rejectedQuestionCandidates: [],
  rejectedResponseCandidates: [],
  ownerCanary: 'PRIVATE_OWNER_CANARY',
  profileCanary: 'PRIVATE_PROFILE_CANARY',
  progressCanary: 'PRIVATE_PROGRESS_CANARY',
} as unknown as ConfirmedExamReviewFactsV1;

const ANSWER_KEY = {
  schemaVersion: 1,
  artifactVersion: 1,
  answerKeyVersion: 1,
  gradingAlgorithmVersion: 'exam-objective-grading:v1',
  examSessionId: EXAM_SESSION_ID,
  subjectId: SUBJECT_ID,
  answerKeyRef: 'answer-key-ref',
  semanticFingerprint: ANSWER_KEY_SEMANTIC,
  privateExpectedAnswerCanary: 'PRIVATE_EXPECTED_ANSWER_CANARY',
  entries: [],
};

const ASSESSMENTS = {
  schemaVersion: 1,
  artifactVersion: 1,
  assessmentVersion: 1,
  gradingAlgorithmVersion: 'exam-objective-grading:v1',
  examSessionId: EXAM_SESSION_ID,
  assessmentRef: 'grading-ref',
  answerKeyRef: 'answer-key-ref',
  answerKeySemanticFingerprint: ANSWER_KEY_SEMANTIC,
  answerKeyArtifactSha256: ANSWER_KEY_SHA,
  semanticFingerprint: ASSESSMENT_SEMANTIC,
  assessmentCount: 4,
  evaluatedCount: 3,
  correctCount: 1,
  incorrectCount: 2,
  unassessedCount: 1,
  assessments: [
    {
      assessmentId: 'assessment-choice-incorrect',
      confirmedQuestionId: 'question-choice-incorrect',
      status: 'evaluated',
      outcome: 'incorrect',
      gradingType: 'single_choice',
    },
    {
      assessmentId: 'assessment-numeric-incorrect',
      confirmedQuestionId: 'question-numeric-incorrect',
      status: 'evaluated',
      outcome: 'incorrect',
      gradingType: 'numeric',
    },
    {
      assessmentId: 'assessment-correct',
      confirmedQuestionId: 'question-correct',
      status: 'evaluated',
      outcome: 'correct',
      gradingType: 'single_choice',
    },
    {
      assessmentId: 'assessment-unassessed',
      confirmedQuestionId: 'question-unassessed',
      status: 'unassessed',
      reason: 'unsupported_question_type',
    },
  ],
};

function deterministicDrafts(): ExamErrorSuggestionQuestionDraftV1[] {
  return [
    {
      confirmedQuestionId: 'question-choice-incorrect',
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [
        {
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
    {
      confirmedQuestionId: 'question-numeric-incorrect',
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [
        {
          kind: 'response_format_mismatch_candidate',
          generationSource: 'deterministic_candidate',
          candidateStatus: 'candidate',
          confidenceBand: 'high',
          evidence: [
            {
              evidenceType: 'format_observation',
              gradingType: 'numeric',
              parseStatus: 'invalid',
            },
          ],
        },
      ],
    },
  ];
}

function modelDrafts(): ExamErrorSuggestionQuestionDraftV1[] {
  return [
    {
      confirmedQuestionId: 'question-numeric-incorrect',
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [
        {
          kind: 'unit_error_candidate',
          generationSource: 'model_candidate',
          candidateStatus: 'candidate',
          confidenceBand: 'medium',
          evidence: [
            { evidenceType: 'text_span', source: 'question', text: 'metres' },
            { evidenceType: 'text_span', source: 'response', text: 'cm' },
          ],
        },
      ],
    },
  ];
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function fakeArtifact(
  input: BuildExamErrorSuggestionsArtifactInput,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  const assessmentById = new Map(
    input.assessments.assessments.map((assessment) => [assessment.confirmedQuestionId, assessment]),
  );
  const eligibleIds = input.assessments.assessments
    .filter((assessment) => assessment.status === 'evaluated' && assessment.outcome === 'incorrect')
    .map((assessment) => assessment.confirmedQuestionId)
    .sort();
  const draftIds = input.questionDrafts.map((draft) => draft.confirmedQuestionId).sort();
  if (JSON.stringify(eligibleIds) !== JSON.stringify(draftIds)) {
    throw new Error('eligible source mismatch');
  }
  const questions = input.questionDrafts.map((question, questionIndex) => {
    const assessment = assessmentById.get(question.confirmedQuestionId)!;
    return {
      confirmedQuestionId: question.confirmedQuestionId,
      assessmentId: assessment.assessmentId,
      assessmentOutcome: 'incorrect' as const,
      generationStatus: question.generationStatus,
      suggestions: question.suggestions.map((suggestion, suggestionIndex) => ({
        candidateId: `candidate-${questionIndex}-${suggestionIndex}`,
        ordinal: suggestionIndex,
        ...structuredClone(suggestion),
      })),
    };
  });
  const suggestions = questions.flatMap((question) => question.suggestions);
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    generationVersion: 1,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    generationRef: input.generationRef ?? 'error-generation-ref',
    suggestionArtifactRef: input.suggestionArtifactRef ?? 'error-artifact-ref',
    candidateStatus: 'candidate',
    sourceReview: {
      reviewRef: input.confirmedReview.reviewRef,
      reviewArtifactRef: input.confirmedReview.reviewArtifactRef,
      reviewArtifactSha256: input.confirmedReviewArtifactSha256,
      reviewVersion: input.confirmedReview.reviewVersion,
      reviewArtifactVersion: input.confirmedReview.artifactVersion,
      decisionSemanticFingerprint: input.confirmedReview.decisionSemanticFingerprint,
    },
    sourceAnswerKey: {
      answerKeyVersion: input.answerKey.answerKeyVersion,
      answerKeyRef: input.answerKey.answerKeyRef,
      answerKeyArtifactRef: input.answerKeyArtifactRef,
      answerKeyArtifactSha256: input.answerKeyArtifactSha256,
      semanticFingerprint: input.answerKey.semanticFingerprint,
    },
    sourceAssessment: {
      assessmentVersion: input.assessments.assessmentVersion,
      gradingAlgorithmVersion: input.assessments.gradingAlgorithmVersion,
      gradingRef: input.assessments.assessmentRef,
      assessmentArtifactRef: input.assessmentArtifactRef,
      assessmentArtifactSha256: input.assessmentArtifactSha256,
      semanticFingerprint: input.assessments.semanticFingerprint,
    },
    generator: { ...input.generator },
    modelExecution: { ...input.modelExecution },
    semanticFingerprint: '8'.repeat(64),
    eligibleQuestionCount: questions.length,
    candidateQuestionCount: questions.filter(
      (question) => question.generationStatus === 'generated',
    ).length,
    noSuggestionQuestionCount: questions.filter(
      (question) => question.generationStatus === 'no_suggestion',
    ).length,
    inputTooLargeQuestionCount: questions.filter(
      (question) => question.generationStatus === 'input_too_large',
    ).length,
    suggestionCount: suggestions.length,
    deterministicSuggestionCount: suggestions.filter(
      (suggestion) => suggestion.generationSource === 'deterministic_candidate',
    ).length,
    modelSuggestionCount: suggestions.filter(
      (suggestion) => suggestion.generationSource === 'model_candidate',
    ).length,
    questions,
  };
}

function parseArtifact(value: unknown): ExamErrorDiagnosisCandidatesArtifactV1 {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  return JSON.parse(text) as ExamErrorDiagnosisCandidatesArtifactV1;
}

function toPublicBundle(
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  review: ConfirmedExamReviewFactsV1,
): PublicExamErrorSuggestionsBundleV1 {
  const questions = new Map(
    review.confirmedQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  const responses = new Map(
    review.confirmedResponses.map((response) => [response.confirmedQuestionId, response]),
  );
  return {
    schemaVersion: 1,
    examSessionId: artifact.examSessionId,
    subjectId: artifact.subjectId,
    candidateStatus: 'candidate',
    questions: artifact.questions.map((item) => {
      const question = questions.get(item.confirmedQuestionId)!;
      const response = responses.get(item.confirmedQuestionId);
      if (!response || (response.answerStatus === 'text' && !response.rawAnswerText)) {
        throw new Error('missing confirmed response');
      }
      const confirmedResponse =
        response.answerStatus === 'text'
          ? { answerStatus: 'text' as const, rawAnswerText: response.rawAnswerText! }
          : { answerStatus: response.answerStatus };
      return {
        confirmedQuestionId: item.confirmedQuestionId,
        questionText: question.questionText,
        ...(question.parentContext
          ? { parentContext: { questionText: question.parentContext.questionText } }
          : {}),
        confirmedResponse,
        assessmentOutcome: 'incorrect',
        generationStatus: item.generationStatus,
        suggestions: item.suggestions.map(({ ordinal: _ordinal, ...suggestion }) => ({
          ...structuredClone(suggestion),
        })),
      };
    }),
  };
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
    answerKey: {
      status: 'confirmed',
      answerKeyVersion: 1,
      answerKeyRef: 'answer-key-ref',
      answerKeyArtifactRef: 'answer-key-artifact-ref',
      answerKeySemanticFingerprint: ANSWER_KEY_SEMANTIC,
      answerKeyArtifact: { sha256: ANSWER_KEY_SHA },
    },
    grading: {
      status: 'completed',
      gradingVersion: 1,
      gradingAlgorithmVersion: 'exam-objective-grading:v1',
      gradingRef: 'grading-ref',
      assessmentArtifactRef: 'assessment-artifact-ref',
      assessmentArtifact: { sha256: ASSESSMENT_SHA, incorrectCount: 2 },
    },
    observationCanary: 'UNCHANGED_OBSERVATION',
    progressCanary: 'UNCHANGED_PROGRESS',
    studyAttemptCanary: 'UNCHANGED_STUDY_ATTEMPT',
    coachCanary: 'UNCHANGED_COACH',
  };
}

const PLAN_KEYS = [
  'generationVersion',
  'subjectId',
  'generatorVersion',
  'detectorVersion',
  'modelPolicyVersion',
  'candidateSchemaVersion',
  'reviewVersion',
  'reviewArtifactRef',
  'sourceReviewArtifactFingerprint',
  'sourceReviewSemanticFingerprint',
  'answerKeyVersion',
  'answerKeyRef',
  'answerKeyArtifactRef',
  'sourceAnswerKeyArtifactFingerprint',
  'sourceAnswerKeySemanticFingerprint',
  'assessmentVersion',
  'gradingAlgorithmVersion',
  'gradingRef',
  'assessmentArtifactRef',
  'sourceAssessmentArtifactFingerprint',
  'sourceAssessmentSemanticFingerprint',
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
  deps: ExamErrorSuggestionsServiceDeps;
  detect: ReturnType<typeof vi.fn<ExamObservableErrorDetector>>;
  generateModel: ReturnType<typeof vi.fn<ExamErrorSuggestionModelGenerator>>;
  aiCall: AICallFn;
  lockDepth: number;
  detectorLockDepths: number[];
  modelLockDepths: number[];
  failAppendBeforeCommitOnce?: ExamEvent['eventType'];
  failAppendAfterCommitOnce?: ExamEvent['eventType'];
}

function applyEvent(h: Harness, event: ExamEvent): void {
  h.events.push(event);
  h.current.state.revision += 1;
  if (event.eventType === 'exam_error_suggestions_started') {
    h.current.state.errorSuggestions = {
      status: 'generating',
      ...copyPlan(event),
    } as unknown as FakeErrorSuggestionsState;
  } else if (event.eventType === 'exam_error_suggestions_completed') {
    const suggestions = h.current.state.errorSuggestions;
    if (!suggestions) throw new Error('missing error suggestion plan fixture');
    suggestions.status = 'completed';
    suggestions.suggestionArtifact = {
      byteLength: event.artifactByteLength,
      sha256: event.artifactSha256,
      eligibleQuestionCount: event.eligibleQuestionCount,
      candidateQuestionCount: event.candidateQuestionCount,
      noSuggestionQuestionCount: event.noSuggestionQuestionCount,
      inputTooLargeQuestionCount: event.inputTooLargeQuestionCount,
      suggestionCount: event.suggestionCount,
      deterministicSuggestionCount: event.deterministicSuggestionCount,
      modelSuggestionCount: event.modelSuggestionCount,
    };
  }
}

function harness(): Harness {
  let lockTail = Promise.resolve();
  const h = {
    current: { state: state() },
    events: [],
    byteStore: new FaultByteStore(),
    deps: undefined as unknown as ExamErrorSuggestionsServiceDeps,
    detect: undefined,
    generateModel: undefined,
    aiCall: vi.fn(async () => 'unused') as unknown as AICallFn,
    lockDepth: 0,
    detectorLockDepths: [],
    modelLockDepths: [],
  } as unknown as Harness;

  const detect: ExamObservableErrorDetector = () => {
    h.detectorLockDepths.push(h.lockDepth);
    return deterministicDrafts();
  };
  const generateModel: ExamErrorSuggestionModelGenerator = async (_call, _input) => {
    h.modelLockDepths.push(h.lockDepth);
    return modelDrafts();
  };
  h.detect = vi.fn(detect);
  h.generateModel = vi.fn(generateModel);
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
    errorSuggestionAiCall: h.aiCall,
    getErrorSuggestionModelExecution: () =>
      h.generateModel.mock.calls.length > 0
        ? {
            status: 'used',
            stage: 'exam-error-suggestions',
            providerId: 'fixture-provider',
            modelId: 'fixture-model',
          }
        : undefined,
    detectObservableErrorSuggestions: h.detect,
    generateModelErrorSuggestionDrafts: h.generateModel,
  } as unknown as ExamErrorSuggestionsServiceDeps;

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
  aiCallBindingMocks.createExamErrorSuggestionAiCall.mockReset();
  sourceMocks.resolveReview.mockResolvedValue(REVIEW);
  sourceMocks.resolveAnswerKey.mockResolvedValue(ANSWER_KEY);
  sourceMocks.resolveAssessments.mockResolvedValue(ASSESSMENTS);
  privateMocks.buildArtifact.mockImplementation(fakeArtifact);
  privateMocks.parseArtifact.mockImplementation(parseArtifact);
  privateMocks.serializeArtifact.mockImplementation((artifact) => bytes(artifact));
  privateMocks.toPublicBundle.mockImplementation(toPublicBundle);
});

describe('Exam error suggestion service generation boundary', () => {
  it.each(['review', 'answer-key', 'grading'] as const)(
    'requires completed %s authority before resolving source artifacts',
    async (missing) => {
      const h = harness();
      if (missing === 'review') {
        h.current.state.humanReview.status = 'reviewing';
        delete h.current.state.humanReview.reviewArtifact;
      } else if (missing === 'answer-key') {
        h.current.state.answerKey.status = 'confirming';
        delete h.current.state.answerKey.answerKeyArtifact;
      } else {
        h.current.state.grading.status = 'grading';
        delete h.current.state.grading.assessmentArtifact;
      }

      await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
        code: 'EXAM_ERROR_SUGGESTIONS_NOT_READY',
      });
      expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
      expect(h.detect).not.toHaveBeenCalled();
      expect(h.generateModel).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );

  it.each([
    ['confirmed-review', 'resolveReview'],
    ['authoritative-answer-key/grading-spec', 'resolveAnswerKey'],
    ['question-assessments', 'resolveAssessments'],
  ] as const)('fails closed when the %s resolver throws', async (_source, resolver) => {
    const h = harness();
    const before = {
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    };
    sourceMocks[resolver].mockRejectedValueOnce(new Error('PRIVATE_SOURCE_RESOLVER_CANARY'));

    let caught: unknown;
    try {
      await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExamError',
      code: 'EXAM_ERROR_SUGGESTION_FAILED',
    });
    expect(String(caught)).not.toContain('PRIVATE_SOURCE_RESOLVER_CANARY');
    expect(h.events).toEqual([]);
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.generateModel).not.toHaveBeenCalled();
    expect({
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    }).toEqual(before);
  });

  it('fails closed for another owner without revealing source readiness', async () => {
    const h = harness();
    await expect(
      generateExamErrorSuggestions({ ...h.deps, ownerId: 'anon:foreign-owner' }, EXAM_SESSION_ID),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(sourceMocks.resolveReview).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('persists the started event before detector/model work and runs long work outside the lock', async () => {
    const h = harness();
    const abortController = new AbortController();
    h.deps.abortSignal = abortController.signal;
    h.detect.mockImplementationOnce((input) => {
      expect(h.lockDepth).toBe(0);
      expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
      expect(input).toEqual({
        confirmedReview: REVIEW,
        answerKey: ANSWER_KEY,
        assessments: ASSESSMENTS,
      });
      return deterministicDrafts();
    });
    h.generateModel.mockImplementationOnce(async (call, input, signal) => {
      expect(call).toBe(h.aiCall);
      expect(signal).toBe(abortController.signal);
      expect(h.lockDepth).toBe(0);
      expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
      expect(input).toEqual({
        questions: [
          {
            subjectId: SUBJECT_ID,
            confirmedQuestionId: 'question-numeric-incorrect',
            questionText: 'Give the final length in metres.',
            parentContext: { questionText: 'Use SI units for the final result.' },
            responseText: '5 cm',
            gradingType: 'numeric',
            mismatchFact: {
              evidenceType: 'format_observation',
              gradingType: 'numeric',
              parseStatus: 'invalid',
            },
          },
        ],
      });
      return modelDrafts();
    });
    h.byteStore.onPut = () => {
      expect(h.lockDepth).toBe(1);
      expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
    };

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      examSessionId: EXAM_SESSION_ID,
      replayed: false,
      errorSuggestions: {
        candidateStatus: 'candidate',
        questions: expect.any(Array),
      },
    });
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_error_suggestions_started',
      'exam_error_suggestions_completed',
    ]);
    expect(h.detectorLockDepths).toEqual([]);
    expect(h.modelLockDepths).toEqual([]);
  });

  it('excludes correct and unassessed questions and exactly merges deterministic/model candidates', async () => {
    const h = harness();
    const result = await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);

    expect(
      result.errorSuggestions.questions.map((question) => question.confirmedQuestionId),
    ).toEqual(['question-choice-incorrect', 'question-numeric-incorrect']);
    expect(JSON.stringify(result.errorSuggestions)).not.toMatch(
      /question-correct|question-unassessed|PRIVATE_UNASSESSED_RESPONSE_CANARY/u,
    );
    expect(result.errorSuggestions.questions[0]?.suggestions).toEqual([
      expect.objectContaining({
        kind: 'single_choice_option_mismatch_candidate',
        generationSource: 'deterministic_candidate',
      }),
    ]);
    expect(result.errorSuggestions.questions[1]?.suggestions).toEqual([
      expect.objectContaining({
        kind: 'response_format_mismatch_candidate',
        generationSource: 'deterministic_candidate',
      }),
      expect.objectContaining({
        kind: 'unit_error_candidate',
        generationSource: 'model_candidate',
      }),
    ]);
    expect(h.events.at(-1)).toMatchObject({
      eventType: 'exam_error_suggestions_completed',
      eligibleQuestionCount: 2,
      candidateQuestionCount: 2,
      noSuggestionQuestionCount: 0,
      inputTooLargeQuestionCount: 0,
      suggestionCount: 3,
      deterministicSuggestionCount: 2,
      modelSuggestionCount: 1,
    });
    expect(privateMocks.buildArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        modelExecution: {
          status: 'used',
          stage: 'exam-error-suggestions',
          providerId: 'fixture-provider',
          modelId: 'fixture-model',
        },
      }),
    );
  });

  it('records not_used and makes no provider call when no question enters the model path', async () => {
    const h = harness();
    h.detect.mockReturnValueOnce(
      deterministicDrafts().map((draft) =>
        draft.confirmedQuestionId === 'question-numeric-incorrect'
          ? {
              ...draft,
              suggestions: [
                {
                  kind: 'numeric_value_mismatch_candidate',
                  generationSource: 'deterministic_candidate',
                  candidateStatus: 'candidate',
                  confidenceBand: 'high',
                  evidence: [
                    { evidenceType: 'numeric_difference', differenceKind: 'different_value' },
                  ],
                },
              ],
            }
          : draft,
      ),
    );

    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);

    expect(h.generateModel).not.toHaveBeenCalled();
    expect(h.aiCall).not.toHaveBeenCalled();
    expect(privateMocks.buildArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        modelExecution: { status: 'not_used', stage: 'exam-error-suggestions' },
      }),
    );
  });

  it.each([
    ['provider_unavailable', 'EXAM_ERROR_SUGGESTION_PROVIDER_UNAVAILABLE'],
    ['invalid_output', 'EXAM_ERROR_SUGGESTION_INVALID'],
  ] as const)('maps %s model failures to a stable code', async (reason, code) => {
    const h = harness();
    h.generateModel.mockRejectedValueOnce(new ExamErrorSuggestionsGeneratorError(reason));

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code,
    });
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
    expect(h.byteStore.objects.size).toBe(0);
  });

  it('fails a model timeout abort closed after the durable started reservation', async () => {
    const h = harness();
    const timeoutController = new AbortController();
    const timeout = new Error('PRIVATE_MODEL_TIMEOUT_CANARY');
    timeout.name = 'TimeoutError';
    h.deps.abortSignal = timeoutController.signal;
    const before = {
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    };
    h.generateModel.mockImplementationOnce(async (_call, _input, signal) => {
      expect(signal).toBe(timeoutController.signal);
      timeoutController.abort(timeout);
      throw signal?.reason;
    });

    let caught: unknown;
    try {
      await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExamError',
      code: 'EXAM_ERROR_SUGGESTION_FAILED',
    });
    expect(String(caught)).not.toContain('PRIVATE_MODEL_TIMEOUT_CANARY');
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
    expect(h.byteStore.objects.size).toBe(0);
    expect(privateMocks.buildArtifact).not.toHaveBeenCalled();
    expect({
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    }).toEqual(before);
  });

  it('fails closed when the deterministic detector rejects bound source facts', async () => {
    const h = harness();
    h.detect.mockImplementationOnce(() => {
      throw new ExamErrorObservableDetectorError();
    });

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_SOURCE_CHANGED',
    });
    expect(h.generateModel).not.toHaveBeenCalled();
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
  });

  it('does not run detector/provider before a durable started reservation', async () => {
    const h = harness();
    h.failAppendBeforeCommitOnce = 'exam_error_suggestions_started';

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_FAILED',
    });
    expect(h.events).toEqual([]);
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.generateModel).not.toHaveBeenCalled();
    expect(h.byteStore.objects.size).toBe(0);

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.detect).toHaveBeenCalledTimes(1);
  });

  it('retries a pre-commit byte failure without duplicating the started event', async () => {
    const h = harness();
    h.byteStore.failPutSuffixOnce = ARTIFACT_SUFFIX;

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_FAILED',
    });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_error_suggestions_started',
      'exam_error_suggestions_completed',
    ]);
  });

  it('recovers bytes persisted before read-back or completed-event failure without a second model call', async () => {
    for (const failure of ['read-back', 'completed-event'] as const) {
      const h = harness();
      if (failure === 'read-back') h.byteStore.failReadBackSuffixOnce = ARTIFACT_SUFFIX;
      else h.failAppendBeforeCommitOnce = 'exam_error_suggestions_completed';

      await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
        code: 'EXAM_ERROR_SUGGESTION_FAILED',
      });
      expect(h.byteStore.objects.size).toBe(1);
      expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);

      await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
        replayed: true,
      });
      expect(h.detect).toHaveBeenCalledTimes(1);
      expect(h.generateModel).toHaveBeenCalledTimes(1);
      expect(h.events.map((event) => event.eventType)).toEqual([
        'exam_error_suggestions_started',
        'exam_error_suggestions_completed',
      ]);
    }
  });

  it('recovers committed byte-store response loss in the original request', async () => {
    const h = harness();
    h.byteStore.failPutAfterCommitSuffixOnce = ARTIFACT_SUFFIX;

    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
      replayed: false,
    });
    expect(h.byteStore.objects.size).toBe(1);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(2);
  });

  it.each(['exam_error_suggestions_started', 'exam_error_suggestions_completed'] as const)(
    'recovers committed %s response loss and replays without duplicate provider work',
    async (eventType) => {
      const h = harness();
      h.failAppendAfterCommitOnce = eventType;

      await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
        replayed: false,
      });
      await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toMatchObject({
        replayed: true,
      });
      expect(h.detect).toHaveBeenCalledTimes(1);
      expect(h.generateModel).toHaveBeenCalledTimes(1);
      expect(h.events.filter((event) => event.eventType === eventType)).toHaveLength(1);
      expect(h.events).toHaveLength(2);
    },
  );

  it('shares one owner-and-Exam single flight across concurrent requests', async () => {
    const h = harness();
    const results = await Promise.all([
      generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID),
      generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.generateModel).toHaveBeenCalledTimes(1);
    expect(h.events.map((event) => event.eventType)).toEqual([
      'exam_error_suggestions_started',
      'exam_error_suggestions_completed',
    ]);
  });

  it('rejects source drift after reservation without persisting stale output', async () => {
    const h = harness();
    let currentAssessments = structuredClone(ASSESSMENTS);
    sourceMocks.resolveAssessments.mockImplementation(async () => currentAssessments);
    let releaseModel!: () => void;
    let markModelCalled!: () => void;
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    h.generateModel.mockImplementationOnce(async () => {
      markModelCalled();
      await modelGate;
      return modelDrafts();
    });

    const pending = generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    await modelCalled;
    currentAssessments = {
      ...currentAssessments,
      semanticFingerprint: '9'.repeat(64),
    };
    releaseModel();

    await expect(pending).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_SOURCE_CHANGED',
    });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
  });

  it('rejects late finalization when delete wins during the provider call', async () => {
    const h = harness();
    let releaseModel!: () => void;
    let markModelCalled!: () => void;
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    h.generateModel.mockImplementationOnce(async () => {
      markModelCalled();
      await modelGate;
      return modelDrafts();
    });

    const pending = generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    await modelCalled;
    expect(h.lockDepth).toBe(0);
    h.current.state.status = 'deleting';
    releaseModel();

    await expect(pending).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(h.byteStore.objects.size).toBe(0);
    expect(h.events.map((event) => event.eventType)).toEqual(['exam_error_suggestions_started']);
  });
});

describe('Exam error suggestion artifact resolution and authority isolation', () => {
  it('returns only owner-reviewable candidate details and keeps grading/provider internals private', async () => {
    const h = harness();
    const generated = await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);

    await expect(getExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).resolves.toEqual(
      generated.errorSuggestions,
    );
    const publicJson = JSON.stringify(generated.errorSuggestions);
    expect(publicJson).toContain('question-choice-incorrect');
    expect(publicJson).toContain('5 cm');
    expect(publicJson).not.toContain(PROFILE_ID);
    expect(publicJson).not.toMatch(
      /PRIVATE_(?:EXPECTED_ANSWER|OWNER|PROFILE|PROGRESS)_CANARY|sourceAnswerKey|sourceAssessment|semanticFingerprint|generationRef|suggestionArtifactRef|gradingRef|provider|ordinal/u,
    );
    expect(generated.errorSuggestions.candidateStatus).toBe('candidate');
  });

  it('fails GET and POST replay closed for corrupt persisted bytes', async () => {
    const h = harness();
    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    const key = examErrorSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    h.byteStore.objects.set(key, Buffer.from('{corrupt', 'utf8'));

    await expect(getExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT',
    });
    await expect(generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT',
    });
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.generateModel).toHaveBeenCalledTimes(1);
  });

  it('rejects GET before completion, after source drift, and for another owner', async () => {
    const h = harness();
    await expect(getExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTIONS_NOT_READY',
    });
    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);

    await expect(
      getExamErrorSuggestions({ ...h.deps, ownerId: 'anon:foreign-owner' }, EXAM_SESSION_ID),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });

    sourceMocks.resolveReview.mockResolvedValue({
      ...REVIEW,
      decisionSemanticFingerprint: '0'.repeat(64),
    });
    await expect(getExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_SOURCE_CHANGED',
    });
  });

  it('rejects a completed artifact bound to a different confirmed-review artifact version', async () => {
    const h = harness();
    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    const key = examErrorSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    const persisted = parseArtifact(h.byteStore.objects.get(key)!);
    sourceMocks.resolveReview.mockResolvedValue({ ...REVIEW, artifactVersion: 2 });
    privateMocks.buildArtifact.mockReturnValue(persisted);

    await expect(getExamErrorSuggestions(h.deps, EXAM_SESSION_ID)).rejects.toMatchObject({
      code: 'EXAM_ERROR_SUGGESTION_SOURCE_CHANGED',
    });
  });

  it('persists only private event aggregates and never mutates trusted learning authorities', async () => {
    const h = harness();
    const before = {
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    };
    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);

    expect(progressMocks.collectEvidence).not.toHaveBeenCalled();
    expect({
      observation: h.current.state.observationCanary,
      progress: h.current.state.progressCanary,
      studyAttempt: h.current.state.studyAttemptCanary,
      coach: h.current.state.coachCanary,
    }).toEqual(before);
    expect(h.events.every((event) => event.eventType.startsWith('exam_error_suggestions_'))).toBe(
      true,
    );
    expect(JSON.stringify(h.events)).not.toMatch(
      /questionText|rawAnswerText|expectedValue|acceptedAnswers|privateExpectedAnswerCanary|knowledgePointIds|modelExecution|providerId|modelId|observationCanary|progressCanary|studyAttemptCanary|coachCanary/u,
    );
    const source = readFileSync('lib/server/zhongkao/exam-error-suggestions-service.ts', 'utf8');
    expect(source).not.toMatch(
      /from ['"`]\.\/(?:progress-evidence-service|exam-knowledge-mapping-service|coach-|study-attempt)/u,
    );
  });

  it('binds completed event integrity and counts to the persisted artifact bytes', async () => {
    const h = harness();
    await generateExamErrorSuggestions(h.deps, EXAM_SESSION_ID);
    const key = examErrorSuggestionsObjectKey(EXAM_SESSION_ID, 1);
    const stored = h.byteStore.objects.get(key);

    expect(stored).toBeDefined();
    expect(h.events.at(-1)).toMatchObject({
      eventType: 'exam_error_suggestions_completed',
      artifactByteLength: stored?.byteLength,
      artifactSha256: stored ? digest(stored) : undefined,
      eligibleQuestionCount: 2,
      suggestionCount: 3,
      deterministicSuggestionCount: 2,
      modelSuggestionCount: 1,
    });
  });
});

describe('default Exam error suggestion service dependencies', () => {
  it('binds the stage to a fixed provider output-token cap', async () => {
    const abortController = new AbortController();
    const aiCall = vi.fn();
    const getModelExecution = vi.fn();
    const baseDeps = { ownerId: OWNER_ID, marker: 'base-exam-service-deps' };
    defaultDepsMocks.defaultExamServiceDeps.mockResolvedValueOnce(baseDeps);
    aiCallBindingMocks.createExamErrorSuggestionAiCall.mockReturnValueOnce({
      call: aiCall,
      getModelExecution,
    });

    const result = await defaultExamErrorSuggestionsServiceDeps(OWNER_ID, abortController.signal);

    expect(defaultDepsMocks.defaultExamServiceDeps).toHaveBeenCalledExactlyOnceWith(OWNER_ID);
    expect(aiCallBindingMocks.createExamErrorSuggestionAiCall).toHaveBeenCalledExactlyOnceWith({
      abortSignal: abortController.signal,
      maxOutputTokens: EXAM_ERROR_SUGGESTIONS_MAX_OUTPUT_TOKENS,
    });
    expect(result).toMatchObject(baseDeps);
    expect(result.errorSuggestionAiCall).toBe(aiCall);
    expect(result.getErrorSuggestionModelExecution).toBe(getModelExecution);
    expect(result.abortSignal).toBe(abortController.signal);
  });
});
