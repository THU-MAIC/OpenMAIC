import { createHash } from 'node:crypto';

import { examErrorReviewObjectKey } from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type { PublicExamErrorReviewSummary } from '@/lib/zhongkao/exam';
import {
  EXAM_ERROR_REVIEW_SCHEMA_VERSION,
  EXAM_ERROR_REVIEW_VERSION,
  createExamErrorReviewDecisionSemanticFingerprint,
  parseExamErrorReviewRequest,
  type ConfirmedExamErrorPatternObservationV1,
  type ExamErrorReviewDecision,
  type ExamErrorReviewRequestV1,
} from '@/lib/zhongkao/exam-error-review';
import type {
  PublicExamErrorSuggestionCandidateV1,
  PublicExamErrorSuggestionQuestionV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamErrorReviewCompletedEvent,
  type ExamErrorReviewPlanFacts,
  type ExamErrorReviewStartedEvent,
} from '@/lib/zhongkao/exam-event';
import { toPublicExamSession, type ExamErrorReviewState } from '@/lib/zhongkao/exam-state';

import {
  ExamErrorReviewPrivateError,
  assertExamErrorReviewCoverage,
  buildConfirmedExamErrorPatternReviewArtifact,
  parseConfirmedExamErrorPatternReviewArtifact,
  serializeConfirmedExamErrorPatternReviewArtifact,
  type ConfirmedExamErrorPatternReviewArtifactV1,
} from './exam-error-review-private';
import { resolveExamErrorSuggestionsFromRuntime } from './exam-error-suggestions-service';
import {
  toPublicExamErrorSuggestionsBundle,
  type ExamErrorDiagnosisCandidatesArtifactV1,
} from './exam-error-suggestions-private';
import { resolveConfirmedExamReviewFactsFromRuntime } from './exam-human-review-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamErrorReviewArtifactRef,
  deriveExamErrorReviewCompletedOperationId,
  deriveExamErrorReviewRef,
  deriveExamErrorReviewStartedOperationId,
  deriveExamEventId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import { defaultExamServiceDeps, type ExamServiceDeps } from './exam-service';

export interface PublicExamErrorReviewCandidateV1 extends PublicExamErrorSuggestionCandidateV1 {
  decision?: ExamErrorReviewDecision;
}

export interface PublicExamErrorReviewQuestionV1 extends Omit<
  PublicExamErrorSuggestionQuestionV1,
  'suggestions'
> {
  suggestions: PublicExamErrorReviewCandidateV1[];
  hasConfirmedPattern?: boolean;
}

export interface PublicExamErrorReviewBundleV1 {
  schemaVersion: typeof EXAM_ERROR_REVIEW_SCHEMA_VERSION;
  examSessionId: string;
  subjectId: string;
  status: PublicExamErrorReviewSummary['status'];
  questions: PublicExamErrorReviewQuestionV1[];
  confirmedPatternObservations?: ConfirmedExamErrorPatternObservationV1[];
}

export interface ConfirmExamErrorReviewResult {
  examSessionId: string;
  errorReview: PublicExamErrorReviewSummary;
  replayed: boolean;
}

type ErrorReviewEvent = ExamErrorReviewStartedEvent | ExamErrorReviewCompletedEvent;

function now(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function requireErrorReviewReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.errorSuggestions?.status !== 'completed' ||
    !snapshot.state.errorSuggestions.suggestionArtifact
  ) {
    throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  }
}

function parseRequest(input: unknown): ExamErrorReviewRequestV1 {
  try {
    return parseExamErrorReviewRequest(input);
  } catch {
    throw new ExamError('EXAM_ERROR_REVIEW_INPUT_INVALID');
  }
}

function mapCandidateSourceError(error: unknown): ExamError {
  if (!isExamError(error)) return new ExamError('EXAM_ERROR_REVIEW_FAILED');
  switch (error.code) {
    case 'EXAM_NOT_FOUND':
    case 'EXAM_EVENT_CONFLICT':
    case 'EXAM_SESSION_CONFLICT':
      return error;
    case 'EXAM_ERROR_SUGGESTIONS_NOT_READY':
      return new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
    case 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT':
    case 'EXAM_ERROR_SUGGESTION_SOURCE_CHANGED':
    case 'EXAM_REVIEW_SOURCE_CHANGED':
    case 'EXAM_REVIEW_ARTIFACT_CORRUPT':
    case 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT':
    case 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_ERROR_REVIEW_SOURCE_CHANGED');
    default:
      return new ExamError('EXAM_ERROR_REVIEW_FAILED');
  }
}

async function resolveSourceCandidates(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ExamErrorDiagnosisCandidatesArtifactV1> {
  requireErrorReviewReady(snapshot);
  try {
    return await resolveExamErrorSuggestionsFromRuntime(deps, snapshot);
  } catch (error) {
    throw mapCandidateSourceError(error);
  }
}

function planFromState(state: ExamErrorReviewState): ExamErrorReviewPlanFacts {
  return {
    errorReviewVersion: state.errorReviewVersion,
    sourceSuggestionGenerationVersion: state.sourceSuggestionGenerationVersion,
    sourceSuggestionGenerationRef: state.sourceSuggestionGenerationRef,
    sourceSuggestionArtifactRef: state.sourceSuggestionArtifactRef,
    sourceSuggestionArtifactFingerprint: state.sourceSuggestionArtifactFingerprint,
    sourceSuggestionSemanticFingerprint: state.sourceSuggestionSemanticFingerprint,
    expectedQuestionCount: state.expectedQuestionCount,
    expectedCandidateCount: state.expectedCandidateCount,
    decisionSemanticFingerprint: state.decisionSemanticFingerprint,
    errorReviewRef: state.errorReviewRef,
    errorReviewArtifactRef: state.errorReviewArtifactRef,
  };
}

function sourcePlanMatches(state: ExamErrorReviewState, plan: ExamErrorReviewPlanFacts): boolean {
  return (
    state.errorReviewVersion === plan.errorReviewVersion &&
    state.sourceSuggestionGenerationVersion === plan.sourceSuggestionGenerationVersion &&
    state.sourceSuggestionGenerationRef === plan.sourceSuggestionGenerationRef &&
    state.sourceSuggestionArtifactRef === plan.sourceSuggestionArtifactRef &&
    state.sourceSuggestionArtifactFingerprint === plan.sourceSuggestionArtifactFingerprint &&
    state.sourceSuggestionSemanticFingerprint === plan.sourceSuggestionSemanticFingerprint &&
    state.expectedQuestionCount === plan.expectedQuestionCount &&
    state.expectedCandidateCount === plan.expectedCandidateCount &&
    state.errorReviewRef === plan.errorReviewRef &&
    state.errorReviewArtifactRef === plan.errorReviewArtifactRef
  );
}

function assertPersistedPlan(
  state: ExamErrorReviewState | undefined,
  plan: ExamErrorReviewPlanFacts,
): void {
  if (!state) return;
  if (!sourcePlanMatches(state, plan)) throw new ExamError('EXAM_ERROR_REVIEW_SOURCE_CHANGED');
  if (state.decisionSemanticFingerprint !== plan.decisionSemanticFingerprint) {
    throw new ExamError('EXAM_ERROR_REVIEW_CONFLICT');
  }
}

function createPlan(
  snapshot: ExamRuntimeSnapshot,
  candidates: ExamErrorDiagnosisCandidatesArtifactV1,
  request: ExamErrorReviewRequestV1,
): ExamErrorReviewPlanFacts {
  const suggestionFact = snapshot.state.errorSuggestions?.suggestionArtifact;
  if (!suggestionFact) throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  const factsWithoutDecision = {
    errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
    sourceSuggestionGenerationVersion: candidates.generationVersion,
    sourceSuggestionGenerationRef: candidates.generationRef,
    sourceSuggestionArtifactRef: candidates.suggestionArtifactRef,
    sourceSuggestionArtifactFingerprint: suggestionFact.sha256,
    sourceSuggestionSemanticFingerprint: candidates.semanticFingerprint,
    expectedQuestionCount: candidates.eligibleQuestionCount,
    expectedCandidateCount: candidates.suggestionCount,
  } as const;
  const decisionSemanticFingerprint = createExamErrorReviewDecisionSemanticFingerprint({
    sourceCandidateArtifactRef: candidates.suggestionArtifactRef,
    sourceCandidateArtifactFingerprint: suggestionFact.sha256,
    sourceCandidateSemanticFingerprint: candidates.semanticFingerprint,
    reviewVersion: EXAM_ERROR_REVIEW_VERSION,
    request,
  });
  const errorReviewRef = deriveExamErrorReviewRef({
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...factsWithoutDecision,
  });
  return {
    ...factsWithoutDecision,
    decisionSemanticFingerprint,
    errorReviewRef,
    errorReviewArtifactRef: deriveExamErrorReviewArtifactRef(errorReviewRef),
  };
}

function artifactObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const review = snapshot.state.errorReview;
  if (!review) throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  return examErrorReviewObjectKey(
    snapshot.state.examSessionId,
    review.sourceSuggestionGenerationVersion,
    review.errorReviewVersion,
  );
}

async function readOptionalArtifact(
  deps: ExamServiceDeps,
  key: string,
  code: 'EXAM_ERROR_REVIEW_FAILED' | 'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (missingObject(error)) return undefined;
    throw new ExamError(code);
  }
}

function startedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamErrorReviewPlanFacts,
): ExamErrorReviewStartedEvent {
  const operationId = deriveExamErrorReviewStartedOperationId(
    snapshot.state.examSessionId,
    plan.errorReviewVersion,
  );
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_error_review_started',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_error_review_started',
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
  artifact: ConfirmedExamErrorPatternReviewArtifactV1,
  bytes: Buffer,
): ExamErrorReviewCompletedEvent {
  const review = snapshot.state.errorReview;
  if (!review) throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  const plan = planFromState(review);
  const operationId = deriveExamErrorReviewCompletedOperationId(
    snapshot.state.examSessionId,
    plan.errorReviewVersion,
  );
  const artifactFacts = {
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    reviewedQuestionCount: artifact.reviewedQuestionCount,
    reviewedCandidateCount: artifact.reviewedCandidateCount,
    acceptedCandidateCount: artifact.acceptedCandidateCount,
    rejectedCandidateCount: artifact.rejectedCandidateCount,
    confirmedObservationCount: artifact.confirmedObservationCount,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_error_review_completed',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_error_review_completed',
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

function eventCommitted(
  snapshot: ExamRuntimeSnapshot | undefined,
  event: ErrorReviewEvent,
): snapshot is ExamRuntimeSnapshot {
  const review = snapshot?.state.errorReview;
  if (!review || !sourcePlanMatches(review, event)) return false;
  if (review.decisionSemanticFingerprint !== event.decisionSemanticFingerprint) return false;
  if (event.eventType === 'exam_error_review_started') return true;
  const fact = review.errorReviewArtifact;
  return Boolean(
    review.status === 'confirmed' &&
    fact &&
    fact.byteLength === event.artifactByteLength &&
    fact.sha256 === event.artifactSha256 &&
    fact.reviewedQuestionCount === event.reviewedQuestionCount &&
    fact.reviewedCandidateCount === event.reviewedCandidateCount &&
    fact.acceptedCandidateCount === event.acceptedCandidateCount &&
    fact.rejectedCandidateCount === event.rejectedCandidateCount &&
    fact.confirmedObservationCount === event.confirmedObservationCount,
  );
}

async function appendReviewEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event: ErrorReviewEvent,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event,
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    const recovered = await loadExamRuntime(deps, snapshot.state.examSessionId).catch(
      () => undefined,
    );
    if (eventCommitted(recovered, event)) return recovered;
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_ERROR_REVIEW_FAILED');
  }
}

function buildArtifact(
  snapshot: ExamRuntimeSnapshot,
  candidates: ExamErrorDiagnosisCandidatesArtifactV1,
  request: ExamErrorReviewRequestV1,
): { artifact: ConfirmedExamErrorPatternReviewArtifactV1; bytes: Buffer } {
  const review = snapshot.state.errorReview;
  const suggestionFact = snapshot.state.errorSuggestions?.suggestionArtifact;
  if (!review || !suggestionFact) throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  try {
    const artifact = buildConfirmedExamErrorPatternReviewArtifact({
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      subjectId: snapshot.state.subjectId,
      reviewedAt: review.startedAt,
      sourceCandidates: candidates,
      sourceCandidateArtifactSha256: suggestionFact.sha256,
      request,
      errorReviewRef: review.errorReviewRef,
      errorReviewArtifactRef: review.errorReviewArtifactRef,
    });
    return {
      artifact,
      bytes: serializeConfirmedExamErrorPatternReviewArtifact(artifact),
    };
  } catch (error) {
    if (error instanceof ExamErrorReviewPrivateError) {
      if (error.code === 'EXAM_ERROR_REVIEW_INPUT_INVALID') {
        throw new ExamError('EXAM_ERROR_REVIEW_INPUT_INVALID');
      }
      if (error.code === 'EXAM_ERROR_REVIEW_INCOMPLETE') {
        throw new ExamError('EXAM_ERROR_REVIEW_INCOMPLETE');
      }
      if (error.code === 'EXAM_ERROR_REVIEW_SOURCE_INVALID') {
        throw new ExamError('EXAM_ERROR_REVIEW_SOURCE_CHANGED');
      }
    }
    throw new ExamError('EXAM_ERROR_REVIEW_FAILED');
  }
}

async function putAndVerifyArtifact(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  expected: Buffer,
): Promise<void> {
  const key = artifactObjectKey(snapshot);
  const existing = await readOptionalArtifact(deps, key, 'EXAM_ERROR_REVIEW_FAILED');
  if (existing) {
    if (!existing.equals(expected)) throw new ExamError('EXAM_ERROR_REVIEW_CONFLICT');
    return;
  }
  try {
    await deps.byteStore.put(key, expected, 'application/json');
  } catch {
    const recovered = await readOptionalArtifact(deps, key, 'EXAM_ERROR_REVIEW_FAILED').catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError('EXAM_ERROR_REVIEW_FAILED');
    if (!recovered.equals(expected)) throw new ExamError('EXAM_ERROR_REVIEW_CONFLICT');
  }
  const readBack = await readOptionalArtifact(deps, key, 'EXAM_ERROR_REVIEW_FAILED');
  if (!readBack) throw new ExamError('EXAM_ERROR_REVIEW_FAILED');
  if (!readBack.equals(expected)) throw new ExamError('EXAM_ERROR_REVIEW_CONFLICT');
}

function artifactMatchesRuntime(
  artifact: ConfirmedExamErrorPatternReviewArtifactV1,
  bytes: Buffer,
  snapshot: ExamRuntimeSnapshot,
): boolean {
  const review = snapshot.state.errorReview;
  const fact = review?.errorReviewArtifact;
  return Boolean(
    review &&
    review.status === 'confirmed' &&
    fact &&
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.profileId === snapshot.state.profileId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.reviewedAt === review.startedAt &&
    artifact.errorReviewVersion === review.errorReviewVersion &&
    artifact.errorReviewRef === review.errorReviewRef &&
    artifact.errorReviewArtifactRef === review.errorReviewArtifactRef &&
    artifact.sourceSuggestions.generationVersion === review.sourceSuggestionGenerationVersion &&
    artifact.sourceSuggestions.generationRef === review.sourceSuggestionGenerationRef &&
    artifact.sourceSuggestions.suggestionArtifactRef === review.sourceSuggestionArtifactRef &&
    artifact.sourceSuggestions.suggestionArtifactSha256 ===
      review.sourceSuggestionArtifactFingerprint &&
    artifact.sourceSuggestions.semanticFingerprint === review.sourceSuggestionSemanticFingerprint &&
    artifact.decisionSemanticFingerprint === review.decisionSemanticFingerprint &&
    bytes.byteLength === fact.byteLength &&
    sha256(bytes) === fact.sha256 &&
    artifact.reviewedQuestionCount === fact.reviewedQuestionCount &&
    artifact.reviewedCandidateCount === fact.reviewedCandidateCount &&
    artifact.acceptedCandidateCount === fact.acceptedCandidateCount &&
    artifact.rejectedCandidateCount === fact.rejectedCandidateCount &&
    artifact.confirmedObservationCount === fact.confirmedObservationCount,
  );
}

export async function resolveConfirmedExamErrorPatternReviewFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ConfirmedExamErrorPatternReviewArtifactV1> {
  requireErrorReviewReady(snapshot);
  const review = snapshot.state.errorReview;
  const fact = review?.errorReviewArtifact;
  if (!review || review.status !== 'confirmed' || !fact) {
    throw new ExamError('EXAM_ERROR_REVIEW_NOT_READY');
  }
  const candidates = await resolveSourceCandidates(deps, snapshot);
  const bytes = await readOptionalArtifact(
    deps,
    artifactObjectKey(snapshot),
    'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  let artifact: ConfirmedExamErrorPatternReviewArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseConfirmedExamErrorPatternReviewArtifact(bytes);
    canonicalBytes = serializeConfirmedExamErrorPatternReviewArtifact(artifact);
    expectedBytes = buildArtifact(snapshot, candidates, {
      schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
      questions: artifact.questions,
    }).bytes;
  } catch {
    throw new ExamError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    !artifactMatchesRuntime(artifact, canonicalBytes, snapshot)
  ) {
    throw new ExamError('EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export async function resolveConfirmedExamErrorPatternReview(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ConfirmedExamErrorPatternReviewArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveConfirmedExamErrorPatternReviewFromRuntime(deps, snapshot);
  });
}

export async function resolveConfirmedExamErrorPatternObservations(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ConfirmedExamErrorPatternObservationV1[]> {
  const artifact = await resolveConfirmedExamErrorPatternReview(deps, examSessionId);
  return artifact.confirmedPatternObservations.map((observation) => ({
    ...observation,
    evidence: observation.evidence.map((evidence) => ({ ...evidence })),
  }));
}

async function buildPublicBundle(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  candidates: ExamErrorDiagnosisCandidatesArtifactV1,
  artifact?: ConfirmedExamErrorPatternReviewArtifactV1,
): Promise<PublicExamErrorReviewBundleV1> {
  const confirmedReview = await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
  const candidateBundle = toPublicExamErrorSuggestionsBundle(candidates, confirmedReview);
  const decisionByCandidate = new Map(
    artifact?.questions.flatMap((question) =>
      question.candidateDecisions.map(
        (decision) => [decision.candidateId, decision.decision] as const,
      ),
    ),
  );
  const resultByQuestion = new Map(
    artifact?.questionResults.map((result) => [result.confirmedQuestionId, result] as const),
  );
  return {
    schemaVersion: EXAM_ERROR_REVIEW_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    subjectId: snapshot.state.subjectId,
    status: toPublicExamSession(snapshot.state).errorReview.status,
    ...(artifact
      ? { confirmedPatternObservations: structuredClone(artifact.confirmedPatternObservations) }
      : {}),
    questions: candidateBundle.questions.map((question) => ({
      ...question,
      suggestions: question.suggestions.map((candidate) => ({
        ...candidate,
        ...(decisionByCandidate.has(candidate.candidateId)
          ? { decision: decisionByCandidate.get(candidate.candidateId)! }
          : {}),
        evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
      })),
      ...(resultByQuestion.has(question.confirmedQuestionId)
        ? {
            hasConfirmedPattern: resultByQuestion.get(question.confirmedQuestionId)!
              .hasConfirmedPattern,
          }
        : {}),
    })),
  };
}

export async function getExamErrorReview(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<PublicExamErrorReviewBundleV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    const candidates = await resolveSourceCandidates(deps, snapshot);
    const artifact =
      snapshot.state.errorReview?.status === 'confirmed'
        ? await resolveConfirmedExamErrorPatternReviewFromRuntime(deps, snapshot)
        : undefined;
    return buildPublicBundle(deps, snapshot, candidates, artifact);
  });
}

export async function confirmExamErrorReview(
  deps: ExamServiceDeps,
  examSessionId: string,
  input: unknown,
): Promise<ConfirmExamErrorReviewResult> {
  const request = parseRequest(input);
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireErrorReviewReady(snapshot);
    const replayed = snapshot.state.errorReview?.status === 'confirmed';
    const candidates = await resolveSourceCandidates(deps, snapshot);
    const plan = createPlan(snapshot, candidates, request);
    assertPersistedPlan(snapshot.state.errorReview, plan);
    try {
      assertExamErrorReviewCoverage(candidates, request);
    } catch {
      throw new ExamError('EXAM_ERROR_REVIEW_INCOMPLETE');
    }

    if (!snapshot.state.errorReview) {
      snapshot = await appendReviewEvent(deps, snapshot, startedEvent(deps, snapshot, plan));
    }
    assertPersistedPlan(snapshot.state.errorReview, plan);
    const prepared = buildArtifact(snapshot, candidates, request);

    if (snapshot.state.errorReview?.status !== 'confirmed') {
      await putAndVerifyArtifact(deps, snapshot, prepared.bytes);
      snapshot = await appendReviewEvent(
        deps,
        snapshot,
        completedEvent(deps, snapshot, prepared.artifact, prepared.bytes),
      );
    }
    const resolved = await resolveConfirmedExamErrorPatternReviewFromRuntime(deps, snapshot);
    if (!serializeConfirmedExamErrorPatternReviewArtifact(resolved).equals(prepared.bytes)) {
      throw new ExamError('EXAM_ERROR_REVIEW_CONFLICT');
    }
    return {
      examSessionId: snapshot.state.examSessionId,
      errorReview: toPublicExamSession(snapshot.state).errorReview,
      replayed,
    };
  });
}

export async function defaultExamErrorReviewServiceDeps(ownerId: string): Promise<ExamServiceDeps> {
  return defaultExamServiceDeps(ownerId);
}
