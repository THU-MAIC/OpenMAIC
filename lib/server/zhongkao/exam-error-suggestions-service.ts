import { createHash } from 'node:crypto';

import type { AICallFn } from '@openmaic/generation';

import { examErrorSuggestionsObjectKey } from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import {
  EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  EXAM_ERROR_MODEL_POLICY_VERSION,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
  canonicalizeExamErrorSuggestionDrafts,
  parseExamErrorSuggestionQuestionDraft,
  type ExamErrorSuggestionQuestionDraftV1,
  type PublicExamErrorSuggestionsBundleV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamErrorSuggestionsCompletedEvent,
  type ExamErrorSuggestionsPlanFacts,
  type ExamErrorSuggestionsStartedEvent,
} from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';
import type { ExamErrorSuggestionsState } from '@/lib/zhongkao/exam-state';

import {
  detectExamObservableErrorSuggestions,
  ExamErrorObservableDetectorError,
} from './exam-error-observable-detector';
import {
  generateExamErrorSuggestionDrafts,
  ExamErrorSuggestionsGeneratorError,
  type ExamErrorSuggestionModelQuestionInput,
} from './exam-error-suggestions-generator';
import { createExamErrorSuggestionAiCall } from './exam-error-suggestions-ai-call';
import {
  EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
  EXAM_ERROR_SUGGESTION_MODEL_STAGE,
  ExamErrorSuggestionsPrivateError,
  buildExamErrorSuggestionsArtifact,
  parseExamErrorSuggestionsArtifact,
  serializeExamErrorSuggestionsArtifact,
  toPublicExamErrorSuggestionsBundle,
  type ExamErrorDiagnosisCandidatesArtifactV1,
  type ExamErrorSuggestionGeneratorV1,
  type ExamErrorSuggestionModelExecutionV1,
  type ExamErrorSuggestionUsedModelExecutionV1,
} from './exam-error-suggestions-private';
import {
  resolveAuthoritativeExamAnswerKeyFromRuntime,
  resolveExamQuestionAssessmentsFromRuntime,
} from './exam-grading-service';
import type {
  AuthoritativeExamAnswerKeyArtifactV1,
  ExamQuestionAssessmentsArtifactV1,
} from './exam-grading-private';
import { resolveConfirmedExamReviewFactsFromRuntime } from './exam-human-review-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamErrorSuggestionsArtifactRef,
  deriveExamErrorSuggestionsCompletedOperationId,
  deriveExamErrorSuggestionsGenerationRef,
  deriveExamErrorSuggestionsStartedOperationId,
  deriveExamEventId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import { defaultExamServiceDeps, type ExamServiceDeps } from './exam-service';

export type ExamObservableErrorDetector = typeof detectExamObservableErrorSuggestions;
export type ExamErrorSuggestionModelGenerator = typeof generateExamErrorSuggestionDrafts;

export interface ExamErrorSuggestionsServiceDeps extends ExamServiceDeps {
  errorSuggestionAiCall: AICallFn;
  getErrorSuggestionModelExecution: () => ExamErrorSuggestionUsedModelExecutionV1 | undefined;
  detectObservableErrorSuggestions?: ExamObservableErrorDetector;
  generateModelErrorSuggestionDrafts?: ExamErrorSuggestionModelGenerator;
  resolveConfirmedReview?: typeof resolveConfirmedExamReviewFactsFromRuntime;
  resolveAuthoritativeAnswerKey?: typeof resolveAuthoritativeExamAnswerKeyFromRuntime;
  resolveQuestionAssessments?: typeof resolveExamQuestionAssessmentsFromRuntime;
  abortSignal?: AbortSignal;
}

export interface GenerateExamErrorSuggestionsResult {
  examSessionId: string;
  errorSuggestions: PublicExamErrorSuggestionsBundleV1;
  replayed: boolean;
}

interface AuthoritativeSources {
  confirmedReview: ConfirmedExamReviewFactsV1;
  answerKey: AuthoritativeExamAnswerKeyArtifactV1;
  assessments: ExamQuestionAssessmentsArtifactV1;
  confirmedReviewArtifactSha256: string;
  answerKeyArtifactSha256: string;
  assessmentArtifactSha256: string;
  answerKeyArtifactRef: string;
  assessmentArtifactRef: string;
}

interface GenerationContext {
  snapshot: ExamRuntimeSnapshot;
  sources: AuthoritativeSources;
  plan: ExamErrorSuggestionsPlanFacts;
}

interface PreparedArtifact {
  artifact: ExamErrorDiagnosisCandidatesArtifactV1;
  bytes: Buffer;
}

type ReservationResult =
  | { kind: 'resolved'; result: GenerateExamErrorSuggestionsResult }
  | { kind: 'generate'; context: GenerationContext };

const GENERATOR_DESCRIPTOR: ExamErrorSuggestionGeneratorV1 = Object.freeze({
  generatorVersion: EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  detectorVersion: EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  modelPolicyVersion: EXAM_ERROR_MODEL_POLICY_VERSION,
  candidateSchemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
});
const FLIGHTS_SYMBOL = Symbol.for('openmaic.zhongkao.exam-error-suggestions-flights');
const globalFlights = globalThis as typeof globalThis & {
  [FLIGHTS_SYMBOL]?: Map<string, Promise<GenerateExamErrorSuggestionsResult>>;
};
const generationFlights = (globalFlights[FLIGHTS_SYMBOL] ??= new Map());

export const EXAM_ERROR_SUGGESTIONS_MAX_OUTPUT_TOKENS = 16_384;

function now(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function requireGenerationReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.humanReview?.status !== 'confirmed' ||
    !snapshot.state.humanReview.reviewArtifact ||
    snapshot.state.answerKey?.status !== 'confirmed' ||
    !snapshot.state.answerKey.answerKeyArtifact ||
    snapshot.state.grading?.status !== 'completed' ||
    !snapshot.state.grading.assessmentArtifact
  ) {
    throw new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
  }
}

function mapSourceError(error: unknown): ExamError {
  if (!isExamError(error)) return new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  switch (error.code) {
    case 'EXAM_NOT_FOUND':
    case 'EXAM_EVENT_CONFLICT':
    case 'EXAM_SESSION_CONFLICT':
      return error;
    case 'EXAM_REVIEW_NOT_READY':
    case 'EXAM_GRADING_NOT_READY':
      return new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
    case 'EXAM_REVIEW_SOURCE_CHANGED':
    case 'EXAM_REVIEW_ARTIFACT_CORRUPT':
    case 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT':
    case 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT':
    case 'EXAM_GRADING_CONFLICT':
      return new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    default:
      return new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  }
}

async function resolveSources(
  deps: ExamErrorSuggestionsServiceDeps | ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<AuthoritativeSources> {
  requireGenerationReady(snapshot);
  const reviewState = snapshot.state.humanReview!;
  const answerKeyState = snapshot.state.answerKey!;
  const gradingState = snapshot.state.grading!;
  try {
    const confirmedReview = await (
      'resolveConfirmedReview' in deps && deps.resolveConfirmedReview
        ? deps.resolveConfirmedReview
        : resolveConfirmedExamReviewFactsFromRuntime
    )(deps, snapshot);
    const answerKey = await (
      'resolveAuthoritativeAnswerKey' in deps && deps.resolveAuthoritativeAnswerKey
        ? deps.resolveAuthoritativeAnswerKey
        : resolveAuthoritativeExamAnswerKeyFromRuntime
    )(deps, snapshot, confirmedReview);
    const assessments = await (
      'resolveQuestionAssessments' in deps && deps.resolveQuestionAssessments
        ? deps.resolveQuestionAssessments
        : resolveExamQuestionAssessmentsFromRuntime
    )(deps, snapshot, { confirmedReview, answerKey });
    return {
      confirmedReview,
      answerKey,
      assessments,
      confirmedReviewArtifactSha256: reviewState.reviewArtifact!.sha256,
      answerKeyArtifactSha256: answerKeyState.answerKeyArtifact!.sha256,
      assessmentArtifactSha256: gradingState.assessmentArtifact!.sha256,
      answerKeyArtifactRef: answerKeyState.answerKeyArtifactRef,
      assessmentArtifactRef: gradingState.assessmentArtifactRef,
    };
  } catch (error) {
    throw mapSourceError(error);
  }
}

function createPlan(
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
): ExamErrorSuggestionsPlanFacts {
  const planWithoutRefs = {
    generationVersion: EXAM_ERROR_SUGGESTION_GENERATION_VERSION,
    subjectId: snapshot.state.subjectId,
    ...GENERATOR_DESCRIPTOR,
    reviewVersion: sources.confirmedReview.reviewVersion,
    reviewArtifactRef: sources.confirmedReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: sources.confirmedReviewArtifactSha256,
    sourceReviewSemanticFingerprint: sources.confirmedReview.decisionSemanticFingerprint,
    answerKeyVersion: sources.answerKey.answerKeyVersion,
    answerKeyRef: sources.answerKey.answerKeyRef,
    answerKeyArtifactRef: sources.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: sources.answerKeyArtifactSha256,
    sourceAnswerKeySemanticFingerprint: sources.answerKey.semanticFingerprint,
    assessmentVersion: sources.assessments.assessmentVersion,
    gradingAlgorithmVersion: sources.assessments.gradingAlgorithmVersion,
    gradingRef: sources.assessments.assessmentRef,
    assessmentArtifactRef: sources.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: sources.assessmentArtifactSha256,
    sourceAssessmentSemanticFingerprint: sources.assessments.semanticFingerprint,
  } as const;
  const generationRef = deriveExamErrorSuggestionsGenerationRef({
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...planWithoutRefs,
  });
  return {
    ...planWithoutRefs,
    generationRef,
    suggestionArtifactRef: deriveExamErrorSuggestionsArtifactRef(generationRef),
  };
}

function planFromState(state: ExamErrorSuggestionsState): ExamErrorSuggestionsPlanFacts {
  return {
    generationVersion: state.generationVersion,
    subjectId: state.subjectId,
    generatorVersion: state.generatorVersion,
    detectorVersion: state.detectorVersion,
    modelPolicyVersion: state.modelPolicyVersion,
    candidateSchemaVersion: state.candidateSchemaVersion,
    reviewVersion: state.reviewVersion,
    reviewArtifactRef: state.reviewArtifactRef,
    sourceReviewArtifactFingerprint: state.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: state.sourceReviewSemanticFingerprint,
    answerKeyVersion: state.answerKeyVersion,
    answerKeyRef: state.answerKeyRef,
    answerKeyArtifactRef: state.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: state.sourceAnswerKeyArtifactFingerprint,
    sourceAnswerKeySemanticFingerprint: state.sourceAnswerKeySemanticFingerprint,
    assessmentVersion: state.assessmentVersion,
    gradingAlgorithmVersion: state.gradingAlgorithmVersion,
    gradingRef: state.gradingRef,
    assessmentArtifactRef: state.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: state.sourceAssessmentArtifactFingerprint,
    sourceAssessmentSemanticFingerprint: state.sourceAssessmentSemanticFingerprint,
    generationRef: state.generationRef,
    suggestionArtifactRef: state.suggestionArtifactRef,
  };
}

function planMatches(
  state: ExamErrorSuggestionsState,
  plan: ExamErrorSuggestionsPlanFacts,
): boolean {
  return JSON.stringify(planFromState(state)) === JSON.stringify(plan);
}

function objectKey(snapshot: ExamRuntimeSnapshot): string {
  const suggestions = snapshot.state.errorSuggestions;
  if (!suggestions) throw new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
  return examErrorSuggestionsObjectKey(snapshot.state.examSessionId, suggestions.generationVersion);
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  failureCode: 'EXAM_ERROR_SUGGESTION_FAILED' | 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT',
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw new ExamError(failureCode);
  }
}

function artifactQuestionDrafts(
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
): ExamErrorSuggestionQuestionDraftV1[] {
  return artifact.questions.map((question) =>
    parseExamErrorSuggestionQuestionDraft({
      confirmedQuestionId: question.confirmedQuestionId,
      assessmentOutcome: 'incorrect',
      generationStatus: question.generationStatus,
      suggestions: question.suggestions.map(
        ({ candidateId: _candidateId, ordinal: _ordinal, ...suggestion }) => ({
          ...suggestion,
          evidence: suggestion.evidence.map((evidence) => ({ ...evidence })),
        }),
      ),
    }),
  );
}

function artifactPlanMatches(
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamErrorSuggestionsPlanFacts,
): boolean {
  return (
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.profileId === snapshot.state.profileId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.generationVersion === plan.generationVersion &&
    artifact.generationRef === plan.generationRef &&
    artifact.suggestionArtifactRef === plan.suggestionArtifactRef &&
    artifact.generator.generatorVersion === plan.generatorVersion &&
    artifact.generator.detectorVersion === plan.detectorVersion &&
    artifact.generator.modelPolicyVersion === plan.modelPolicyVersion &&
    artifact.generator.candidateSchemaVersion === plan.candidateSchemaVersion &&
    artifact.sourceReview.reviewVersion === plan.reviewVersion &&
    artifact.sourceReview.reviewArtifactRef === plan.reviewArtifactRef &&
    artifact.sourceReview.reviewArtifactSha256 === plan.sourceReviewArtifactFingerprint &&
    artifact.sourceReview.decisionSemanticFingerprint === plan.sourceReviewSemanticFingerprint &&
    artifact.sourceAnswerKey.answerKeyVersion === plan.answerKeyVersion &&
    artifact.sourceAnswerKey.answerKeyRef === plan.answerKeyRef &&
    artifact.sourceAnswerKey.answerKeyArtifactRef === plan.answerKeyArtifactRef &&
    artifact.sourceAnswerKey.answerKeyArtifactSha256 === plan.sourceAnswerKeyArtifactFingerprint &&
    artifact.sourceAnswerKey.semanticFingerprint === plan.sourceAnswerKeySemanticFingerprint &&
    artifact.sourceAssessment.assessmentVersion === plan.assessmentVersion &&
    artifact.sourceAssessment.gradingAlgorithmVersion === plan.gradingAlgorithmVersion &&
    artifact.sourceAssessment.gradingRef === plan.gradingRef &&
    artifact.sourceAssessment.assessmentArtifactRef === plan.assessmentArtifactRef &&
    artifact.sourceAssessment.assessmentArtifactSha256 ===
      plan.sourceAssessmentArtifactFingerprint &&
    artifact.sourceAssessment.semanticFingerprint === plan.sourceAssessmentSemanticFingerprint
  );
}

function buildBoundArtifact(
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
  plan: ExamErrorSuggestionsPlanFacts,
  questionDrafts: readonly ExamErrorSuggestionQuestionDraftV1[],
  modelExecution: ExamErrorSuggestionModelExecutionV1,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  return buildExamErrorSuggestionsArtifact({
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    subjectId: snapshot.state.subjectId,
    confirmedReview: sources.confirmedReview,
    confirmedReviewArtifactSha256: sources.confirmedReviewArtifactSha256,
    answerKey: sources.answerKey,
    answerKeyArtifactRef: sources.answerKeyArtifactRef,
    answerKeyArtifactSha256: sources.answerKeyArtifactSha256,
    assessments: sources.assessments,
    assessmentArtifactRef: sources.assessmentArtifactRef,
    assessmentArtifactSha256: sources.assessmentArtifactSha256,
    generator: GENERATOR_DESCRIPTOR,
    modelExecution,
    questionDrafts,
    generationRef: plan.generationRef,
    suggestionArtifactRef: plan.suggestionArtifactRef,
  });
}

function parseBoundArtifact(
  bytes: Buffer,
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
): ExamErrorDiagnosisCandidatesArtifactV1 {
  const state = snapshot.state.errorSuggestions;
  if (!state) throw new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
  const plan = planFromState(state);
  let artifact: ExamErrorDiagnosisCandidatesArtifactV1;
  let canonicalBytes: Buffer;
  try {
    artifact = parseExamErrorSuggestionsArtifact(bytes);
    canonicalBytes = serializeExamErrorSuggestionsArtifact(artifact);
  } catch {
    throw new ExamError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  if (!bytes.equals(canonicalBytes) || !artifactPlanMatches(artifact, snapshot, plan)) {
    throw new ExamError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  if (artifact.sourceReview.reviewArtifactVersion !== sources.confirmedReview.artifactVersion) {
    throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
  }
  let expectedBytes: Buffer;
  try {
    expectedBytes = serializeExamErrorSuggestionsArtifact(
      buildBoundArtifact(
        snapshot,
        sources,
        plan,
        artifactQuestionDrafts(artifact),
        artifact.modelExecution,
      ),
    );
  } catch {
    throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
  }
  if (!canonicalBytes.equals(expectedBytes)) {
    throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
  }
  const fact = state.suggestionArtifact;
  if (
    state.status === 'completed' &&
    (!fact ||
      fact.byteLength !== bytes.byteLength ||
      fact.sha256 !== sha256(bytes) ||
      fact.eligibleQuestionCount !== artifact.eligibleQuestionCount ||
      fact.candidateQuestionCount !== artifact.candidateQuestionCount ||
      fact.noSuggestionQuestionCount !== artifact.noSuggestionQuestionCount ||
      fact.inputTooLargeQuestionCount !== artifact.inputTooLargeQuestionCount ||
      fact.suggestionCount !== artifact.suggestionCount ||
      fact.deterministicSuggestionCount !== artifact.deterministicSuggestionCount ||
      fact.modelSuggestionCount !== artifact.modelSuggestionCount)
  ) {
    throw new ExamError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return artifact;
}

async function resolveCompletedFromRuntime(
  deps: ExamErrorSuggestionsServiceDeps | ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
): Promise<ExamErrorDiagnosisCandidatesArtifactV1> {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.errorSuggestions?.status !== 'completed' ||
    !snapshot.state.errorSuggestions.suggestionArtifact
  ) {
    throw new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
  }
  const bytes = await readOptionalObject(
    deps,
    objectKey(snapshot),
    'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT',
  );
  if (!bytes) throw new ExamError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
  return parseBoundArtifact(bytes, snapshot, sources);
}

function startedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamErrorSuggestionsPlanFacts,
): ExamErrorSuggestionsStartedEvent {
  const operationId = deriveExamErrorSuggestionsStartedOperationId(
    snapshot.state.examSessionId,
    plan.generationVersion,
  );
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_error_suggestions_started',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_error_suggestions_started',
      schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      ...plan,
    }),
    ...plan,
  };
}

function completedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  bytes: Buffer,
): ExamErrorSuggestionsCompletedEvent {
  const state = snapshot.state.errorSuggestions;
  if (!state) throw new ExamError('EXAM_ERROR_SUGGESTIONS_NOT_READY');
  const plan = planFromState(state);
  const operationId = deriveExamErrorSuggestionsCompletedOperationId(
    snapshot.state.examSessionId,
    plan.generationVersion,
  );
  const artifactFacts = {
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    eligibleQuestionCount: artifact.eligibleQuestionCount,
    candidateQuestionCount: artifact.candidateQuestionCount,
    noSuggestionQuestionCount: artifact.noSuggestionQuestionCount,
    inputTooLargeQuestionCount: artifact.inputTooLargeQuestionCount,
    suggestionCount: artifact.suggestionCount,
    deterministicSuggestionCount: artifact.deterministicSuggestionCount,
    modelSuggestionCount: artifact.modelSuggestionCount,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_error_suggestions_completed',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_error_suggestions_completed',
      schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      ...plan,
      ...artifactFacts,
    }),
    ...plan,
    ...artifactFacts,
  };
}

async function appendStarted(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamErrorSuggestionsPlanFacts,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event: startedEvent(deps, snapshot, plan),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    const recovered = await loadExamRuntime(deps, snapshot.state.examSessionId).catch(
      () => undefined,
    );
    if (recovered?.state.errorSuggestions && planMatches(recovered.state.errorSuggestions, plan)) {
      return recovered;
    }
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  }
}

function completionMatches(
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  bytes: Buffer,
): boolean {
  const fact = snapshot.state.errorSuggestions?.suggestionArtifact;
  return Boolean(
    snapshot.state.errorSuggestions?.status === 'completed' &&
    fact &&
    fact.byteLength === bytes.byteLength &&
    fact.sha256 === sha256(bytes) &&
    fact.eligibleQuestionCount === artifact.eligibleQuestionCount &&
    fact.candidateQuestionCount === artifact.candidateQuestionCount &&
    fact.noSuggestionQuestionCount === artifact.noSuggestionQuestionCount &&
    fact.inputTooLargeQuestionCount === artifact.inputTooLargeQuestionCount &&
    fact.suggestionCount === artifact.suggestionCount &&
    fact.deterministicSuggestionCount === artifact.deterministicSuggestionCount &&
    fact.modelSuggestionCount === artifact.modelSuggestionCount,
  );
}

async function appendCompleted(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  bytes: Buffer,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event: completedEvent(deps, snapshot, artifact, bytes),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    const recovered = await loadExamRuntime(deps, snapshot.state.examSessionId).catch(
      () => undefined,
    );
    if (
      recovered?.state.errorSuggestions &&
      snapshot.state.errorSuggestions &&
      planMatches(
        recovered.state.errorSuggestions,
        planFromState(snapshot.state.errorSuggestions),
      ) &&
      completionMatches(recovered, artifact, bytes)
    ) {
      return recovered;
    }
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  }
}

async function recoverArtifactIfPresent(
  deps: ExamErrorSuggestionsServiceDeps | ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
): Promise<
  { snapshot: ExamRuntimeSnapshot; artifact: ExamErrorDiagnosisCandidatesArtifactV1 } | undefined
> {
  const bytes = await readOptionalObject(deps, objectKey(snapshot), 'EXAM_ERROR_SUGGESTION_FAILED');
  if (!bytes) return undefined;
  const artifact = parseBoundArtifact(bytes, snapshot, sources);
  const completed = await appendCompleted(deps, snapshot, artifact, bytes);
  return {
    snapshot: completed,
    artifact: await resolveCompletedFromRuntime(deps, completed, sources),
  };
}

function publicResult(
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamErrorDiagnosisCandidatesArtifactV1,
  confirmedReview: ConfirmedExamReviewFactsV1,
  replayed: boolean,
): GenerateExamErrorSuggestionsResult {
  return {
    examSessionId: snapshot.state.examSessionId,
    errorSuggestions: toPublicExamErrorSuggestionsBundle(artifact, confirmedReview),
    replayed,
  };
}

async function reserveGeneration(
  deps: ExamErrorSuggestionsServiceDeps,
  examSessionId: string,
): Promise<ReservationResult> {
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireGenerationReady(snapshot);
    const sources = await resolveSources(deps, snapshot);
    if (snapshot.state.errorSuggestions?.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, sources);
      return {
        kind: 'resolved',
        result: publicResult(snapshot, artifact, sources.confirmedReview, true),
      };
    }
    const plan = createPlan(snapshot, sources);
    if (!snapshot.state.errorSuggestions) snapshot = await appendStarted(deps, snapshot, plan);
    const state = snapshot.state.errorSuggestions;
    if (!state || !planMatches(state, plan)) {
      throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    }
    if (state.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, sources);
      return {
        kind: 'resolved',
        result: publicResult(snapshot, artifact, sources.confirmedReview, true),
      };
    }
    const recovered = await recoverArtifactIfPresent(deps, snapshot, sources);
    if (recovered) {
      return {
        kind: 'resolved',
        result: publicResult(recovered.snapshot, recovered.artifact, sources.confirmedReview, true),
      };
    }
    return { kind: 'generate', context: { snapshot, sources, plan } };
  });
}

function mapGenerationError(error: unknown): ExamError {
  if (isExamError(error)) return error;
  if (error instanceof ExamErrorObservableDetectorError) {
    return new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
  }
  if (error instanceof ExamErrorSuggestionsGeneratorError) {
    return new ExamError(
      error.reason === 'provider_unavailable'
        ? 'EXAM_ERROR_SUGGESTION_PROVIDER_UNAVAILABLE'
        : 'EXAM_ERROR_SUGGESTION_INVALID',
    );
  }
  if (error instanceof ExamErrorSuggestionsPrivateError) {
    if (error.code === 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT') {
      return new ExamError('EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT');
    }
    if (error.code === 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID') {
      return new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    }
    return new ExamError('EXAM_ERROR_SUGGESTION_INVALID');
  }
  return new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
}

function modelInputs(
  context: GenerationContext,
  deterministic: readonly ExamErrorSuggestionQuestionDraftV1[],
): ExamErrorSuggestionModelQuestionInput[] {
  const questions = new Map(
    context.sources.confirmedReview.confirmedQuestions.map((question) => [
      question.confirmedQuestionId,
      question,
    ]),
  );
  const responses = new Map(
    context.sources.confirmedReview.confirmedResponses.map((response) => [
      response.confirmedQuestionId,
      response,
    ]),
  );
  const inputs: ExamErrorSuggestionModelQuestionInput[] = [];
  for (const draft of deterministic) {
    const formatFact = draft.suggestions
      .flatMap((suggestion) => suggestion.evidence)
      .find(
        (evidence) =>
          evidence.evidenceType === 'format_observation' && evidence.gradingType === 'numeric',
      );
    if (!formatFact || formatFact.evidenceType !== 'format_observation') continue;
    const question = questions.get(draft.confirmedQuestionId);
    const response = responses.get(draft.confirmedQuestionId);
    if (
      !question ||
      response?.answerStatus !== 'text' ||
      typeof response.rawAnswerText !== 'string'
    ) {
      throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    }
    inputs.push({
      subjectId: context.snapshot.state.subjectId,
      confirmedQuestionId: draft.confirmedQuestionId,
      questionText: question.questionText,
      ...(question.parentContext
        ? { parentContext: { questionText: question.parentContext.questionText } }
        : {}),
      responseText: response.rawAnswerText,
      gradingType: 'numeric',
      mismatchFact: {
        evidenceType: 'format_observation',
        gradingType: 'numeric',
        parseStatus: 'invalid',
      },
    });
  }
  return inputs;
}

function mergeDrafts(
  deterministic: readonly ExamErrorSuggestionQuestionDraftV1[],
  model: readonly ExamErrorSuggestionQuestionDraftV1[],
): ExamErrorSuggestionQuestionDraftV1[] {
  const modelById = new Map(model.map((draft) => [draft.confirmedQuestionId, draft]));
  if (modelById.size !== model.length) throw new ExamError('EXAM_ERROR_SUGGESTION_INVALID');
  const merged = deterministic.map((draft) => {
    const modelDraft = modelById.get(draft.confirmedQuestionId);
    if (modelDraft) modelById.delete(draft.confirmedQuestionId);
    const suggestions = canonicalizeExamErrorSuggestionDrafts([
      ...draft.suggestions,
      ...(modelDraft?.suggestions ?? []),
    ]);
    return parseExamErrorSuggestionQuestionDraft({
      confirmedQuestionId: draft.confirmedQuestionId,
      assessmentOutcome: 'incorrect',
      generationStatus:
        suggestions.length > 0
          ? 'generated'
          : modelDraft?.generationStatus === 'input_too_large'
            ? 'input_too_large'
            : 'no_suggestion',
      suggestions,
    });
  });
  if (modelById.size !== 0) throw new ExamError('EXAM_ERROR_SUGGESTION_INVALID');
  return merged;
}

async function prepareArtifact(
  deps: ExamErrorSuggestionsServiceDeps,
  context: GenerationContext,
): Promise<PreparedArtifact> {
  try {
    const deterministic = (
      deps.detectObservableErrorSuggestions ?? detectExamObservableErrorSuggestions
    )({
      confirmedReview: context.sources.confirmedReview,
      answerKey: context.sources.answerKey,
      assessments: context.sources.assessments,
    });
    const inputs = modelInputs(context, deterministic);
    const model =
      inputs.length === 0
        ? []
        : await (deps.generateModelErrorSuggestionDrafts ?? generateExamErrorSuggestionDrafts)(
            deps.errorSuggestionAiCall,
            { questions: inputs },
            deps.abortSignal,
          );
    const modelExecution: ExamErrorSuggestionModelExecutionV1 =
      deps.getErrorSuggestionModelExecution() ?? {
        status: 'not_used',
        stage: EXAM_ERROR_SUGGESTION_MODEL_STAGE,
      };
    const inputIds = inputs.map((input) => input.confirmedQuestionId).sort();
    const modelIds = model.map((draft) => draft.confirmedQuestionId).sort();
    if (
      model.length !== inputs.length ||
      new Set(modelIds).size !== modelIds.length ||
      JSON.stringify(modelIds) !== JSON.stringify(inputIds)
    ) {
      throw new ExamError('EXAM_ERROR_SUGGESTION_INVALID');
    }
    const artifact = buildBoundArtifact(
      context.snapshot,
      context.sources,
      context.plan,
      mergeDrafts(deterministic, model),
      modelExecution,
    );
    return { artifact, bytes: serializeExamErrorSuggestionsArtifact(artifact) };
  } catch (error) {
    throw mapGenerationError(error);
  }
}

async function putArtifactIfAbsent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources: AuthoritativeSources,
  prepared: PreparedArtifact,
): Promise<PreparedArtifact> {
  const key = objectKey(snapshot);
  const existing = await readOptionalObject(deps, key, 'EXAM_ERROR_SUGGESTION_FAILED');
  if (existing) {
    return { artifact: parseBoundArtifact(existing, snapshot, sources), bytes: existing };
  }
  try {
    await deps.byteStore.put(key, prepared.bytes, 'application/json');
  } catch {
    const recovered = await readOptionalObject(deps, key, 'EXAM_ERROR_SUGGESTION_FAILED').catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  }
  const readBack = await readOptionalObject(deps, key, 'EXAM_ERROR_SUGGESTION_FAILED');
  if (!readBack) throw new ExamError('EXAM_ERROR_SUGGESTION_FAILED');
  return { artifact: parseBoundArtifact(readBack, snapshot, sources), bytes: readBack };
}

async function finalizeGeneration(
  deps: ExamErrorSuggestionsServiceDeps,
  context: GenerationContext,
  prepared: PreparedArtifact,
): Promise<GenerateExamErrorSuggestionsResult> {
  return deps.withExamMutationLock(context.snapshot.state.examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, context.snapshot.state.examSessionId);
    requireGenerationReady(snapshot);
    const sources = await resolveSources(deps, snapshot);
    if (snapshot.state.errorSuggestions?.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, sources);
      return publicResult(snapshot, artifact, sources.confirmedReview, true);
    }
    const state = snapshot.state.errorSuggestions;
    if (!state || !planMatches(state, context.plan)) {
      throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    }
    const currentPlan = createPlan(snapshot, sources);
    if (!planMatches(state, currentPlan)) {
      throw new ExamError('EXAM_ERROR_SUGGESTION_SOURCE_CHANGED');
    }
    const committed = await putArtifactIfAbsent(deps, snapshot, sources, prepared);
    snapshot = await appendCompleted(deps, snapshot, committed.artifact, committed.bytes);
    const artifact = await resolveCompletedFromRuntime(deps, snapshot, sources);
    return publicResult(snapshot, artifact, sources.confirmedReview, false);
  });
}

async function generateWithoutSingleFlight(
  deps: ExamErrorSuggestionsServiceDeps,
  examSessionId: string,
): Promise<GenerateExamErrorSuggestionsResult> {
  const reservation = await reserveGeneration(deps, examSessionId);
  if (reservation.kind === 'resolved') return reservation.result;
  const prepared = await prepareArtifact(deps, reservation.context);
  return finalizeGeneration(deps, reservation.context, prepared);
}

export async function generateExamErrorSuggestions(
  deps: ExamErrorSuggestionsServiceDeps,
  examSessionId: string,
): Promise<GenerateExamErrorSuggestionsResult> {
  const flightKey = `${deps.ownerId}\0${examSessionId}`;
  const existing = generationFlights.get(flightKey);
  if (existing) {
    const result = await existing;
    return { ...result, replayed: true };
  }
  const flight = generateWithoutSingleFlight(deps, examSessionId);
  generationFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (generationFlights.get(flightKey) === flight) generationFlights.delete(flightKey);
  }
}

export async function getExamErrorSuggestions(
  deps: ExamErrorSuggestionsServiceDeps | ExamServiceDeps,
  examSessionId: string,
): Promise<PublicExamErrorSuggestionsBundleV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    const sources = await resolveSources(deps, snapshot);
    const artifact = await resolveCompletedFromRuntime(deps, snapshot, sources);
    return toPublicExamErrorSuggestionsBundle(artifact, sources.confirmedReview);
  });
}

export async function defaultExamErrorSuggestionsServiceDeps(
  ownerId: string,
  abortSignal?: AbortSignal,
): Promise<ExamErrorSuggestionsServiceDeps> {
  const model = createExamErrorSuggestionAiCall({
    abortSignal,
    maxOutputTokens: EXAM_ERROR_SUGGESTIONS_MAX_OUTPUT_TOKENS,
  });
  return {
    ...(await defaultExamServiceDeps(ownerId)),
    errorSuggestionAiCall: model.call,
    getErrorSuggestionModelExecution: model.getModelExecution,
    ...(abortSignal ? { abortSignal } : {}),
  };
}
